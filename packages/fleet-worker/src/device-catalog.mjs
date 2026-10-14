const DEVICE_PREFIX = "d:";
const USER_DEVICE_PREFIX = "udi:";
// v1 could publish ready before a separately-written owner index was durable.
// Ignore that legacy commit marker once, rebuild from catalog rows, and only
// trust the v2 marker written by the atomic index implementation below.
const USER_DEVICE_READY_PREFIX = "udi-ready-v2:";
const USER_DEVICE_ALIAS_PREFIX = "uda:";
const USER_DEVICE_ALIAS_READY_PREFIX = "uda-ready-v1:";
const STORAGE_BATCH_SIZE = 128;

export const DEVICE_ALIAS_MAX_CHARS = 64;

/**
 * Keep the display value readable, but compare aliases with one stable key.
 * Control/format/surrogate code points are rejected so an alias cannot hide
 * terminal controls or visually splice itself into the surrounding UI.
 */
export function normalizeDeviceAlias(value) {
  const alias = String(value ?? "").trim().normalize("NFC");
  if (!alias) return { alias: "", key: "" };
  if (
    Array.from(alias).length > DEVICE_ALIAS_MAX_CHARS ||
    new TextEncoder().encode(alias).byteLength > 256 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(alias)
  ) {
    return null;
  }
  return { alias, key: alias.normalize("NFKC").toLocaleLowerCase("en-US") };
}

export function userDeviceAliasIndexKey(userId, aliasKey) {
  return `${USER_DEVICE_ALIAS_PREFIX}${userId}:${encodeURIComponent(aliasKey)}`;
}

export function deviceCatalogKey(deviceId) {
  return `${DEVICE_PREFIX}${deviceId}`;
}

export function userDeviceIndexPrefix(userId) {
  return `${USER_DEVICE_PREFIX}${userId}:`;
}

export function userDeviceIndexKey(userId, deviceId) {
  return `${userDeviceIndexPrefix(userId)}${deviceId}`;
}

export function userDeviceIndexReadyKey(userId) {
  return `${USER_DEVICE_READY_PREFIX}${userId}`;
}

export async function markUserDeviceIndexReady(storage, userId) {
  if (!userId) return;
  await storage.put(userDeviceIndexReadyKey(userId), true);
}

/**
 * Persist the catalog row and its account index as one storage operation when
 * the index is missing. Existing rows keep the cheap single-key presence
 * update, while a partial legacy write repairs itself on the next upsert.
 */
export async function storeCatalogDevice(storage, next) {
  if (!next?.id) return;
  const catalogKey = deviceCatalogKey(next.id);
  const userId = next?.userId;
  if (!userId) {
    await storage.put(catalogKey, next);
    return;
  }
  const indexKey = userDeviceIndexKey(userId, next.id);
  const indexed = await storage.get(indexKey);
  const alias = normalizeDeviceAlias(next.alias);
  // New rows must maintain alias indexes even after this account's migration.
  // Keep presence-only writes cheap when there is no alias or it is indexed.
  const aliasIndexKey = alias?.key ? userDeviceAliasIndexKey(userId, alias.key) : null;
  const aliasOwner = aliasIndexKey ? await storage.get(aliasIndexKey) : null;
  let aliasIndexed = !aliasIndexKey || aliasOwner === next.id;
  if (!aliasIndexed && typeof aliasOwner === "string") {
    const other = await storage.get(deviceCatalogKey(aliasOwner));
    // A heartbeat must not steal a valid legacy duplicate's chosen alias.
    aliasIndexed = other?.userId === userId && normalizeDeviceAlias(other.alias)?.key === alias.key;
  }
  if (indexed === catalogKey && aliasIndexed) {
    await storage.put(catalogKey, next);
    return;
  }
  await storage.put({
    [catalogKey]: next,
    [indexKey]: catalogKey,
    ...(aliasIndexKey && !aliasIndexed ? { [aliasIndexKey]: next.id } : {}),
  });
}

async function listByPrefix(storage, prefix) {
  const rows = new Map();
  let startAfter;
  for (;;) {
    const page = await storage.list({
      prefix,
      limit: STORAGE_BATCH_SIZE,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const entry of page) rows.set(...entry);
    if (page.size < STORAGE_BATCH_SIZE) return rows;
    const last = [...page.keys()].at(-1);
    if (!last || last === startAfter) return rows;
    startAfter = last;
  }
}

async function putEntries(storage, entries) {
  for (let i = 0; i < entries.length; i += STORAGE_BATCH_SIZE) {
    await storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH_SIZE)));
  }
}

async function getEntries(storage, keys) {
  const rows = new Map();
  for (let i = 0; i < keys.length; i += STORAGE_BATCH_SIZE) {
    const page = await storage.get(keys.slice(i, i + STORAGE_BATCH_SIZE));
    for (const entry of page) rows.set(...entry);
  }
  return rows;
}

async function backfillUserDeviceIndex(storage, userId) {
  const all = await listByPrefix(storage, DEVICE_PREFIX);
  const rows = [...all.values()].filter((row) => row?.id && row.userId === userId);
  const index = [];
  for (const row of rows) index.push([userDeviceIndexKey(userId, row.id), deviceCatalogKey(row.id)]);
  await putEntries(storage, index);
  // The ready marker is the commit record. Never publish it before every
  // paged index write has succeeded, or a retry would trust a partial index.
  await storage.put(userDeviceIndexReadyKey(userId), true);
  return rows;
}

export async function listCatalogDevices(storage, userId) {
  if (!userId) return [];

  const ready = await storage.get(userDeviceIndexReadyKey(userId));
  if (!ready) return backfillUserDeviceIndex(storage, userId);

  const index = await listByPrefix(storage, userDeviceIndexPrefix(userId));
  const catalogKeys = [...index.values()].filter(
    (key) => typeof key === "string" && key.startsWith(DEVICE_PREFIX),
  );
  if (catalogKeys.length === 0) return [];
  const rows = await getEntries(storage, catalogKeys);
  return [...rows.values()].filter((row) => row?.id && row.userId === userId);
}

/** Resolve an account-owned device by immutable id first, then by alias. */
export async function resolveCatalogDevice(storage, userId, reference) {
  return storage.transaction((txn) => resolveCatalogDeviceInTransaction(txn, userId, reference));
}

// Device claim already owns a transaction; never try to infer that boundary
// from whether a transaction-shaped adapter also exposes transaction().
export async function resolveCatalogDeviceInTransaction(storage, userId, reference) {
  const ref = String(reference ?? "").trim();
  if (!userId || !ref) return null;

  const exact = await storage.get(deviceCatalogKey(ref));
  if (exact?.id && exact.userId === userId) return exact;

  const normalized = normalizeDeviceAlias(ref);
  if (!normalized?.key) return null;
  await ensureAliasIndex(storage, userId);
  const indexKey = userDeviceAliasIndexKey(userId, normalized.key);
  const indexedId = await storage.get(indexKey);
  if (typeof indexedId === "string" && indexedId) {
    const indexed = await storage.get(deviceCatalogKey(indexedId));
    const current = normalizeDeviceAlias(indexed?.alias);
    if (indexed?.id && indexed.userId === userId && current?.key === normalized.key) {
      return indexed;
    }
    await storage.delete(indexKey);
  }

  return null;
}

async function ensureAliasIndex(storage, userId) {
  const readyKey = `${USER_DEVICE_ALIAS_READY_PREFIX}${userId}`;
  if (await storage.get(readyKey)) return;
  const rows = await listCatalogDevices(storage, userId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const aliases = new Map();
  for (const row of rows) {
    const alias = normalizeDeviceAlias(row.alias);
    if (!alias?.key) continue;
    const key = userDeviceAliasIndexKey(userId, alias.key);
    // Legacy duplicates retain the catalog's first-match behavior.
    if (!aliases.has(key)) aliases.set(key, row.id);
  }
  const indexed = await getEntries(storage, [...aliases.keys()]);
  for (const [key, id] of indexed) {
    const row = byId.get(id);
    const alias = normalizeDeviceAlias(row?.alias);
    if (alias?.key && userDeviceAliasIndexKey(userId, alias.key) === key) aliases.set(key, id);
  }
  await putEntries(storage, [...aliases]);
  // The caller transaction commits every page and the marker atomically.
  await storage.put(readyKey, true);
}

/** Atomically set/clear one account-local alias without changing device identity. */
export async function setCatalogDeviceAlias(storage, userId, deviceId, value) {
  const id = String(deviceId ?? "").trim();
  const normalized = normalizeDeviceAlias(value);
  if (!userId || !id) return { ok: false, status: 400, error: "device_id required" };
  if (!normalized) return { ok: false, status: 400, error: "invalid alias" };

  return storage.transaction(async (txn) => {
    const devices = await listCatalogDevices(txn, userId);
    const current = devices.find((row) => row.id === id);
    if (!current) return { ok: false, status: 404, error: "not found" };

    if (normalized.key) {
      const collision = devices.find((row) => {
        if (row.id === id) return false;
        const idKey = normalizeDeviceAlias(row.id)?.key;
        const aliasKey = normalizeDeviceAlias(row.alias)?.key;
        return idKey === normalized.key || aliasKey === normalized.key;
      });
      if (collision) return { ok: false, status: 409, error: "alias already in use" };
    }

    const previous = normalizeDeviceAlias(current.alias);
    if (previous?.key && previous.key !== normalized.key) {
      const key = userDeviceAliasIndexKey(userId, previous.key);
      // Preserve another legacy duplicate rather than making it unreachable.
      const replacement = devices.find((row) => row.id !== id && normalizeDeviceAlias(row.alias)?.key === previous.key);
      if (replacement) await txn.put(key, replacement.id);
      else await txn.delete(key);
    }

    const next = { ...current };
    if (normalized.alias) next.alias = normalized.alias;
    else delete next.alias;
    await txn.put(deviceCatalogKey(id), next);
    if (normalized.key) {
      await txn.put(userDeviceAliasIndexKey(userId, normalized.key), id);
    }
    return { ok: true, status: 200, device: next };
  });
}
