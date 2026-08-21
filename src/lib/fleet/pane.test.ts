import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LatestWins,
  LocalPane,
  ScreenCoalescer,
  acceptSpawn,
  RING_LINES,
} from "./pane";

test("200 writes inside the interval emit one latest frame", () => {
  let t = 1_000;
  const c = new ScreenCoalescer(250, () => t);
  const pane = new LocalPane("p1", "c1", "yes");
  const first = c.onWrite(pane.snapshot(t));
  assert.ok(first, "first write in a quiet window goes out");
  for (let i = 0; i < 200; i++) {
    pane.append(`line-${i}\n`);
    const wire = c.onWrite(pane.snapshot(t));
    assert.equal(wire, null, "burst must not flood the wire");
  }
  t += 250;
  const flushed = c.tick();
  assert.ok(flushed);
  assert.match(flushed.text, /line-199/);
  assert.ok(!flushed.text.includes("line-0"), "ring + snapshot keep the tail");
  assert.equal(c.emitted, 2);
  assert.ok(c.dropped >= 199);
});

test("latest-wins mailbox drops unread frames", () => {
  const box = new LatestWins<number>();
  box.offer(1);
  box.offer(2);
  box.offer(3);
  assert.equal(box.take(), 3);
  assert.equal(box.take(), null);
  assert.equal(box.dropped, 2);
});

test("acceptSpawn returns before a long job would finish", () => {
  const t0 = 10;
  const tAccepted = 12;
  const jobMs = 30_000;
  const ack = acceptSpawn("corr", "pane", t0, tAccepted);
  assert.equal(ack.status, "accepted");
  assert.ok(ack.ms < 50);
  assert.ok(ack.ms < jobMs);
});

test("pane ring is bounded so a compile log cannot grow forever", () => {
  const pane = new LocalPane("p", "c", "make");
  for (let i = 0; i < 5_000; i++) pane.append(`n=${i}\n`);
  assert.ok(pane.lines.length <= RING_LINES);
  const snap = pane.snapshot();
  assert.match(snap.text, /n=4999/);
  assert.ok(!snap.text.includes("n=0"));
});

test("type does not wait on process exit", () => {
  const pane = new LocalPane("p", "c", "cat");
  const t0 = Date.now();
  pane.append("hello");
  const typed = Date.now() - t0;
  assert.ok(typed < 20);
  assert.equal(pane.running, true);
  assert.equal(pane.exitCode, null);
});

test("control snapshot is a copy, finishing the job later does not rewrite it", () => {
  const pane = new LocalPane("p", "c", "build");
  pane.append("compiling\n");
  const snap = pane.snapshot();
  pane.append("done\n");
  pane.finish(0);
  assert.match(snap.text, /compiling/);
  assert.equal(snap.running, true);
  assert.equal(pane.running, false);
  assert.equal(pane.exitCode, 0);
});
