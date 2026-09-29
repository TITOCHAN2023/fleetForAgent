import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStorage } from "./storage.mjs";

function ledger(t) {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-storage-"));
  const filename = join(root, "private", "room.sqlite");
  const stores = [];
  t.after(async () => { await Promise.all(stores.map((s) => s.close())); rmSync(root, { recursive: true, force: true }); });
  const open = () => { const s = new RoomStorage(filename); stores.push(s); return s; };
  return { root, filename, open };
}

test("failed transaction rolls back all writes and later transactions still commit", async (t) => {
  const s = ledger(t).open();
  await s.transaction((tx) => tx.put("keep", { count: 1 }));
  await assert.rejects(s.transaction(async (tx) => {
    await tx.put("partial", "private text"); await tx.delete("keep"); throw new Error("abort");
  }), /abort/);
  await s.transaction(async (tx) => {
    assert.equal(await tx.get("partial"), undefined);
    assert.deepEqual(await tx.get("keep"), { count: 1 });
    await tx.put("after", true);
  });
});

test("concurrent async transactions serialize read-modify-write without lost updates", async (t) => {
  const s = ledger(t).open();
  await s.transaction((tx) => tx.put("count", 0));
  await Promise.all(Array.from({ length: 40 }, () => s.transaction(async (tx) => {
    const count = await tx.get("count");
    await new Promise((resolve) => setImmediate(resolve));
    await tx.put("count", count + 1);
  })));
  assert.equal(await s.transaction((tx) => tx.get("count")), 40);
});

test("close and reopen recovers committed Room body, ledger and literal prefixes", async (t) => {
  const l = ledger(t); const s = l.open();
  await s.transaction(async (tx) => {
    for (const [key, value] of [["room:a", { version: 3, messages: [{ text: "only-on-leader" }] }], ["task:a", { state: "unknown", epoch: 4 }], ["%_x", 1], ["%_y", 2], ["😀one", 3]]) await tx.put(key, value);
  });
  await s.close();
  const reopened = l.open();
  await reopened.transaction(async (tx) => {
    assert.equal((await tx.get("room:a")).messages[0].text, "only-on-leader");
    assert.deepEqual(await tx.get("task:a"), { state: "unknown", epoch: 4 });
    assert.deepEqual([...(await tx.list({ prefix: "%_" })).keys()], ["%_x", "%_y"]);
    assert.deepEqual([...(await tx.list({ prefix: "😀" })).keys()], ["😀one"]);
  });
});

test("ledger and WAL sidecars are private even under permissive umask", async (t) => {
  const l = ledger(t);
  const previous = process.umask(0);
  let s;
  try { s = l.open(); } finally { process.umask(previous); }
  await s.transaction((tx) => tx.put("secret", "local-only"));
  assert.equal(statSync(join(l.root, "private")).mode & 0o777, 0o700);
  for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(l.filename + suffix).mode & 0o777, 0o600);
  await s.close(); chmodSync(l.filename, 0o644);
  l.open();
  assert.equal(statSync(l.filename).mode & 0o777, 0o600);
});

test("database symlink is refused without altering the target", (t) => {
  const l = ledger(t); const s = l.open();
  const symlink = join(l.root, "alias.sqlite");
  symlinkSync(l.filename, symlink);
  const before = readFileSync(l.filename);
  assert.throws(() => new RoomStorage(symlink), { code: "ELOOP" });
  assert.deepEqual(readFileSync(l.filename), before);
  assert.ok(s);
});

test("transaction handle cannot escape commit; close waits accepted work and rejects new work", async (t) => {
  const s = ledger(t).open();
  let handle;
  await s.transaction(async (tx) => { handle = tx; await tx.put("safe", 1); });
  await assert.rejects(handle.put("escaped", 2), /no longer active/);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = s.transaction(async (tx) => { await gate; await tx.put("last", 3); });
  const closing = s.close();
  await assert.rejects(s.transaction((tx) => tx.put("late", 4)), /closed/);
  release(); await pending; await closing; await s.close();
});
