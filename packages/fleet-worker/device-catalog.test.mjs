import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceCatalogKey,
  listCatalogDevices,
  markUserDeviceIndexReady,
  rememberDeviceOwner,
  userDeviceIndexKey,
  userDeviceIndexPrefix,
  userDeviceIndexReadyKey,
} from "./src/device-catalog.mjs";

class MemoryStorage {
  constructor(entries = {}) {
    this.rows = new Map(Object.entries(entries));
    this.lists = [];
    this.writes = [];
  }

  async get(key) {
    if (Array.isArray(key)) {
      return new Map(key.filter((item) => this.rows.has(item)).map((item) => [item, this.rows.get(item)]));
    }
    return this.rows.get(key);
  }

  async put(key, value) {
    const entries = typeof key === "string" ? { [key]: value } : key;
    this.writes.push(entries);
    for (const [name, row] of Object.entries(entries)) this.rows.set(name, row);
  }

  async list({ prefix }) {
    this.lists.push(prefix);
    return new Map([...this.rows].filter(([key]) => key.startsWith(prefix)));
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

test("new users and newly claimed devices maintain the index without full scans", async () => {
  const storage = new MemoryStorage();
  await markUserDeviceIndexReady(storage, "u1");
  const row = { id: "a", userId: "u1", online: true };
  storage.rows.set(deviceCatalogKey("a"), row);
  await rememberDeviceOwner(storage, undefined, row);

  assert.deepEqual(await listCatalogDevices(storage, "u1"), [row]);
  assert.deepEqual(storage.lists, [userDeviceIndexPrefix("u1")]);

  const writes = storage.writes.length;
  await rememberDeviceOwner(storage, row, { ...row, online: false });
  assert.equal(storage.writes.length, writes, "presence updates must not rewrite the owner index");
});

test("a ready user with no devices returns without scanning the global catalog", async () => {
  const storage = new MemoryStorage({ [userDeviceIndexReadyKey("empty")]: true });
  assert.deepEqual(await listCatalogDevices(storage, "empty"), []);
  assert.deepEqual(storage.lists, [userDeviceIndexPrefix("empty")]);
});
