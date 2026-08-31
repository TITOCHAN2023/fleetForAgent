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

test("RTC does not cache an alias across Hub resolutions", async () => {
  const calls = [];
  const manager = createRtcManager({
    hubPost: async (path, body) => {
      calls.push([path, body]);
      assert.equal(path, "/v1/rtc/config");
      assert.deepEqual(body, { device_id: "Singapore 128GB" });
      return { available: false, device_id: "device-real" };
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
    await manager.tryRpc("/v1/run", { device_id: "Singapore 128GB", command: "uname -a" }),
    { handled: false },
  );
  assert.deepEqual(calls, [["/v1/rtc/config", { device_id: "Singapore 128GB" }]]);
  assert.equal("aliases" in manager, false);
});

test("an alias cannot silently reuse a stale canonical RTC session", async () => {
  const sent = [];
  const calls = [];
  const manager = createRtcManager({
    hubPost: async (path, body) => {
      calls.push([path, body]);
      return { available: false, device_id: "device-new" };
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => null,
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  manager.sessions.set("device-real", {
    deviceId: "device-real",
    open: true,
    directReady: true,
    closed: false,
    lastCorr: "",
    rows: new Map(),
    send(message) {
      sent.push(message);
    },
    async close() {},
  });

  const result = await manager.tryRpc("/v1/run", {
    device_id: "Build Box",
    command: "pwd",
  });
  assert.deepEqual(result, { handled: false });
  assert.deepEqual(calls, [["/v1/rtc/config", { device_id: "Build Box" }]]);
  assert.equal(sent.length, 0);
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

test("RTC establishment and reply waits stop on the tools/call signal", async () => {
  const controller = new AbortController();
  let seenSignal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const manager = createRtcManager({
    hubPost: async (path, _body, options) => {
      assert.equal(path, "/v1/rtc/config");
      seenSignal = options?.signal;
      markStarted();
      return new Promise((resolve, reject) => {
        seenSignal.addEventListener(
          "abort",
          () => reject(seenSignal.reason || new Error("cancelled")),
          { once: true },
        );
      });
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => { throw new Error("not called"); },
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  const pending = manager.tryRpc(
    "/v1/run",
    { device_id: "device-1", command: "true" },
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error("stdio closed"));
  await assert.rejects(() => pending, /stdio closed/);
  assert.equal(seenSignal, controller.signal);

  const dc = {};
  const pc = { connectionStateChange: { subscribe() {} } };
  const session = new _test.DirectSession({
    sid: "11111111-2222-4333-8444-555555555555",
    deviceId: "device-1",
    operatorId: "operator-1",
    pc,
    dc,
  });
  const waitController = new AbortController();
  const waiting = session.waitFor(() => false, 60_000, waitController.signal);
  waitController.abort(new Error("wait cancelled"));
  await assert.rejects(() => waiting, /wait cancelled/);
  assert.equal(session.waiters.size, 0, "aborted wait retained a live timer/waiter");
});

test("an aborted RTC reply wait never enters the ordinary Hub fallback", async () => {
  const hubCalls = [];
  const manager = createRtcManager({
    hubPost: async (...args) => {
      hubCalls.push(args);
      throw new Error("unexpected fallback");
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => null,
    verifyFleetStatement: async () => null,
    officialPlugin: () => null,
  });
  const session = {
    open: true,
    directReady: true,
    closed: false,
    lastCorr: "corr-1",
    rows: new Map(),
    send() {},
    waitFor(_check, _timeout, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  manager.sessions.set("device-1", session);
  const controller = new AbortController();
  const pending = manager.tryRpc(
    "/v1/read_screen",
    { device_id: "device-1", corr: "corr-1" },
    { signal: controller.signal },
  );
  controller.abort(new Error("request cancelled"));
  await assert.rejects(() => pending, /request cancelled/);
  assert.deepEqual(hubCalls, []);
});

test("Tool sends no business data before Agent confirms its ticket with rtc_ready", async () => {
  const sent = [];
  const dc = { send: (raw) => sent.push(JSON.parse(raw)) };
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
  assert.equal(sent.at(-1).type, "rtc_ack_ready");
  assert.equal(sent.at(-1).body.version, 1);
  session.onMessage(JSON.stringify({
    v: 1,
    type: "result",
    corr: "corr-1",
    t: Date.now(),
    body: { ok: true, exit_code: 0, stdout: "ok" },
  }));
  assert.deepEqual(sent.at(-1), {
    v: 1,
    type: "rtc_ack",
    id: sent.at(-1).id,
    corr: "corr-1",
    t: sent.at(-1).t,
    body: { type: "result" },
  });
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

test("bounded plugin tasks prefer RTC and fall back to the Hub unchanged", async () => {
  const sent = [];
  const manifest = { id: "example.task", version: "1.0.0", actions: ["run"] };
  const manager = createRtcManager({
    hubPost: async () => {
      throw new Error("an established RTC session must not signal again");
    },
    token: "unused",
    operatorId: "operator-1",
    verifyTokenV1: async () => {
      throw new Error("not called");
    },
    verifyFleetStatement: async () => null,
    officialPlugin: (id) => (id === manifest.id ? manifest : null),
  });
  const session = {
    open: true,
    directReady: true,
    closed: false,
    lastCorr: "",
    rows: new Map(),
    send(value) {
      sent.push(value);
    },
    async close() {},
  };
  manager.sessions.set("device-1", session);

  const request = {
    device_id: "device-1",
    operation: "install",
    plugin_id: manifest.id,
  };
  const direct = await manager.tryRpc("/v1/plugin", request);
  assert.equal(direct.handled, true);
  assert.equal(direct.transport, "rtc");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "plugin");
  assert.deepEqual(sent[0].body, {
    operation: "install",
    plugin_id: manifest.id,
    manifest,
  });
  assert.equal("device_id" in sent[0].body, false);

  session.send = () => {
    throw new Error("RTC closed");
  };
  manager.sessions.set("device-1", session);
  assert.deepEqual(await manager.tryRpc("/v1/plugin", request), { handled: false });
  assert.deepEqual(request, {
    device_id: "device-1",
    operation: "install",
    plugin_id: manifest.id,
  });
});
