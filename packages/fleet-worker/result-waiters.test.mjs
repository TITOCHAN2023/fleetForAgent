import assert from "node:assert/strict";
import test from "node:test";
import { ResultWaiters } from "./src/result-waiters.mjs";

test("parallel waits share reads and a stored terminal result wakes everyone", async () => {
  let reads = 0;
  const waits = new ResultWaiters({ read: async () => { reads++; }, isDone: (r) => r?.status === "done", fallbackMs: 10_000 });
  const pending = Array.from({ length: 50 }, () => waits.wait("a", 1000));
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  waits.notify("a", { status: "done", stdout: "safe" });
  assert.ok((await Promise.all(pending)).every((r) => r.stdout === "safe"));
  assert.equal(waits.entries.size, 0);
});

test("abort removes only that waiter; timeout and failure clean up groups", async () => {
  const waits = new ResultWaiters({ read: async () => ({ status: "running" }), isDone: () => false, fallbackMs: 10 });
  const ac = new AbortController();
  const one = waits.wait("a", 1000, ac.signal);
  const two = waits.wait("a", 30);
  ac.abort(); await one;
  assert.equal(waits.entries.size, 1);
  assert.equal((await two).status, "running");
  assert.equal(waits.entries.size, 0);
  const broken = new ResultWaiters({ read: async () => { throw new Error("read failed"); }, isDone: () => false });
  await assert.rejects(broken.wait("b", 1000), /read failed/);
  assert.equal(broken.entries.size, 0);
});

test("fallback recovers missed notifications, with no execution callback", async () => {
  let reads = 0;
  const waits = new ResultWaiters({ read: async () => ++reads === 2 ? { status: "done" } : undefined, isDone: (r) => r?.status === "done", fallbackMs: 5 });
  assert.equal((await waits.wait("a", 1000)).status, "done");
  assert.equal(reads, 2);
  assert.equal(waits.entries.size, 0);
});

test("completion notification wins over stale in-flight read, and corr groups are isolated", async () => {
  const releases = [];
  const waits = new ResultWaiters({ read: () => new Promise((r) => releases.push(r)), isDone: (r) => r?.status === "done" });
  const pending = waits.wait("a", 1000);
  const ac = new AbortController();
  const other = waits.wait("b", 1000, ac.signal);
  waits.notify("a", { status: "running" });
  assert.equal(waits.entries.size, 2);
  waits.notify("a", { status: "done", value: "a" });
  assert.equal((await pending).value, "a");
  releases[0]({ status: "running" });
  assert.equal(waits.entries.size, 1);
  ac.abort(); await other;
  releases[1]({ status: "running" });
  await new Promise(setImmediate);
  assert.equal(waits.entries.size, 0);
});

test("running notification during read is not overwritten by older stored state", async () => {
  let release;
  const waits = new ResultWaiters({ read: () => new Promise((r) => { release = r; }), isDone: (r) => r?.status === "done", fallbackMs: 1000 });
  const pending = waits.wait("a", 30);
  waits.notify("a", { status: "running", pane: "new" });
  release(undefined);
  assert.equal((await pending).pane, "new");
  assert.equal(waits.entries.size, 0);
});

test("old group's read cannot overwrite a replacement after abort during read", async () => {
  const releases = [];
  const waits = new ResultWaiters({ read: () => new Promise((r) => releases.push(r)), isDone: (r) => r?.status === "done" });
  const ac = new AbortController();
  const old = waits.wait("a", 1000, ac.signal);
  ac.abort(); await old;
  const fresh = waits.wait("a", 1000);
  releases[0]({ status: "done", value: "old" });
  await new Promise(setImmediate);
  assert.equal(waits.entries.size, 1);
  releases[1]({ status: "done", value: "fresh" });
  assert.equal((await fresh).value, "fresh");
  assert.equal(waits.entries.size, 0);
});
