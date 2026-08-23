import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { assertHubBind, createHub, isLoopbackHost } from "./index.mjs";

async function listen(hub) {
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const { port } = hub.server.address();
  return { port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/v1/device` };
}

async function post(http, path, body, token, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${http}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

function connectDevice(wsUrl, { id = "dev-1", name = "box", os = "linux", token } = {}) {
  const headers = {
    "X-Device-Id": id,
    "X-Device-Name": name,
    "X-Device-Os": os,
    "X-Fleet-Proto": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ws = new WebSocket(wsUrl, { headers });
  const inbox = [];
  ws.on("message", (data) => inbox.push(JSON.parse(String(data))));
  return { ws, inbox, opened: once(ws, "open") };
}

function once(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, resolve);
    ws.once("error", reject);
  });
}

async function waitType(inbox, type, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = inbox.find((m) => m.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${type}: ${JSON.stringify(inbox)}`);
}

test("empty HUB_TOKEN cannot bind a public interface", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.deepEqual(assertHubBind({ host: "127.0.0.1", token: "" }), { host: "127.0.0.1", token: "" });
  assert.throws(() => assertHubBind({ host: "0.0.0.0", token: "" }), /HUB_TOKEN required/);
  assert.deepEqual(assertHubBind({ host: "0.0.0.0", token: "secret" }), { host: "0.0.0.0", token: "secret" });
});

test("health is open and names the node backend", async (t) => {
  const hub = createHub({ token: "secret" });
  t.after(() => hub.close());
  const { http } = await listen(hub);
  const res = await fetch(`${http}/v1/health`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.backend, "node");
});

test("control plane requires token when set", async (t) => {
  const hub = createHub({ token: "secret" });
  t.after(() => hub.close());
  const { http } = await listen(hub);
  const denied = await post(http, "/v1/list_computers", {});
  assert.equal(denied.status, 401);
  const ok = await post(http, "/v1/list_computers", {}, "secret");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.computers, []);
});

test("device hello → list_computers, no IPs, run returns before result", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1", name: "Mac mini", os: "darwin" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: Date.now(),
      body: { os: "darwin", hostname: "Mac mini", agent_ver: "0.2.0" },
    }),
  );

  const listed = await post(http, "/v1/list_computers", {});
  assert.equal(listed.status, 200);
  assert.equal(listed.json.computers.length, 1);
  const row = listed.json.computers[0];
  assert.equal(row.id, "mac-1");
  assert.equal(row.online, true);
  assert.equal(row.os, "darwin");
  assert.equal("ip" in row, false);
  assert.equal("intranet_ip" in row, false);

  const t0 = Date.now();
  const run = await post(http, "/v1/run", { device_id: "mac-1", command: "sleep 30" });
  const ms = Date.now() - t0;
  assert.equal(run.status, 200);
  assert.equal(run.json.status, "running");
  assert.ok(run.json.corr);
  assert.ok(ms < 200, `run waited ${ms}ms`);

  const pending = await post(http, "/v1/get_result", { device_id: "mac-1", corr: run.json.corr });
  assert.equal(pending.json.status, "pending");

  const down = await waitType(dev.inbox, "run");
  assert.equal(down.body.command, "sleep 30");
  assert.equal(down.body.mode, "pane");
  assert.equal(down.corr, run.json.corr);

  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "result",
      id: "r1",
      corr: run.json.corr,
      t: Date.now(),
      body: { ok: true, exit_code: 0, stdout: "done", error: "" },
    }),
  );
  const t1 = Date.now();
  while (Date.now() - t1 < 1000) {
    const got = await post(http, "/v1/get_result", { device_id: "mac-1", corr: run.json.corr });
    if (got.json.status === "done") {
      assert.equal(got.json.ok, true);
      assert.equal(got.json.stdout, "done");
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("result never landed");
});

test("run on offline device is 409; type does not wait", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const off = await post(http, "/v1/run", { device_id: "ghost", command: "uname" });
  assert.equal(off.status, 409);

  const dev = connectDevice(wsUrl);
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const typed = await post(http, "/v1/type", { device_id: "dev-1", keys: "q\n" });
  assert.equal(typed.status, 200);
  assert.equal(typed.json.status, "typed");
  const down = await waitType(dev.inbox, "type");
  assert.equal(down.body.keys, "q\n");

  const named = await post(http, "/v1/type", { device_id: "dev-1", key: "ctrl+c" });
  assert.equal(named.status, 200);
  const t0 = Date.now();
  let downKey;
  while (Date.now() - t0 < 1000) {
    downKey = dev.inbox.find((m) => m.type === "type" && m.body?.key === "ctrl+c");
    if (downKey) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(downKey?.body?.key, "ctrl+c");
});

test("run wait_ms>0 returns the get_result payload when the device finishes", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const runP = post(http, "/v1/run", { device_id: "mac-1", command: "pwd", wait_ms: 1000 });
  const down = await waitType(dev.inbox, "run");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "result",
      id: "r-wait",
      corr: down.corr,
      t: Date.now(),
      body: { ok: true, exit_code: 0, stdout: "hi", error: "" },
    }),
  );
  const run = await runP;
  assert.equal(run.status, 200);
  assert.equal(run.json.status, "done");
  assert.equal(run.json.ok, true);
  assert.equal(run.json.stdout, "hi");
  assert.equal(run.json.corr, down.corr);
});

test("run wait_ms timeout does not kill; later get_result still lands", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const t0 = Date.now();
  const run = await post(http, "/v1/run", { device_id: "mac-1", command: "sleep 30", wait_ms: 60 });
  assert.ok(Date.now() - t0 < 400, `held ${Date.now() - t0}ms`);
  assert.ok(run.json.corr);
  assert.notEqual(run.json.status, "done");

  const down = await waitType(dev.inbox, "run");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "result",
      id: "r-late",
      corr: down.corr,
      t: Date.now(),
      body: { ok: true, exit_code: 0, stdout: "late", error: "" },
    }),
  );
  const t1 = Date.now();
  while (Date.now() - t1 < 1000) {
    const got = await post(http, "/v1/get_result", { device_id: "mac-1", corr: run.json.corr });
    if (got.json.status === "done") {
      assert.equal(got.json.stdout, "late");
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("result never landed after wait timeout");
});

test("get_result wait_ms long-polls until the device result", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const run = await post(http, "/v1/run", { device_id: "mac-1", command: "pwd" });
  const down = await waitType(dev.inbox, "run");
  const gotP = post(http, "/v1/get_result", { device_id: "mac-1", corr: run.json.corr, wait_ms: 1000 });
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "result",
      id: "r-get",
      corr: down.corr,
      t: Date.now(),
      body: { ok: true, exit_code: 0, stdout: "polled", error: "" },
    }),
  );
  const got = await gotP;
  assert.equal(got.json.status, "done");
  assert.equal(got.json.stdout, "polled");
});

test("device ping updates lastSeen, replies pong, list follows live socket", async (t) => {
  let now = 1_000;
  const hub = createHub({ now: () => now });
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-1", name: "MySuperPC", os: "windows" });
  t.after(() => {
    try {
      dev.ws.close();
    } catch {
      /* ignore */
    }
  });
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  now = 2_000;
  dev.ws.send(JSON.stringify({ v: 1, type: "ping", id: "p1", t: now, body: {} }));
  const pong = await waitType(dev.inbox, "pong");
  assert.equal(pong.corr, "p1");

  const listed = await post(http, "/v1/list_computers", {});
  const row = listed.json.computers.find((c) => c.id === "win-1");
  assert.ok(row);
  assert.equal(row.online, true);
  assert.equal(row.lastSeen, 2_000);
  assert.equal(row.os, "windows");

  const closed = once(dev.ws, "close");
  dev.ws.close();
  await closed;
  const after = await post(http, "/v1/list_computers", {});
  assert.equal(after.json.computers[0].online, false);
});

test("hub rejects a ticket owned by another fingerprint", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const runA = await post(http, "/v1/run", { device_id: "mac-1", command: "sleep 30" }, undefined, {
    "X-Fleet-Operator": "fp-a",
  });
  assert.equal(runA.status, 200);
  const down = await waitType(dev.inbox, "run");
  assert.equal(down.body.fingerprint, "fp-a");
  assert.equal(down.corr, runA.json.corr);

  const foreign = await post(
    http,
    "/v1/get_result",
    { device_id: "mac-1", corr: runA.json.corr },
    undefined,
    { "X-Fleet-Operator": "fp-b" },
  );
  assert.equal(foreign.json.status, "pending");
  assert.equal("stdout" in foreign.json, false);
  assert.equal(foreign.json.corr, undefined);

  const typed = await post(
    http,
    "/v1/type",
    { device_id: "mac-1", corr: runA.json.corr, keys: "secret\n" },
    undefined,
    { "X-Fleet-Operator": "fp-b" },
  );
  assert.equal(typed.status, 200);
  assert.equal(
    dev.inbox.some((m) => m.type === "type"),
    false,
    "foreign type must not reach the agent",
  );

  const mine = await post(http, "/v1/get_result", { device_id: "mac-1" }, undefined, {
    "X-Fleet-Operator": "fp-a",
  });
  assert.equal(mine.json.status, "pending");
  assert.equal(mine.json.corr, runA.json.corr);
});

test("headerless 0.2.7 clients share one anonymous fingerprint", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "mac-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const run = await post(http, "/v1/run", { device_id: "mac-1", command: "pwd" });
  const down = await waitType(dev.inbox, "run");
  assert.equal(down.body.fingerprint, undefined);
  const peek = await post(http, "/v1/get_result", { device_id: "mac-1", corr: run.json.corr });
  assert.equal(peek.json.status, "pending");
  assert.equal(peek.json.corr, run.json.corr);
});

async function waitAgentVer(http, id, ver, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const listed = await post(http, "/v1/list_computers", {});
    const row = listed.json.computers.find((c) => c.id === id);
    if (row?.agentVer === ver) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${id} agentVer=${ver}`);
}

test("heartbeat with agent_ver updates list_computers agentVer", async (t) => {
  let now = 1_000;
  const hub = createHub({ now: () => now });
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-1", name: "MySuperPC", os: "windows" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: now,
      body: { os: "windows", hostname: "MySuperPC", agent_ver: "0.2.5" },
    }),
  );
  await waitAgentVer(http, "win-1", "0.2.5");
  now = 2_000;
  dev.ws.send(
    JSON.stringify({ v: 1, type: "ping", id: "p-ver", t: now, body: { agent_ver: "0.2.8" } }),
  );
  await waitType(dev.inbox, "pong");
  const listed = await post(http, "/v1/list_computers", {});
  const row = listed.json.computers.find((c) => c.id === "win-1");
  assert.equal(row.agentVer, "0.2.8");
  assert.equal(row.lastSeen, 2_000);
});

test("heartbeat without agent_ver keeps the hello version (old 0.2.8 compat)", async (t) => {
  let now = 1_000;
  const hub = createHub({ now: () => now });
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-1", name: "MySuperPC", os: "windows" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: now,
      body: { os: "windows", hostname: "MySuperPC", agent_ver: "0.2.5" },
    }),
  );
  await waitAgentVer(http, "win-1", "0.2.5");
  now = 3_000;
  dev.ws.send(JSON.stringify({ v: 1, type: "ping", id: "p-old", t: now, body: {} }));
  await waitType(dev.inbox, "pong");
  const listed = await post(http, "/v1/list_computers", {});
  const row = listed.json.computers.find((c) => c.id === "win-1");
  assert.equal(row.agentVer, "0.2.5");
  assert.equal(row.lastSeen, 3_000);
});

test("get_computer returns one catalog row; unknown id is 404", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const missing = await post(http, "/v1/get_computer", { device_id: "ghost" });
  assert.equal(missing.status, 404);

  const bad = await post(http, "/v1/get_computer", {});
  assert.equal(bad.status, 400);

  const dev = connectDevice(wsUrl, { id: "mac-1", name: "Mac mini", os: "darwin" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: Date.now(),
      body: { os: "darwin", hostname: "Mac mini", agent_ver: "0.2.8" },
    }),
  );
  await waitAgentVer(http, "mac-1", "0.2.8");

  const got = await post(http, "/v1/get_computer", { device_id: "mac-1" });
  assert.equal(got.status, 200);
  assert.equal(got.json.id, "mac-1");
  assert.equal(got.json.name, "Mac mini");
  assert.equal(got.json.os, "darwin");
  assert.equal(got.json.online, true);
  assert.equal(got.json.agentVer, "0.2.8");
  assert.equal("userId" in got.json, false);
  assert.equal("ip" in got.json, false);
});

test("manual heartbeat asks a live client and stores agent_ver from the reply", async (t) => {
  let now = 1_000;
  const hub = createHub({ now: () => now });
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-1", name: "MySuperPC", os: "windows" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: now,
      body: { os: "windows", hostname: "MySuperPC", agent_ver: "0.2.5" },
    }),
  );
  await waitAgentVer(http, "win-1", "0.2.5");

  now = 4_000;
  const asked = post(http, "/v1/heartbeat", { device_id: "win-1", wait_ms: 1000 });
  const down = await waitType(dev.inbox, "ask_heartbeat");
  assert.equal(down.type, "ask_heartbeat");
  dev.ws.send(
    JSON.stringify({ v: 1, type: "heartbeat", id: "hb1", t: now, body: { agent_ver: "0.2.8" } }),
  );
  const res = await asked;
  assert.equal(res.status, 200);
  assert.equal(res.json.id, "win-1");
  assert.equal(res.json.online, true);
  assert.equal(res.json.agentVer, "0.2.8");
  assert.equal(res.json.lastSeen, 4_000);

  const listed = await post(http, "/v1/list_computers", {});
  assert.equal(listed.json.computers[0].agentVer, "0.2.8");
});

test("manual heartbeat on offline or mute device is 409 and does not hang", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);

  const ghost = await post(http, "/v1/heartbeat", { device_id: "ghost" });
  assert.equal(ghost.status, 404);

  const dev = connectDevice(wsUrl, { id: "win-1" });
  t.after(() => {
    try {
      dev.ws.close();
    } catch {
      /* ignore */
    }
  });
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");

  const tMute = Date.now();
  const mute = await post(http, "/v1/heartbeat", { device_id: "win-1", wait_ms: 80 });
  assert.ok(Date.now() - tMute < 400, `mute hung ${Date.now() - tMute}ms`);
  assert.equal(mute.status, 409);
  assert.equal(mute.json.error, "no heartbeat");

  const closed = once(dev.ws, "close");
  dev.ws.close();
  await closed;
  const tOff = Date.now();
  const off = await post(http, "/v1/heartbeat", { device_id: "win-1" });
  assert.ok(Date.now() - tOff < 200, `offline hung ${Date.now() - tOff}ms`);
  assert.equal(off.status, 409);
  assert.equal(off.json.error, "offline");
});

test("new socket kicks the old one", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { ws: wsUrl } = await listen(hub);
  const a = connectDevice(wsUrl, { id: "solo" });
  t.after(() => a.ws.close());
  await a.opened;
  const closed = once(a.ws, "close");
  const b = connectDevice(wsUrl, { id: "solo" });
  t.after(() => b.ws.close());
  await b.opened;
  await closed;
});

test("hello caps and permit survive a ping without those fields", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-cu" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: Date.now(),
      body: {
        os: "windows",
        hostname: "CU",
        agent_ver: "0.3.0",
        caps: ["shell", "pane", "computer_use"],
        permit: "ask",
      },
    }),
  );
  const t0 = Date.now();
  let row;
  while (Date.now() - t0 < 1000) {
    const listed = await post(http, "/v1/list_computers", {});
    row = listed.json.computers.find((c) => c.id === "win-cu");
    if (row?.caps?.includes("computer_use")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(Array.isArray(row.caps));
  assert.ok(row.caps.includes("computer_use"));
  assert.equal(row.permit, "ask");
  dev.ws.send(JSON.stringify({ v: 1, type: "ping", id: "p1", t: Date.now(), body: { agent_ver: "0.3.0" } }));
  await waitType(dev.inbox, "pong");
  const after = await post(http, "/v1/get_computer", { device_id: "win-cu" });
  assert.deepEqual(after.json.caps, ["shell", "pane", "computer_use"]);
  assert.equal(after.json.permit, "ask");
  assert.equal("userId" in after.json, false);
});

test("desktop_screenshot 409s without computer_use and sends no WS frame", async (t) => {
  const hub = createHub();
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const missing = await post(http, "/v1/desktop_screenshot", { device_id: "ghost" });
  assert.equal(missing.status, 404);

  const dev = connectDevice(wsUrl, { id: "old-1" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  const before = dev.inbox.length;
  const denied = await post(http, "/v1/desktop_screenshot", { device_id: "old-1" });
  assert.equal(denied.status, 409);
  assert.equal(denied.json.code, "UNSUPPORTED_CAP");
  assert.equal(
    dev.inbox.some((m) => m.type === "desktop_screenshot" || m.type === "desktop_action"),
    false,
  );
  assert.equal(dev.inbox.length, before);
});

test("desktop_screenshot waits for a desktop reply and does not hang when mute", async (t) => {
  const hub = createHub({ desktopWaitMs: 800 });
  t.after(() => hub.close());
  const { http, ws: wsUrl } = await listen(hub);
  const dev = connectDevice(wsUrl, { id: "win-live" });
  t.after(() => dev.ws.close());
  await dev.opened;
  await waitType(dev.inbox, "hello_ok");
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: "h1",
      t: Date.now(),
      body: { os: "windows", caps: ["shell", "pane", "computer_use"], permit: "allow" },
    }),
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) {
    const listed = await post(http, "/v1/list_computers", {});
    const row = listed.json.computers.find((c) => c.id === "win-live");
    if (row?.caps?.includes("computer_use")) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  async function nextShot(afterCorr) {
    const t1 = Date.now();
    while (Date.now() - t1 < 1000) {
      const hit = dev.inbox.find((m) => m.type === "desktop_screenshot" && m.corr !== afterCorr);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no desktop_screenshot frame");
  }

  const asked = post(http, "/v1/desktop_screenshot", { device_id: "win-live" });
  const down = await nextShot(undefined);
  assert.ok(down.corr);
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "desktop",
      id: "d1",
      corr: down.corr,
      t: Date.now(),
      body: { ok: true, status: "ok", width: 1280, height: 720, image_b64: "qq" },
    }),
  );
  const got = await asked;
  assert.equal(got.status, 200);
  assert.equal(got.json.ok, true);
  assert.equal(got.json.width, 1280);
  assert.equal(got.json.image_b64, "qq");

  const alias = post(http, "/v1/desktop_action", { device_id: "win-live", action: "screenshot" });
  const down2 = await nextShot(down.corr);
  dev.ws.send(
    JSON.stringify({
      v: 1,
      type: "desktop",
      corr: down2.corr,
      t: Date.now(),
      body: { ok: true, status: "ok", unchanged: true },
    }),
  );
  const aliased = await alias;
  assert.equal(aliased.status, 200);
  assert.equal(aliased.json.unchanged, true);

  const mute = await post(http, "/v1/desktop_action", { device_id: "win-live", action: "left_click", x: 1, y: 1 });
  assert.equal(mute.status, 409);
  assert.equal(mute.json.code, "TIMEOUT");
});
