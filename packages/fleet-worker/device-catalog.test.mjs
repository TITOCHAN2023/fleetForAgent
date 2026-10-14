import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_ALIAS_MAX_CHARS,
  deviceCatalogKey,
  listCatalogDevices,
  markUserDeviceIndexReady,
  normalizeDeviceAlias,
  resolveCatalogDevice,
  resolveCatalogDeviceInTransaction,
  setCatalogDeviceAlias,
  storeCatalogDevice,
  userDeviceAliasIndexKey,
  userDeviceIndexKey,
  userDeviceIndexPrefix,
  userDeviceIndexReadyKey,
} from "./src/device-catalog.mjs";

class MemoryStorage {
  constructor(entries = {}) {
    this.rows = new Map(Object.entries(entries));
    this.lists = [];
    this.writes = [];
    this.putCalls = 0;
    this.failPutCall = 0;
  }

  async get(key) {
    if (Array.isArray(key)) {
      if (key.length > 128) throw new Error("Durable Object multi-get limit exceeded");
      return new Map(key.filter((item) => this.rows.has(item)).map((item) => [item, this.rows.get(item)]));
    }
    return this.rows.get(key);
  }

  async put(key, value) {
    this.putCalls += 1;
    if (this.putCalls === this.failPutCall) throw new Error("injected put failure");
    const entries = typeof key === "string" ? { [key]: value } : key;
    if (Object.keys(entries).length > 128) {
      throw new Error("Durable Object multi-put limit exceeded");
    }
    this.writes.push(entries);
    for (const [name, row] of Object.entries(entries)) this.rows.set(name, row);
  }

  async delete(key) {
    this.rows.delete(key);
  }

  async transaction(callback) {
    const previous = this.tail || Promise.resolve();
    const work = previous.then(async () => {
      const snapshot = new Map(this.rows);
      const txn = Object.fromEntries(["get", "put", "delete", "list"].map((name) => [name, this[name].bind(this)]));
      try { return await callback(txn); }
      catch (error) { this.rows = snapshot; throw error; }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async list({ prefix, startAfter, limit = 128 }) {
    this.lists.push(prefix);
    return new Map(
      [...this.rows]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit),
    );
  }
}

test("legacy device catalogs backfill one user index and stop scanning every device", async () => {
  const storage = new MemoryStorage({
    "d:a": { id: "a", userId: "u1", online: true },
    "d:b": { id: "b", userId: "u2", online: true },
    "d:c": { id: "c", userId: "u1", online: false },
  });

  assert.deepEqual((await listCatalogDevices(storage, "u1")).map((row) => row.id), ["a", "c"]);
  assert.deepEqual(storage.lists, ["d:"]);
  assert.equal(storage.rows.get(userDeviceIndexReadyKey("u1")), true);
  assert.equal(storage.rows.get(userDeviceIndexKey("u1", "a")), deviceCatalogKey("a"));
  assert.equal(storage.rows.get(userDeviceIndexKey("u1", "c")), deviceCatalogKey("c"));

  storage.lists.length = 0;
  assert.deepEqual((await listCatalogDevices(storage, "u1")).map((row) => row.id), ["a", "c"]);
  assert.deepEqual(storage.lists, [userDeviceIndexPrefix("u1")]);
});

test("a legacy ready marker cannot hide a catalog row whose old owner write was lost", async () => {
  const storage = new MemoryStorage({
    "udi-ready:u1": true,
    "d:hidden": { id: "hidden", userId: "u1", online: true },
  });

  assert.deepEqual((await listCatalogDevices(storage, "u1")).map((row) => row.id), ["hidden"]);
  assert.deepEqual(storage.lists, ["d:"]);
  assert.equal(storage.rows.get(userDeviceIndexKey("u1", "hidden")), deviceCatalogKey("hidden"));
  assert.equal(storage.rows.get(userDeviceIndexReadyKey("u1")), true);
});

test("new users and newly claimed devices maintain the index without full scans", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  const row = { id: "a", userId: "u1", online: true };
  await storeCatalogDevice(storage, row);

  assert.deepEqual(await listCatalogDevices(storage, "u1"), [row]);
  assert.deepEqual(storage.lists, [userDeviceIndexPrefix("u1")]);

  const writes = storage.writes.length;
  await storeCatalogDevice(storage, { ...row, online: false });
  assert.equal(storage.writes.length, writes + 1);
  assert.deepEqual(Object.keys(storage.writes.at(-1)), [deviceCatalogKey("a")]);
});

test("catalog row and missing owner index commit atomically and retry repairs both", async () => {
  const storage = new MemoryStorage();
  const row = { id: "atomic", userId: "u1", online: true };
  storage.failPutCall = 1;
  await assert.rejects(storeCatalogDevice(storage, row), /injected put failure/);
  assert.equal(storage.rows.has(deviceCatalogKey(row.id)), false);
  assert.equal(storage.rows.has(userDeviceIndexKey("u1", row.id)), false);

  storage.failPutCall = 0;
  await storeCatalogDevice(storage, row);
  assert.equal(storage.rows.get(deviceCatalogKey(row.id)), row);
  assert.equal(storage.rows.get(userDeviceIndexKey("u1", row.id)), deviceCatalogKey(row.id));

  storage.rows.delete(userDeviceIndexKey("u1", row.id));
  await storeCatalogDevice(storage, { ...row, online: false });
  assert.equal(storage.rows.get(userDeviceIndexKey("u1", row.id)), deviceCatalogKey(row.id));
  assert.equal(storage.rows.get(deviceCatalogKey(row.id)).online, false);
});

test("a ready user with no devices returns without scanning the global catalog", async () => {
  const storage = new MemoryStorage({ [userDeviceIndexReadyKey("empty")]: true });
  assert.deepEqual(await listCatalogDevices(storage, "empty"), []);
  assert.deepEqual(storage.lists, [userDeviceIndexPrefix("empty")]);
});

test("a missing account never falls back to a global device scan", async () => {
  const storage = new MemoryStorage({
    "d:a": { id: "a", userId: "u1", online: true },
  });
  assert.deepEqual(await listCatalogDevices(storage, ""), []);
  assert.deepEqual(storage.lists, []);
});

test("unbounded fleets page every Durable Object read and write at 128 keys", async () => {
  const entries = {};
  for (let index = 0; index < 300; index += 1) {
    const id = `device-${String(index).padStart(3, "0")}`;
    entries[deviceCatalogKey(id)] = { id, userId: "u1", online: true };
  }
  const storage = new MemoryStorage(entries);
  const devices = await listCatalogDevices(storage, "u1");
  assert.equal(devices.length, 300);
  assert.ok(storage.lists.filter((prefix) => prefix === "d:").length >= 3);

  storage.lists.length = 0;
  assert.equal((await listCatalogDevices(storage, "u1")).length, 300);
  assert.ok(storage.lists.filter((prefix) => prefix === userDeviceIndexPrefix("u1")).length >= 3);
  assert.equal((await setCatalogDeviceAlias(storage, "u1", "device-299", "Last Box")).ok, true);
  assert.equal((await resolveCatalogDevice(storage, "u1", "last box")).id, "device-299");
});

test("a failed paged backfill never publishes ready and a retry completes it", async () => {
  const entries = {};
  for (let index = 0; index < 300; index += 1) {
    const id = `fault-${String(index).padStart(3, "0")}`;
    entries[deviceCatalogKey(id)] = { id, userId: "u1", online: true };
  }
  const storage = new MemoryStorage(entries);
  storage.failPutCall = 2;
  await assert.rejects(listCatalogDevices(storage, "u1"), /injected put failure/);
  assert.equal(storage.rows.has(userDeviceIndexReadyKey("u1")), false);

  storage.failPutCall = 0;
  const rows = await listCatalogDevices(storage, "u1");
  assert.equal(rows.length, 300);
  assert.equal(storage.rows.get(userDeviceIndexReadyKey("u1")), true);
  assert.equal(
    (await listCatalogDevices(storage, "u1")).length,
    300,
    "the completed index must include every device",
  );
});

test("aliases have one stable account-local comparison key", () => {
  assert.deepEqual(normalizeDeviceAlias("  Work PC  "), { alias: "Work PC", key: "work pc" });
  assert.equal(normalizeDeviceAlias("WORK PC").key, normalizeDeviceAlias("work pc").key);
  assert.equal(normalizeDeviceAlias("Ａ").key, normalizeDeviceAlias("a").key);
  assert.deepEqual(normalizeDeviceAlias("  "), { alias: "", key: "" });
  assert.equal(normalizeDeviceAlias("bad\nname"), null);
  assert.equal(normalizeDeviceAlias("x".repeat(DEVICE_ALIAS_MAX_CHARS + 1)), null);
});

test("set/resolve/clear alias preserves immutable device id", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  const row = { id: "device-a", userId: "u1", name: "host-a", online: true };
  await storeCatalogDevice(storage, row);

  const set = await setCatalogDeviceAlias(storage, "u1", row.id, " Build Box ");
  assert.equal(set.ok, true);
  assert.equal(set.device.id, row.id);
  assert.equal(set.device.alias, "Build Box");
  assert.equal((await resolveCatalogDevice(storage, "u1", "build box")).id, row.id);
  assert.equal((await resolveCatalogDevice(storage, "u1", row.id)).id, row.id);

  const key = userDeviceAliasIndexKey("u1", normalizeDeviceAlias("Build Box").key);
  assert.equal(storage.rows.get(key), row.id);
  const cleared = await setCatalogDeviceAlias(storage, "u1", row.id, "");
  assert.equal(cleared.ok, true);
  assert.equal("alias" in cleared.device, false);
  assert.equal(await resolveCatalogDevice(storage, "u1", "build box"), null);
  assert.equal(storage.rows.has(key), false);
});

test("aliases are unique per account, may repeat across accounts, and cannot shadow an id", async () => {
  const storage = new MemoryStorage();
  for (const userId of ["u1", "u2"]) await markUserDeviceIndexReady(storage, userId);
  const rows = [
    { id: "alpha", userId: "u1", online: true },
    { id: "beta", userId: "u1", online: true },
    { id: "gamma", userId: "u2", online: true },
  ];
  for (const row of rows) {
    await storeCatalogDevice(storage, row);
  }

  assert.equal((await setCatalogDeviceAlias(storage, "u1", "alpha", "desk")).ok, true);
  const duplicate = await setCatalogDeviceAlias(storage, "u1", "beta", "DESK");
  assert.deepEqual(duplicate, { ok: false, status: 409, error: "alias already in use" });
  const shadowsId = await setCatalogDeviceAlias(storage, "u1", "alpha", "beta");
  assert.deepEqual(shadowsId, { ok: false, status: 409, error: "alias already in use" });
  assert.equal((await setCatalogDeviceAlias(storage, "u2", "gamma", "desk")).ok, true);
  assert.equal((await resolveCatalogDevice(storage, "u1", "desk")).id, "alpha");
  assert.equal((await resolveCatalogDevice(storage, "u2", "desk")).id, "gamma");
  assert.equal(await resolveCatalogDevice(storage, "u2", "alpha"), null);
});

test("resolving a legacy alias repairs its missing index", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  const row = { id: "legacy", userId: "u1", alias: "Old Box", online: false };
  await storeCatalogDevice(storage, row);

  assert.equal((await resolveCatalogDevice(storage, "u1", "old box")).id, "legacy");
  const key = userDeviceAliasIndexKey("u1", normalizeDeviceAlias("Old Box").key);
  assert.equal(storage.rows.get(key), "legacy");
});

test("alias migration indexes every legacy alias once, including misses", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  for (let i = 0; i < 300; i++) {
    const id = `legacy-${String(i).padStart(3, "0")}`;
    storage.rows.set(deviceCatalogKey(id), { id, userId: "u1", alias: `Box ${i}` });
    storage.rows.set(userDeviceIndexKey("u1", id), deviceCatalogKey(id));
  }
  assert.equal(await resolveCatalogDevice(storage, "u1", "missing"), null);
  assert.ok(storage.lists.length >= 3);
  storage.lists.length = 0;
  for (const ref of ["missing", "another missing", "BOX 299", "box 0"]) await resolveCatalogDevice(storage, "u1", ref);
  assert.deepEqual(storage.lists, [], "misses and other old aliases must not scan again");
  assert.equal((await resolveCatalogDevice(storage, "u1", "BOX 299")).id, "legacy-299");
});

test("failed alias migration is atomic, retry fills all pages and stays account-local", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  for (let i = 0; i < 300; i++) {
    const id = `legacy-${String(i).padStart(3, "0")}`;
    storage.rows.set(deviceCatalogKey(id), { id, userId: "u1", alias: `Box ${i}` });
    storage.rows.set(userDeviceIndexKey("u1", id), deviceCatalogKey(id));
  }
  storage.rows.set("d:foreign", { id: "foreign", userId: "u2", alias: "Private" });
  const before = new Map(storage.rows);
  storage.failPutCall = storage.putCalls + 2;
  await assert.rejects(resolveCatalogDevice(storage, "u1", "missing"), /injected put failure/);
  assert.deepEqual(storage.rows, before);
  storage.failPutCall = 0;
  assert.equal((await resolveCatalogDevice(storage, "u1", "box 299")).id, "legacy-299");
  storage.lists.length = 0;
  assert.equal(await resolveCatalogDevice(storage, "u1", "Private"), null);
  assert.equal(await resolveCatalogDevice(storage, "u1", "foreign"), null);
  assert.deepEqual(storage.lists, []);
});

test("new and renamed aliases stay resolvable after migration; stale indexes cannot cross accounts", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  await resolveCatalogDevice(storage, "u1", "missing");
  await storeCatalogDevice(storage, { id: "new", userId: "u1", alias: "New Box" });
  assert.equal((await resolveCatalogDevice(storage, "u1", "new box")).id, "new");
  await setCatalogDeviceAlias(storage, "u1", "new", "Changed");
  storage.rows.set("d:foreign", { id: "foreign", userId: "u2", alias: "Private" });
  storage.rows.set(userDeviceAliasIndexKey("u1", "private"), "foreign");
  storage.lists.length = 0;
  assert.equal(await resolveCatalogDevice(storage, "u1", "new box"), null);
  assert.equal((await resolveCatalogDevice(storage, "u1", "changed")).id, "new");
  assert.equal(await resolveCatalogDevice(storage, "u1", "private"), null);
  assert.deepEqual(storage.lists, []);
});

test("concurrent migration, rename and insert leave one complete alias index", async () => {
  const storage = new MemoryStorage({ "d:old": { id: "old", userId: "u1", alias: "Old Box" } });
  await Promise.all([
    resolveCatalogDevice(storage, "u1", "missing"),
    setCatalogDeviceAlias(storage, "u1", "old", "Renamed"),
    storage.transaction((txn) => storeCatalogDevice(txn, { id: "next", userId: "u1", alias: "Next Box" })),
  ]);
  storage.lists.length = 0;
  assert.equal(await resolveCatalogDevice(storage, "u1", "old box"), null);
  assert.equal((await resolveCatalogDevice(storage, "u1", "renamed")).id, "old");
  assert.equal((await resolveCatalogDevice(storage, "u1", "next box")).id, "next");
  assert.deepEqual(storage.lists, []);
});

test("legacy duplicate aliases keep a valid chosen index and survive clearing one duplicate", async () => {
  const a = { id: "a", userId: "u1", alias: "Shared" };
  const b = { id: "b", userId: "u1", alias: "SHARED" };
  const storage = new MemoryStorage({
    "d:a": a, "d:b": b,
    [userDeviceAliasIndexKey("u1", "shared")]: "b",
  });
  await resolveCatalogDevice(storage, "u1", "missing");
  assert.equal((await resolveCatalogDevice(storage, "u1", "shared")).id, "b");
  await storeCatalogDevice(storage, { ...a, online: true });
  assert.equal((await resolveCatalogDevice(storage, "u1", "shared")).id, "b");
  await setCatalogDeviceAlias(storage, "u1", "b", "Renamed");
  storage.lists.length = 0;
  assert.equal((await resolveCatalogDevice(storage, "u1", "shared")).id, "a");
  assert.equal((await resolveCatalogDevice(storage, "u1", "renamed")).id, "b");
  assert.deepEqual(storage.lists, []);
});

test("normalized immutable IDs still cannot be shadowed after alias migration", async () => {
  const storage = new MemoryStorage({
    "d:Build-PC": { id: "Build-PC", userId: "u1" },
    "d:other": { id: "other", userId: "u1" },
  });
  await resolveCatalogDevice(storage, "u1", "missing");
  for (const alias of ["build-pc", "BUILD-PC", "Ｂｕｉｌｄ－ＰＣ"]) {
    assert.equal((await setCatalogDeviceAlias(storage, "u1", "other", alias)).status, 409);
  }
});

test("a changed catalog owner cannot resolve through the old account alias index", async () => {
  const storage = new MemoryStorage();
  const row = { id: "moving", userId: "u1", alias: "Box" };
  await storeCatalogDevice(storage, row);
  await resolveCatalogDevice(storage, "u1", "missing");
  await resolveCatalogDevice(storage, "u2", "missing");
  await storeCatalogDevice(storage, { ...row, userId: "u2" });
  storage.lists.length = 0;
  assert.equal(await resolveCatalogDevice(storage, "u1", "box"), null);
  assert.equal(await resolveCatalogDevice(storage, "u1", "moving"), null);
  assert.equal((await resolveCatalogDevice(storage, "u2", "box")).id, "moving");
  assert.deepEqual(storage.lists, []);
});

test("resolution opens only one transaction even when an adapter passes itself", async () => {
  const storage = new MemoryStorage({ "d:a": { id: "a", userId: "u1", alias: "Desk" } });
  let calls = 0;
  storage.transaction = async (fn) => {
    assert.equal(++calls, 1);
    return fn(storage);
  };
  assert.equal((await resolveCatalogDevice(storage, "u1", "desk")).id, "a");
});

test("device claim resolution uses the caller transaction without nesting", async () => {
  const storage = new MemoryStorage({ "d:a": { id: "a", userId: "u1", alias: "Desk" } });
  let active = false;
  storage.transaction = async (fn) => {
    assert.equal(active, false, "nested transaction would deadlock");
    active = true;
    try { return await fn(storage); }
    finally { active = false; }
  };
  await storage.transaction(async (txn) => {
    assert.equal((await resolveCatalogDeviceInTransaction(txn, "u1", "desk")).id, "a");
  });
});
