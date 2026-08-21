import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createHub } from "./index.mjs";

async function listen(hub) {
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const { port } = hub.server.address();
  return { port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/v1/device` };
}

async function post(http, path, body, token) {
  const headers = { "content-type": "application/json" };
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
