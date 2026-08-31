import type { Sql } from "../db";
import {
  DEVICE_ALIAS_MAX_CHARS,
  normalizeDeviceAlias as normalizeCatalogAlias,
} from "../../../packages/fleet-worker/src/device-catalog.mjs";

export const DEVICE_ALIAS_MAX_LENGTH = DEVICE_ALIAS_MAX_CHARS;

export type DeviceAlias = {
  alias: string | null;
  aliasKey: string | null;
};

export type DeviceAliasErrorCode = "INVALID_ALIAS" | "ALIAS_CONFLICT" | "DEVICE_NOT_FOUND";

export class DeviceAliasError extends Error {
  readonly code: DeviceAliasErrorCode;
  readonly status: 400 | 404 | 409;

  constructor(code: DeviceAliasErrorCode, message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "DeviceAliasError";
    this.code = code;
    this.status = status;
  }
}

/**
 * One display value and one comparison key. Empty input clears the alias.
 *
 * The key is intentionally stored instead of relying on database collation:
 * PGLite and production Postgres must make the same uniqueness decision.
 */
export function normalizeDeviceAlias(value: unknown): DeviceAlias {
  const normalized = normalizeCatalogAlias(value);
  if (!normalized) {
    throw new DeviceAliasError(
      "INVALID_ALIAS",
      `Alias must be at most ${DEVICE_ALIAS_MAX_LENGTH} characters and contain no control characters`,
      400,
    );
  }
  if (!normalized.alias) return { alias: null, aliasKey: null };
  return {
    alias: normalized.alias,
    aliasKey: normalized.key,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

/** Persist an alias using a caller-supplied SQL handle so policy is testable. */
export async function writeDeviceAlias(
  sql: Sql,
  userId: string,
  deviceId: string,
  value: unknown,
): Promise<{ ok: true; device_id: string; alias: string | null }> {
  const owned = await sql<{ id: string }>`
    select id from devices where id = ${deviceId} and user_id = ${userId}
  `;
  if (!owned[0]) {
    throw new DeviceAliasError("DEVICE_NOT_FOUND", "Device not found", 404);
  }

  const normalized = normalizeDeviceAlias(value);
  if (normalized.aliasKey) {
    const conflict = await sql<{ id: string }>`
      select id from devices
      where user_id = ${userId}
        and (alias_key = ${normalized.aliasKey} or lower(id) = ${normalized.aliasKey})
        and id <> ${deviceId}
      limit 1
    `;
    if (conflict[0]) {
      throw new DeviceAliasError("ALIAS_CONFLICT", "Alias is already used by another device", 409);
    }
  }

  try {
    const updated = await sql<{ id: string }>`
      update devices
      set alias = ${normalized.alias}, alias_key = ${normalized.aliasKey}
      where id = ${deviceId} and user_id = ${userId}
      returning id
    `;
    if (!updated[0]) {
      throw new DeviceAliasError("DEVICE_NOT_FOUND", "Device not found", 404);
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DeviceAliasError("ALIAS_CONFLICT", "Alias is already used by another device", 409);
    }
    throw error;
  }

  return { ok: true, device_id: deviceId, alias: normalized.alias };
}

/** Resolve an account-owned device by immutable id first, then by alias. */
export async function resolveDeviceReference(
  sql: Sql,
  userId: string,
  value: unknown,
): Promise<string | null> {
  const reference = String(value ?? "").trim();
  if (!reference) return null;

  const exact = await sql<{ id: string }>`
    select id from devices where id = ${reference} and user_id = ${userId}
  `;
  if (exact[0]) return exact[0].id;

  let aliasKey: string | null;
  try {
    aliasKey = normalizeDeviceAlias(reference).aliasKey;
  } catch {
    return null;
  }
  if (!aliasKey) return null;
  const aliased = await sql<{ id: string }>`
    select id from devices where user_id = ${userId} and alias_key = ${aliasKey} limit 1
  `;
  return aliased[0]?.id ?? null;
}

/**
 * A real immutable id always wins. A not-yet-existing id may not reuse another
 * device's alias in the same account, otherwise the alias would silently start
 * targeting the newly connected machine.
 */
export async function deviceIdConflictsWithAlias(
  sql: Sql,
  userId: string,
  value: unknown,
): Promise<boolean> {
  const deviceId = String(value ?? "").trim();
  if (!deviceId) return false;
  const resolved = await resolveDeviceReference(sql, userId, deviceId);
  return resolved != null && resolved !== deviceId;
}
