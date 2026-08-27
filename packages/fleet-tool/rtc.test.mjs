import assert from "node:assert/strict";
import test from "node:test";

import { _test, createRtcManager } from "./rtc.mjs";

test("RTC uses the existing v1 envelope and normalizes SHA-256 fingerprints", () => {
  const env = _test.envelope("run", { command: "true" }, "corr-1");
  assert.equal(env.v, 1);
  assert.equal(env.type, "run");
  assert.equal(env.corr, "corr-1");
  assert.deepEqual(env.body, { command: "true" });
  const raw = "AA:".repeat(31) + "AA";
  assert.equal(_test.fingerprint(`v=0\r\na=fingerprint:sha-256 ${raw}\r\n`), "aa".repeat(32));
});

test("old hubs and old agents fall back without changing the business request", async () => {
  const calls = [];
  const manager = createRtcManager({
    hubPost: async (path, body) => {
      calls.push([path, body]);
      return { available: false };
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => {
      throw new Error("not called");
    },
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  assert.deepEqual(
    await manager.tryRpc("/v1/run", { device_id: "old-agent", command: "uname -a" }),
    {
      handled: false,
    },
  );
  assert.deepEqual(calls, [["/v1/rtc/config", { device_id: "old-agent" }]]);
});

test("heartbeat stays on the existing hub path and never opens RTC", async () => {
  const calls = [];
  const manager = createRtcManager({
    hubPost: async (path, body) => {
      calls.push([path, body]);
      throw new Error("heartbeat must not touch RTC signaling");
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => {
      throw new Error("not called");
    },
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  assert.deepEqual(await manager.tryRpc("/v1/heartbeat", { device_id: "device-1" }), {
    handled: false,
  });
  assert.deepEqual(calls, []);
});

test("Tool sends no business data before Agent confirms its ticket with rtc_ready", async () => {
  const dc = {};
  const pc = { connectionStateChange: { subscribe() {} } };
  const session = new _test.DirectSession({
    sid: "11111111-2222-4333-8444-555555555555",
    deviceId: "device-1",
    operatorId: "operator-1",
    pc,
    dc,
  });
  dc.onopen();
  assert.equal(session.open, true);
  assert.equal(session.directReady, false);
  assert.throws(() => session.send(_test.envelope("run", {}, "before-ready")), /unavailable/);
  session.onMessage(JSON.stringify({ v: 1, type: "rtc_ready", body: { sid: "wrong" } }));
  assert.equal(session.directReady, false);
  session.onMessage(
    JSON.stringify({
      v: 1,
      type: "rtc_ready",
      body: { sid: "11111111-2222-4333-8444-555555555555" },
    }),
  );
  await session.waitReady(10);
  assert.equal(session.directReady, true);
});

test("closed RTC snapshots fall back to the hub unless the final reply was already received", async () => {
  const calls = [];
  const manager = createRtcManager({
    hubPost: async (...args) => {
      calls.push(args);
      return { available: false };
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => {
      throw new Error("not called");
    },
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  const session = {
    open: false,
    directReady: false,
    closed: true,
    lastCorr: "corr-1",
    rows: new Map(),
    result: () => ({ corr: "corr-1", status: "running" }),
  };
  manager.sessions.set("device-1", session);
  assert.deepEqual(
    await manager.tryRpc("/v1/get_result", { device_id: "device-1", corr: "corr-1" }),
    { handled: false },
  );
  session.rows.set("corr-1", { result: { body: { ok: true } } });
  session.result = () => ({ corr: "corr-1", ok: true });
  assert.deepEqual(
    await manager.tryRpc("/v1/get_result", { device_id: "device-1", corr: "corr-1" }),
    { handled: true, value: { corr: "corr-1", ok: true }, transport: "rtc" },
  );
  assert.deepEqual(calls, []);
});

test("desktop response recovered from the relay reports ws provenance", async () => {
  let polls = 0;
  const manager = createRtcManager({
    hubPost: async (path) => {
      assert.equal(path, "/v1/rtc/result");
      polls += 1;
      return { status: "done", body: { ok: true } };
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => {
      throw new Error("not called");
    },
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  manager.sessions.set("device-1", {
    open: true,
    directReady: true,
    closed: false,
    lastCorr: "",
    rows: new Map(),
    send() {},
    waitFor: async () => {
      throw new Error("RTC data channel closed");
    },
  });
  const out = await manager.tryRpc("/v1/desktop_action", {
    device_id: "device-1",
    action: "left_click",
  });
  assert.deepEqual(out, { handled: true, value: { ok: true }, transport: "ws" });
  assert.equal(polls, 1);
});
