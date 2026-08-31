import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import {
  DeviceAliasError,
  deviceIdConflictsWithAlias,
  normalizeDeviceAlias,
  resolveDeviceReference,
  writeDeviceAlias,
} from "./device-alias";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

function asSql(pg: PGlite): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query<T>(text, values)).rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await pg.query<T>(text, params)).rows;
  return sql;
}

async function testDatabase() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0002_fleet.sql", "0005_device_permit.sql", "0006_device_identity.sql"]) {
    await pg.exec(readFileSync(join(root, "migrations", name), "utf8"));
  }
  return { pg, sql: asSql(pg) };
}

async function insertDevice(sql: Sql, id: string, userId: string, name = id) {
  await sql`
    insert into devices (id, user_id, slug, name, os, arch, location_tag)
    values (${id}, ${userId}, ${id}, ${name}, ${"linux"}, ${"amd64"}, ${"home"})
  `;
}

test("alias normalization is readable but comparison is compatibility/case insensitive", () => {
  assert.deepEqual(normalizeDeviceAlias("  工作站   甲  "), {
    alias: "工作站   甲",
    aliasKey: "工作站   甲",
  });
  assert.deepEqual(normalizeDeviceAlias(" Ａgent "), {
    alias: "Ａgent",
    aliasKey: "agent",
  });
  assert.deepEqual(normalizeDeviceAlias("  "), { alias: null, aliasKey: null });
  assert.throws(
    () => normalizeDeviceAlias("bad\nname"),
    (error: unknown) => {
      return error instanceof DeviceAliasError && error.code === "INVALID_ALIAS";
    },
  );
  assert.throws(() => normalizeDeviceAlias("hidden\u200djoiner"), DeviceAliasError);
});

test("alias is account-scoped, unique, clearable, and never replaces the device id", async () => {
  const { pg, sql } = await testDatabase();
  try {
    await insertDevice(sql, "device-a", "user-a", "host-a");
    await insertDevice(sql, "device-b", "user-a", "host-b");
    await insertDevice(sql, "device-c", "user-b", "host-c");

    await assert.rejects(
      () => writeDeviceAlias(sql, "user-a", "device-a", "DEVICE-B"),
      (error: unknown) => error instanceof DeviceAliasError && error.code === "ALIAS_CONFLICT",
    );

    assert.deepEqual(await writeDeviceAlias(sql, "user-a", "device-a", " Build Box "), {
      ok: true,
      device_id: "device-a",
      alias: "Build Box",
    });
    assert.deepEqual(await writeDeviceAlias(sql, "user-b", "device-c", "build box"), {
      ok: true,
      device_id: "device-c",
      alias: "build box",
    });
    assert.equal(await resolveDeviceReference(sql, "user-a", "device-a"), "device-a");
    assert.equal(await resolveDeviceReference(sql, "user-a", "BUILD BOX"), "device-a");
    assert.equal(await resolveDeviceReference(sql, "user-b", "Build Box"), "device-c");
    assert.equal(await resolveDeviceReference(sql, "user-b", "device-a"), null);
    await assert.rejects(
      () => writeDeviceAlias(sql, "user-a", "device-b", "BUILD BOX"),
      (error: unknown) => error instanceof DeviceAliasError && error.code === "ALIAS_CONFLICT",
    );

    await sql`update devices set name = ${"host-a-renamed"} where id = ${"device-a"}`;
    const kept = await sql<{ id: string; name: string; alias: string | null }>`
      select id, name, alias from devices where id = ${"device-a"}
    `;
    assert.deepEqual(kept[0], {
      id: "device-a",
      name: "host-a-renamed",
      alias: "Build Box",
    });

    assert.deepEqual(await writeDeviceAlias(sql, "user-a", "device-a", ""), {
      ok: true,
      device_id: "device-a",
      alias: null,
    });
    await writeDeviceAlias(sql, "user-a", "device-b", "build box");
    await assert.rejects(
      () => writeDeviceAlias(sql, "user-b", "device-a", "not-owned"),
      (error: unknown) => error instanceof DeviceAliasError && error.code === "DEVICE_NOT_FOUND",
    );
  } finally {
    await pg.close();
  }
});

test("App Hub keeps a stored version when an old Agent omits agent_ver", () => {
  const source = readFileSync(join(here, "v1.server.ts"), "utf8");
  assert.doesNotMatch(source, /String\(parsed\.body\.agent_ver \?\? ""\)/);
  assert.match(source, /agent_ver = coalesce\(\$\{reportedVer \?\? null\}, agent_ver\)/);
  assert.match(source, /getAgentVer\(r\.id\) \?\? r\.agent_ver\?\.trim\(\) \?\? ""/);
});

test("a future device id cannot take over an account alias", async () => {
  const { pg, sql } = await testDatabase();
  try {
    await insertDevice(sql, "device-a", "user-a");
    await insertDevice(sql, "device-b", "user-a");
    await insertDevice(sql, "device-c", "user-b");
    await writeDeviceAlias(sql, "user-a", "device-a", "Build Box");
    await writeDeviceAlias(sql, "user-b", "device-c", "Remote Box");

    assert.equal(await deviceIdConflictsWithAlias(sql, "user-a", "BUILD BOX"), true);
    assert.equal(await deviceIdConflictsWithAlias(sql, "user-a", "device-a"), false);
    assert.equal(await deviceIdConflictsWithAlias(sql, "user-a", "device-b"), false);
    assert.equal(await deviceIdConflictsWithAlias(sql, "user-a", "device-c"), false);
    assert.equal(await deviceIdConflictsWithAlias(sql, "user-a", "REMOTE BOX"), false);
  } finally {
    await pg.close();
  }
});
