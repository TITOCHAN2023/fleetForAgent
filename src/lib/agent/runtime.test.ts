import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentRuntime,
  normalizeHub,
} from "./runtime";
import type { ShellResult } from "../fleet/shell";

test("normalizeHub fills wss path from a bare domain", () => {
  const n = normalizeHub("keel.example.workers.dev");
  assert.equal(n.ok, true);
  if (!n.ok) return;
  assert.equal(n.host, "keel.example.workers.dev");
  assert.equal(n.wss, "wss://keel.example.workers.dev/v1/device");
  assert.equal(n.http, "https://keel.example.workers.dev");
});

test("normalizeHub keeps explicit wss url", () => {
  const n = normalizeHub("wss://hub.example.com/v1/device");
  assert.equal(n.ok, true);
  if (!n.ok) return;
  assert.equal(n.wss, "wss://hub.example.com/v1/device");
});

test("normalizeHub maps localhost http to ws", () => {
  const n = normalizeHub("http://127.0.0.1:8080");
  assert.equal(n.ok, true);
  if (!n.ok) return;
  assert.equal(n.wss, "ws://127.0.0.1:8080/v1/device");
});

test("normalizeHub rejects empty", () => {
  const n = normalizeHub("  ");
  assert.equal(n.ok, false);
});

function runtime(now = { t: 1_000 }) {
  const r = new AgentRuntime({
    now: () => now.t,
    askTimeoutMs: 5_000,
    execute: (cmd): ShellResult => ({ exitCode: 0, stdout: `ran:${cmd}`, stderr: "" }),
  });
  r.setEnabled(true);
  return r;
}

test("connect requires the local switch", async () => {
  const r = new AgentRuntime();
  const snap = await r.connect("hub.keel");
  assert.equal(snap.conn, "error");
  assert.match(snap.error, /Turn on/);
});

test("connect succeeds with a fake transport", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  assert.equal(r.conn, "online");
  assert.equal(r.hub && r.hub.ok ? r.hub.host : "", "hub.keel");
});

test("permit off refuses every run", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("off");
  const out = r.incomingRun("uname -a");
  assert.equal(out.status, "refused");
  assert.equal(out.exitCode, 126);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /permit=off/);
});

test("permit allow executes immediately", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("allow");
  const out = r.incomingRun("uname -a");
  assert.equal(out.status, "ok");
  assert.equal(out.stdout, "ran:uname -a");
  assert.ok(out.events.some((e) => e.type === "chunk"));
  assert.equal(out.events.at(-1)?.type, "result");
});

test("permit ask waits, then approve runs", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("ask");
  const pending = r.incomingRun("ver");
  assert.equal(pending.status, "pending");
  assert.ok(r.pending);
  const done = r.approve(pending.corr);
  assert.equal(done.status, "ok");
  assert.equal(done.stdout, "ran:ver");
  assert.equal(r.pending, null);
});

test("permit ask deny does not execute", async () => {
  let ran = 0;
  const r = new AgentRuntime({
    execute: (cmd) => {
      ran += 1;
      return { exitCode: 0, stdout: cmd, stderr: "" };
    },
  });
  r.setEnabled(true);
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("ask");
  const pending = r.incomingRun("whoami");
  const denied = r.deny(pending.corr);
  assert.equal(denied.status, "refused");
  assert.match(denied.stderr, /denied/);
  assert.equal(ran, 0);
});

test("ask consent times out", async () => {
  const clock = { t: 10_000 };
  const r = runtime(clock);
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("ask");
  r.incomingRun("id");
  clock.t = 20_000;
  const timed = r.tick();
  assert.ok(timed);
  assert.equal(timed.status, "refused");
  assert.match(timed.stderr, /timed out/);
  assert.equal(r.pending, null);
});

test("destructive command is blocked even on allow", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("allow");
  const out = r.incomingRun("rm -rf /");
  assert.equal(out.status, "refused");
  assert.equal(out.exitCode, 126);
});

test("offline incoming run is refused", () => {
  const r = runtime();
  r.setPermit("allow");
  const out = r.incomingRun("uname");
  assert.equal(out.status, "refused");
});

test("second ask is rejected while one is pending", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("ask");
  r.incomingRun("first");
  const second = r.incomingRun("second");
  assert.equal(second.status, "refused");
  assert.match(second.stderr, /waiting for consent/);
});

test("disabling the switch drops a pending ask", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("ask");
  r.incomingRun("whoami");
  r.setEnabled(false);
  assert.equal(r.conn, "offline");
  assert.equal(r.pending, null);
});

test("logs record connect and run", async () => {
  const r = runtime();
  await r.connect("hub.keel", { connect: async () => {} });
  r.setPermit("allow");
  r.incomingRun("date");
  assert.ok(r.logs.some((l) => l.msg.includes("online")));
  assert.ok(r.logs.some((l) => l.msg.includes("date")));
});
