import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createHub } from "../fleet-hub/index.mjs";
import { mintTokenV1 } from "../fleet-worker/src/tokenv1.mjs";
import { RoomConnection } from "./client.mjs";
import { RoomRelay, ROOM_FRAME_LIMIT, relayRegistration } from "./relay.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function lab(t) {
  const token = "local-room-test-only";
  const hub = createHub({ token });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  t.after(() => hub.close());
  return {
    hub, url, token,
    async connect(options = {}) {
      const c = new RoomConnection({ url, token, id: "agent", ...options });
      t.after(() => c.close());
      return c.connect();
    },
    async directory(auth = token) {
      const r = await fetch(`${url}/v1/room-agents`, { headers: { authorization: `Bearer ${auth}` } });
      return { status: r.status, ...(await r.json()) };
    },
  };
}
function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off("message", handler); };
    const handler = (raw) => { const m = JSON.parse(String(raw)); if (predicate(m)) { cleanup(); resolve(m); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("No expected websocket message")); }, 2000);
    ws.on("message", handler);
  });
}

test("real Hub requires its account credential for websocket and directory", async (t) => {
  const l = await lab(t);
  await assert.rejects(l.connect({ token: "other-account-token" }), /connection/);
  assert.equal((await l.directory("other-account-token")).status, 401);
  const c = await l.connect({ name: "工作机 Codex % 一号" });
  assert.equal((await l.directory()).agents[0].name, "工作机 Codex % 一号");
  assert.equal(c.ws.readyState, 1);
});

test("MCP registration is non-callable and reconnect retains one stable directory identity", async (t) => {
  const l = await lab(t);
  const a = await l.connect({ id: "stable", leader: true });
  let directory = await l.directory();
  assert.deepEqual(directory.agents.map(({ id, callable, leader }) => ({ id, callable, leader })), [{ id: "stable", callable: false, leader: false }]);
  await assert.rejects(a.call("stable", "room.get", {}), { code: "LEADER_OFFLINE" });
  const closed = once(a.ws, "close"); a.close(); await closed;
  assert.equal((await l.directory()).agents.length, 0);
  await a.connect();
  const runtime = await l.connect({ id: "stable", mode: "runtime", leader: true });
  directory = await l.directory();
  assert.equal(directory.agents.length, 1);
  assert.equal(directory.agents[0].callable, true);
  await assert.rejects(l.connect({ id: "stable", mode: "runtime", leader: true }), /closed/);
  assert.equal(runtime.ws.readyState, 1);
});

test("agent principal is derived from connection; a frame may only narrow its Room scope", async (t) => {
  const l = await lab(t);
  let received;
  await l.connect({ id: "leader", mode: "runtime", leader: true, onRequest: async (m) => { received = m; return m.principal; } });
  const member = await l.connect({ id: "member", roomId: "room-a" });
  const reply = nextMessage(member.ws, (m) => m.type === "reply" && m.id === "forged");
  member.send({ type: "call", id: "forged", leaderId: "leader", action: "room.get", input: { roomId: "room-a", principal: { kind: "user", id: "owner" } }, principal: { kind: "user", id: "owner" } });
  assert.deepEqual((await reply).result, { kind: "agent", id: "member", roomId: "room-a" });
  assert.deepEqual(received.principal, { kind: "agent", id: "member", roomId: "room-a" });
  assert.deepEqual(await member.call("leader", "agents.list", {}), { kind: "agent", id: "member", roomId: "room-a" });
  assert.deepEqual(await member.call("leader", "rooms.list", {}), { kind: "agent", id: "member", roomId: "room-a" });
  await assert.rejects(member.call("leader", "room.get", { roomId: "room-b" }), { code: "INVALID_SCOPE" });
  await assert.rejects(member.call("leader", "room.get", { roomId: "room-b" }, { scopeRoomId: "room-b" }), { code: "INVALID_SCOPE" });
  const proxy = await l.connect({ id: "trusted-proxy" });
  assert.deepEqual(await proxy.call("leader", "room.get", { roomId: "room-b" }, { scopeRoomId: "room-b" }), { kind: "agent", id: "trusted-proxy", roomId: "room-b" });
  await assert.rejects(proxy.call("leader", "room.get", { roomId: "room-c" }, { scopeRoomId: "room-b" }), { code: "INVALID_SCOPE" });
  await assert.rejects(proxy.call("leader", "room.get", {}, { scopeRoomId: "../bad" }), { code: "INVALID_SCOPE" });
  assert.equal((await l.directory()).agents.some((a) => a.id === "member"), false);
});

test("only the selected leader connection can satisfy a pending request", async (t) => {
  const l = await lab(t);
  const incoming = deferred(), result = deferred();
  await l.connect({ id: "leader", mode: "runtime", leader: true, onRequest: (m) => { incoming.resolve(m); return result.promise; } });
  const attacker = await l.connect({ id: "other", mode: "runtime", leader: true });
  const member = await l.connect({ id: "member" });
  const call = member.call("leader", "room.get", {});
  const request = await incoming.promise;
  let settled = false; call.finally(() => { settled = true; });
  attacker.send({ type: "result", id: request.id, result: "forged" });
  await wait(30);
  assert.equal(settled, false);
  result.resolve("real");
  assert.equal(await call, "real");
});

test("offline and disconnected leaders fail explicitly, never resend", async (t) => {
  const l = await lab(t);
  const member = await l.connect({ id: "member" });
  await assert.rejects(member.call("missing", "room.get", {}), { code: "LEADER_OFFLINE" });
  const incoming = deferred(); let count = 0;
  const leader = await l.connect({ id: "leader", mode: "runtime", leader: true, onRequest: (m) => { count++; incoming.resolve(m); return new Promise(() => {}); } });
  const pending = assert.rejects(member.call("leader", "room.get", {}), { code: "LEADER_OFFLINE" });
  await incoming.promise;
  const closed = once(leader.ws, "close"); leader.close(); await closed;
  await pending;
  await leader.connect();
  await wait(30);
  assert.equal(count, 1);
});

test("client deadline returns unknown-outcome guidance without replaying the request", async (t) => {
  const l = await lab(t);
  let count = 0;
  await l.connect({ id: "leader", mode: "runtime", leader: true, onRequest: () => { count++; return new Promise(() => {}); } });
  const member = await l.connect({ id: "member", requestTimeoutMs: 40 });
  await assert.rejects(member.call("leader", "task.delegate", { requestId: "same-on-retry" }), { code: "TIMEOUT" });
  await wait(40);
  assert.equal(count, 1);
  assert.equal(member.pending.size, 0);
});

test("frame byte limit is enforced locally and at real Hub websocket ingress", async (t) => {
  const l = await lab(t);
  const a = await l.connect({ id: "a" });
  await assert.rejects(a.call("leader", "message.send", { text: "你".repeat(ROOM_FRAME_LIMIT / 2) }), { code: "FRAME_TOO_LARGE" });
  assert.equal(a.pending.size, 0);
  const closed = once(a.ws, "close");
  a.ws.send(JSON.stringify({ type: "ping", padding: "a".repeat(ROOM_FRAME_LIMIT) }));
  assert.equal((await closed)[0], 1009);
});

class Socket extends EventTarget {
  readyState = 1;
  messages = [];
  send(text) { this.messages.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const leaderMeta = { id: "leader", name: "leader", mode: "runtime", leader: true, capacity: 2 };

test("relay timeout drops pending state and ignores a late reply", async () => {
  const relay = new RoomRelay({ timeoutMs: 20 });
  const ws = new Socket();
  const c = relay.attach(ws, leaderMeta);
  await assert.rejects(relay.call("leader", { kind: "user", id: "u" }, "get", {}), { code: "LEADER_TIMEOUT" });
  assert.equal(relay.pending.size, 0);
  const request = ws.messages.find((m) => m.type === "request");
  await relay.receive(c, JSON.stringify({ type: "result", id: request.id, result: "late" }));
  assert.equal(ws.messages.filter((m) => m.type === "request").length, 1);
  relay.close();
});

test("async authorization/device lookup cannot bypass pending cap or dispatch after detach", async () => {
  const gate = deferred();
  const relay = new RoomRelay({ devices: () => gate.promise, timeoutMs: 1000 });
  const ws = new Socket(); relay.attach(ws, leaderMeta);
  const calls = Array.from({ length: 130 }, () => relay.call("leader", { kind: "user", id: "u" }, "get", {}).catch((e) => e.code));
  gate.resolve([]);
  await wait(0);
  assert.equal(relay.pending.size, 128);
  relay.close();
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r === "CAPACITY").length, 2);
  const later = deferred();
  const second = new RoomRelay({ devices: () => later.promise });
  const gone = new Socket(); second.attach(gone, leaderMeta);
  const rejected = assert.rejects(second.call("leader", { kind: "user", id: "u" }, "get", {}), { code: "LEADER_OFFLINE" });
  gone.close(); later.resolve([]); await rejected;
  assert.equal(gone.messages.filter((m) => m.type === "request").length, 0);
});

test("revoked authorization disconnects a previously accepted leader", async () => {
  let authorized = true;
  const relay = new RoomRelay({ authorize: async () => authorized });
  const ws = new Socket(); relay.attach(ws, leaderMeta, { credential: "temporary" });
  authorized = false;
  await assert.rejects(relay.call("leader", { kind: "user", id: "u" }, "get", {}), { code: "LEADER_OFFLINE" });
  assert.equal(relay.list().agents.length, 0);
});

test("invalid registration and malformed percent-encoded names are rejected", () => {
  assert.throws(() => relayRegistration(new Headers({ "x-room-agent-id": "../bad" })), { code: "INVALID_REGISTRATION" });
  assert.throws(() => relayRegistration(new Headers({ "x-room-agent-id": "ok", "x-room-agent-name": "%bad%" })), { code: "INVALID_REGISTRATION" });
});

test("concurrent connect on one client cannot create an orphan socket", async (t) => {
  const l = await lab(t);
  const c = new RoomConnection({ url: l.url, token: l.token, id: "single" });
  t.after(() => c.close());
  const first = c.connect();
  await assert.rejects(c.connect(), /already connecting/);
  await first;
  assert.equal((await l.directory()).agents.length, 1);
});

test("leader cannot inject an invalid HTTP status through its error reply", async (t) => {
  const l = await lab(t);
  await l.connect({ id: "leader", mode: "runtime", leader: true, onRequest: () => { throw Object.assign(new Error("rejected"), { status: -1 }); } });
  const response = await fetch(`${l.url}/v1/room-control`, {
    method: "POST", headers: { authorization: `Bearer ${l.token}`, "content-type": "application/json" },
    body: JSON.stringify({ leaderId: "leader", action: "room.get", input: {} }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "LEADER_ERROR");
  assert.equal((await l.directory()).status, 200);
});

test("stale open sockets lose identity ownership and pending work before reconnect", async () => {
  let now = 0;
  class HalfOpenSocket extends Socket {
    closeCalls = 0;
    close() { this.closeCalls++; /* no close event ever arrives */ }
  }
  const relay = new RoomRelay({ now: () => now, timeoutMs: 1000 });
  const old = new HalfOpenSocket();
  const oldConnection = relay.attach(old, leaderMeta);
  const pending = assert.rejects(relay.call("leader", { kind: "user", id: "owner" }, "rooms.list", {}), { code: "LEADER_OFFLINE" });
  await wait(0);
  assert.equal(relay.pending.size, 1);
  now = 45_001;
  const replacement = new Socket();
  relay.attach(replacement, leaderMeta);
  await pending;
  assert.equal(old.closeCalls, 1);
  assert.equal(old.readyState, 1);
  assert.equal(relay.connections.size, 1);
  assert.equal(relay.connections.has(oldConnection), false);
  const oldFrame = old.messages.find((entry) => entry.type === "request");
  await relay.receive(oldConnection, JSON.stringify({ type: "result", id: oldFrame.id, result: "late" }));
  assert.equal(relay.pending.size, 0);
  assert.equal(relay.list().agents.length, 1);
  assert.equal(replacement.messages.filter((entry) => entry.type === "request").length, 0);
  relay.close();
});

test("stale connections cannot occupy the entire live connection capacity", () => {
  let now = 0;
  const relay = new RoomRelay({ now: () => now });
  for (let i = 0; i < 128; i++) relay.attach(new Socket(), { ...leaderMeta, id: `agent-${i}` });
  now = 45_001;
  relay.attach(new Socket(), leaderMeta);
  assert.equal(relay.connections.size, 1);
  assert.deepEqual(relay.list().agents.map((entry) => entry.id), ["leader"]);
  relay.close();
});

test("closing during a real authorization fetch aborts its socket; authorization shares the connect deadline", async (t) => {
  const received = [], closed = [];
  const server = createServer((req, res) => {
    const index = received.length;
    received.push(req.url);
    const done = deferred(); closed[index] = done;
    res.on("close", done.resolve);
    // Deliberately never send challenge headers or a body.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const { raw: token } = await mintTokenV1({ aud: url });
  const client = new RoomConnection({ url, token, id: "closing", connectTimeoutMs: 2000 });
  t.after(() => client.close());
  const reject = assert.rejects(client.connect(), { code: "DISCONNECTED" });
  const deadline = Date.now() + 1500;
  while (!received.length && Date.now() < deadline) await wait(5);
  assert.equal(received.length, 1);
  client.close();
  await reject;
  await Promise.race([closed[0].promise, wait(1000).then(() => { throw new Error("Authorization fetch was not aborted"); })]);
  assert.equal(client.ws, undefined);
  const timed = new RoomConnection({ url, token, id: "timeout", connectTimeoutMs: 100 });
  t.after(() => timed.close());
  await assert.rejects(timed.connect(), { code: "CONNECT_TIMEOUT" });
  assert.equal(received.length, 2);
  await Promise.race([closed[1].promise, wait(1000).then(() => { throw new Error("Timed-out authorization fetch was not aborted"); })]);
  assert.equal(timed.ws, undefined);
});

async function socketServer(t, accept) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", accept);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("connect deadline includes websocket upgrade and waiting for ready", async (t) => {
  const accepted = deferred();
  const url = await socketServer(t, (ws) => accepted.resolve(ws));
  const client = new RoomConnection({ url, token: "local-test", id: "waiting", connectTimeoutMs: 50 });
  t.after(() => client.close());
  const rejection = assert.rejects(client.connect(), { code: "CONNECT_TIMEOUT" });
  const ws = await accepted.promise;
  const closed = once(ws, "close");
  await rejection; await closed;
  assert.equal(client.attempt.done, true);
});

test("missing pong terminates a half-open client, rejects pending once, and reconnect never replays", async (t) => {
  let respond = false;
  const calls = [];
  const url = await socketServer(t, (ws) => {
    ws.send(JSON.stringify({ type: "ready" }));
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "ping" && respond) ws.send(JSON.stringify({ type: "pong" }));
      if (message.type === "call") {
        calls.push(message);
        if (respond) ws.send(JSON.stringify({ type: "reply", id: message.id, result: "fresh" }));
      }
    });
  });
  let closes = 0;
  const client = new RoomConnection({ url, token: "local-test", id: "half-open", heartbeatIntervalMs: 10, pongTimeoutMs: 20, onClose: () => { closes++; } });
  t.after(() => client.close());
  await client.connect();
  const closed = once(client.ws, "close");
  await assert.rejects(client.call("leader", "tasks.delegate", { requestId: "uncertain" }), { code: "DISCONNECTED" });
  await closed;
  assert.equal(closes, 1);
  assert.equal(client.pending.size, 0);
  assert.equal(calls.length, 1);
  respond = true;
  await client.connect();
  await wait(60);
  assert.equal(client.ws.readyState, 1);
  assert.equal(closes, 1);
  assert.equal(calls.length, 1);
  assert.equal(await client.call("leader", "rooms.list", {}), "fresh");
  assert.equal(calls.length, 2);
});
