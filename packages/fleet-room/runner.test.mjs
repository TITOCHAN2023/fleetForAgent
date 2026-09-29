import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, chmodSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import http from "node:http";
import { createHub } from "../fleet-hub/index.mjs";
import { RoomRunner } from "./runner.mjs";
import { RoomConnection } from "./client.mjs";

const fixture = fileURLToPath(new URL("./tests/fixtures/runner-acp.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 7000) {
  const end = Date.now() + timeout; let result;
  while (Date.now() < end) { result = await read(); if (predicate(result)) return result; await pause(20); }
  assert.fail(`Condition not met: ${JSON.stringify(result)}`);
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "fleet-room-runner-"));
  const token = "runner-local-only-credential";
  const hub = createHub({ token });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  const device = new WebSocket(url.replace("http:", "ws:") + "/v1/device", { headers: { authorization: `Bearer ${token}`, "x-device-id": "device-a" } });
  await once(device, "open");
  const runners = [];
  const stateDirs = [];
  const state = () => { const dir = mkdtempSync("/dev/shm/fleet-room-cli-test-"); stateDirs.push(dir); return dir; };
  const config = (id, leader = false, extra = {}) => ({ id, leader, url, token, fleetHome: join(root, "fleet-home"), dataDir: join(root, id), cwd: root,
    command: process.execPath, args: [fixture], pollMs: 20, renewMs: 100, leaseMs: 1000, cancelTimeoutMs: 200,
    ...(leader ? {} : { cliStateDir: state() }), ...extra });
  const start = async (config) => { const r = new RoomRunner(config); runners.push(r); await r.start(); return r; };
  t.after(async () => { for (const r of [...runners].reverse()) await r.stop(); device.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true }); });
  const leader = await start(config("leader", true));
  const follower = await start(config("follower"));
  async function owner(action, input = {}) {
    const response = await fetch(`${url}/v1/room-control`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ leaderId: "leader", action, input }) });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error), { code: body.code });
    return body;
  }
  await owner("rooms.create", { id: "room-a", leaderId: "leader", defaultDeviceId: "device-a", name: "Test room" });
  await owner("rooms.invite", { roomId: "room-a", agentId: "follower" });
  const get = (id) => owner("tasks.get", { roomId: "room-a", taskId: id });
  const delegate = async (description, id = randomUUID()) => {
    await owner("tasks.delegate", { roomId: "room-a", requestId: id, assigneeId: "follower", sessionId: id, description, completionCriteria: "Return the fixture result" });
    return id;
  };
  return { root, hub, leader, follower, owner, config, start, get, delegate, url, token, state };
}

test("real Hub and two runners complete a task; only leader creates a ledger", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const id = await l.delegate("CHECK_TOOLS");
  const { task } = await until(() => l.get(id), ({ task }) => ["completed", "failed"].includes(task.status));
  assert.equal(task.status, "completed"); assert.equal(task.result, "TOOLS_SCOPED");
  assert.equal(existsSync(join(l.root, "leader", "room.sqlite")), true);
  assert.equal(existsSync(join(l.root, "follower")), false);
  assert.equal(l.follower.storage, undefined);
  const child = l.follower.session();
  assert.equal(child.env.GROK_HOME, join(l.follower.config.cliStateDir, "grok"));
  assert.equal(child.env.CODEX_HOME, join(l.follower.config.cliStateDir, "codex"));
  assert.equal(child.env.HOME, process.env.HOME);
  assert.equal((await l.leader.storage.transaction((tx) => tx.list({ prefix: "execution:" }))).size, 0);
});

test("message wakeup reads every history page and publishes its contextual reply", { timeout: 20000 }, async (t) => {
  const l = await setup(t);
  let revision = 0;
  for (let i = 0; i < 105; i++) {
    const result = await l.owner("messages.send", { roomId: "room-a", discussionId: "main", requestId: randomUUID(), expectedContextRev: revision,
      text: i === 0 ? "HISTORY_FIRST" : i === 104 ? "HISTORY_LAST" : `history ${i}` });
    revision = result.contextRev;
  }
  const wake = await l.owner("messages.send", { roomId: "room-a", discussionId: "main", requestId: randomUUID(), expectedContextRev: revision, text: "CHECK_CONTEXT", toAgentId: "follower" });
  const { task } = await until(() => l.get(wake.task.id), ({ task }) => ["completed", "failed"].includes(task.status));
  assert.equal(task.result, "CONTEXT_COMPLETE");
  const page = await l.owner("messages.read", { roomId: "room-a", discussionId: "main", afterSeq: 105 });
  assert.equal(page.messages.at(-1).text, "CONTEXT_COMPLETE");
});

test("pause and explicit cancel stop the ACP turn and receive a confirmed stop", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  let starts = 0;
  for (const action of ["rooms.pause", "tasks.cancel"]) {
    const id = await l.delegate("CANCEL_WAIT");
    await until(() => l.get(id), ({ task }) => task.status === "running");
    await until(() => l.owner("messages.read", { roomId: "room-a", discussionId: "main" }), ({ messages }) => messages.filter((m) => m.text.startsWith("ACP_STARTED_")).length > starts);
    starts++;
    await l.owner(action, { roomId: "room-a", ...(action === "tasks.cancel" ? { taskId: id, requestId: randomUUID() } : {}) });
    const { task } = await until(() => l.get(id), ({ task }) => task.status === "cancelled");
    assert.equal(task.executionEpoch, 1);
    if (action === "rooms.pause") await l.owner("rooms.resume", { roomId: "room-a" });
  }
  await until(async () => l.follower.active.size, (n) => n === 0);
});

test("parent resumes with complete child results when summaries are truncated", { timeout: 20000 }, async (t) => {
  const l = await setup(t);
  const id = await l.delegate("DELEGATE_THREE");
  const { task, children } = await until(() => l.get(id), ({ task }) => ["completed", "failed"].includes(task.status), 12000);
  assert.equal(task.result, "PARENT_RESUME_OK");
  assert.equal(task.executionEpoch, 2);
  assert.equal(children.length, 3);
  assert.equal(children.some((c) => c.resultTruncated), true);
});

test("leader disconnect aborts follower and restart never replays an unknown execution", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const id = await l.delegate("CANCEL_WAIT");
  await until(() => l.get(id), ({ task }) => task.status === "running");
  await until(() => l.owner("messages.read", { roomId: "room-a", discussionId: "main" }), ({ messages }) => messages.some((m) => m.text.startsWith("ACP_STARTED_")));
  await l.leader.stop();
  await until(async () => l.follower.active.size, (n) => n === 0);
  await pause(1100);
  await l.start(l.config("leader", true));
  const { task } = await until(() => l.get(id), ({ task }) => task.status === "unknown");
  assert.equal(task.executionEpoch, 1);
  await pause(250);
  assert.equal((await l.get(id)).task.executionEpoch, 1);
  assert.equal(l.follower.active.size, 0);
});

test("leader ledger refuses a changed Hub, identity or credential binding", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  await l.leader.stop();
  for (const change of [{ url: "http://127.0.0.1:1" }, { id: "other" }, { token: "different-account" }]) {
    const bad = new RoomRunner(l.config("leader", true, change));
    await assert.rejects(bad.start(), { code: "LEDGER_BINDING_MISMATCH" });
    await bad.stop();
  }
  const resumed = await l.start(l.config("leader", true));
  assert.equal((await l.owner("rooms.get", { roomId: "room-a" })).room.id, "room-a");
  assert.ok(resumed.storage);
});

test("MCP to runtime registration change uses the state machine conflict code", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const mcp = new RoomConnection({ url: l.url, token: l.token, id: "later", mode: "mcp" });
  t.after(() => mcp.close()); await mcp.connect();
  assert.equal((await l.owner("agents.list")).agents.find((a) => a.id === "later").mode, "mcp");
  const runtime = await l.start(l.config("later"));
  assert.equal((await l.owner("agents.list")).agents.find((a) => a.id === "later").mode, "runtime");
  assert.equal(runtime.storage, undefined);
});

test("revocation after claim is rechecked before starting an ACP process", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const originalPermit = l.follower.executionPermit.bind(l.follower);
  l.follower.executionPermit = async (...args) => {
    await l.owner("rooms.pause", { roomId: "room-a" });
    return originalPermit(...args);
  };
  let opened = 0;
  const originalSession = l.follower.session.bind(l.follower);
  l.follower.session = (...args) => { opened++; return originalSession(...args); };
  const id = await l.delegate("must not execute");
  await until(() => l.get(id), ({ task }) => task.status === "cancelled");
  assert.equal(opened, 0);
});

test("follower CLI state fails closed unless owned private exclusive tmpfs", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const shared = l.state(); chmodSync(shared, 0o755);
  const linkRoot = l.state(); symlinkSync(l.follower.config.cliStateDir, join(linkRoot, "alias"));
  for (const [cliStateDir, code] of [[undefined, "CLI_STATE_REQUIRED"], [l.root, "CLI_STATE_TMPFS"],
    [shared, "CLI_STATE_PRIVATE"], [join(linkRoot, "alias"), "CLI_STATE_PRIVATE"], [l.follower.config.cliStateDir, "CLI_STATE_IN_USE"]]) {
    const invalid = new RoomRunner(l.config("rejected", false, { cliStateDir }));
    await assert.rejects(invalid.start(), { code });
    await invalid.stop();
  }
});

test("eight queued tasks behind an unknown session cannot starve the next independent session", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  l.follower.stopping = true; await l.follower.loop;
  const queue = (requestId, sessionId) => l.owner("tasks.delegate", { roomId: "room-a", requestId, assigneeId: "follower", sessionId, description: "Complete independently", completionCriteria: "Return result" });
  await queue("old-execution", "locked-session");
  await l.follower.call("leader", "tasks.claim", { roomId: "room-a", taskId: "old-execution", requestId: randomUUID(), leaseMs: 1000 }, "room-a");
  await pause(1100);
  assert.equal((await l.get("old-execution")).task.status, "unknown");
  for (let i = 0; i < 8; i++) await queue(`blocked-0${i}`, "locked-session");
  await queue("free-09", "independent-session");
  l.follower.stopping = false; l.follower.loop = l.follower.poll();
  const { task } = await until(() => l.get("free-09"), ({ task }) => task.status === "completed");
  assert.equal(task.result, "TASK_COMPLETE");
  assert.equal((await l.get("blocked-00")).task.status, "queued");
});

test("loopback tool preserves Chinese text split between HTTP body chunks", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const id = await l.delegate("CANCEL_WAIT");
  await until(() => l.owner("messages.read", { roomId: "room-a", discussionId: "main" }), ({ messages }) => messages.some((m) => m.text.startsWith("ACP_STARTED_")));
  const [capability] = [...l.follower.capabilities.keys()];
  const { contextRev } = await l.owner("messages.read", { roomId: "room-a", discussionId: "main" });
  const payload = Buffer.from(JSON.stringify({ name: "room_send", arguments: { text: "中文跨帧保持完整", expectedContextRev: contextRev } }));
  const split = payload.indexOf(Buffer.from("中")) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${l.follower.ipcUrl}/tool`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", reject); req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 15);
  });
  assert.equal(response.result.message.text, "中文跨帧保持完整");
  await l.owner("tasks.cancel", { roomId: "room-a", taskId: id, requestId: randomUUID() });
  await until(() => l.get(id), ({ task }) => task.status === "cancelled");
});

test("cancel revokes a captured capability and joins an already accepted tool before stopped receipt", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  const id = await l.delegate("CANCEL_WAIT");
  await until(() => l.owner("messages.read", { roomId: "room-a", discussionId: "main" }), ({ messages }) => messages.some((m) => m.text.startsWith("ACP_STARTED_")));
  const [capability, ctx] = [...l.follower.capabilities.entries()][0];
  const { contextRev } = await l.owner("messages.read", { roomId: "room-a", discussionId: "main" });
  const payload = JSON.stringify({ name: "room_send", arguments: { text: "LATE_WRITE_MUST_NOT_EXIST", expectedContextRev: contextRev } });
  let req;
  const reply = new Promise((resolve, reject) => {
    req = http.request(`${l.follower.ipcUrl}/tool`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject); req.write(payload.slice(0, 10));
  });
  await until(async () => ctx.pending.size, (n) => n > 0);
  await l.owner("tasks.cancel", { roomId: "room-a", taskId: id, requestId: randomUUID() });
  await until(async () => l.follower.capabilities.size, (n) => n === 0);
  assert.equal((await l.get(id)).task.status, "cancel_requested");
  req.end(payload.slice(10));
  assert.equal((await reply).code, "execution_permit_revoked");
  await until(() => l.get(id), ({ task }) => task.status === "cancelled");
  assert.equal((await l.owner("messages.read", { roomId: "room-a", discussionId: "main" })).messages.some((m) => m.text === "LATE_WRITE_MUST_NOT_EXIST"), false);
  const stale = await fetch(`${l.follower.ipcUrl}/tool`, { method: "POST", headers: { authorization: `Bearer ${capability}` }, body: payload });
  assert.equal(stale.status, 403);
});


test("leader local history remains readable after Hub disconnect; follower publishes nothing", { timeout: 15000 }, async (t) => {
  const l = await setup(t);
  await l.owner("messages.send", { roomId: "room-a", discussionId: "main", requestId: "offline-message", expectedContextRev: 0, text: "Hub 离线仍可查看" });
  const directory = join(l.root, "fleet-home", "rooms");
  assert.deepEqual(readdirSync(directory), ["leader.json"]);
  const descriptor = JSON.parse(readFileSync(join(directory, "leader.json")));
  // Stop the network polling and close the real Hub, keeping the local ledger open.
  l.leader.stopping = true; l.follower.stopping = true;
  await Promise.all([l.leader.loop, l.follower.loop]);
  l.leader.connection.close(); l.follower.connection.close();
  await l.hub.close();
  const response = await fetch(descriptor.url + "/messages?roomId=room-a&discussionId=main", { headers: { authorization: `Bearer ${descriptor.readCapability}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages[0].text, "Hub 离线仍可查看");
  await l.leader.stop();
  assert.equal(existsSync(join(directory, "leader.json")), false);
});
