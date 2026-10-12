import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRoomTools, ROOM_TOOLS, stableRoomIdentity } from "./room-client.mjs";

const temporary = (t) => { const directory = mkdtempSync(join(tmpdir(), "fleet-mcp-room-")); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
function fixture(t, overrides = {}) {
  const calls = [];
  const registrations = [];
  class FakeConnection {
    constructor(options) { this.options = options; registrations.push(options); }
    async connect() { return this; }
    async call(...args) { calls.push(args); return { ok: true, agents: [] }; }
    close() { this.closed = true; }
  }
  const directory = temporary(t);
  const client = createRoomTools({ url: "https://fleet.test", token: "test-token-never-persist", env: {}, host: "machine", directory, loadConnection: async () => FakeConnection, warn: () => {}, ...overrides });
  t.after(() => client.shutdown());
  return { client, calls, registrations, directory };
}

test("stable identity varies by client and Hub while storing no credentials or Room content", (t) => {
  const directory = temporary(t);
  const options = { env: {}, directory, host: "machine", url: "https://fleet.test", clientName: "codex" };
  const first = stableRoomIdentity(options);
  assert.deepEqual(stableRoomIdentity(options), first);
  assert.notEqual(stableRoomIdentity({ ...options, clientName: "grok" }).id, first.id);
  assert.notEqual(stableRoomIdentity({ ...options, url: "https://another.test" }).id, first.id);
  assert.equal(first.name, "machine-codex");
  const filename = join(directory, "room-identity.json");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(filename, "utf8"))).sort(), ["seed", "version"]);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["room-identity.json"]);
});

test("explicit environment identity can share a runtime ID without changing MCP capability", async (t) => {
  const { client, registrations, directory } = fixture(t, { env: { FLEET_AGENT_ID: "leader-a", FLEET_AGENT_NAME: "Configured Agent" } });
  client.initialize({ name: "codex" });
  const list = await client.callTool("fleet_agents");
  assert.equal(list.self.id, "leader-a");
  assert.equal(list.self.callable, false);
  assert.equal(registrations[0].mode, "mcp");
  assert.equal(registrations[0].leader, false);
  assert.deepEqual(readdirSync(directory), []);
});

test("initialize returns immediately while registration is pending and one connection is shared", async (t) => {
  let release;
  let count = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const { client } = fixture(t, { loadConnection: async () => class {
    constructor() { count++; }
    connect() { return gate; }
    async call() { return { agents: [] }; }
    close() {}
  } });
  assert.equal(client.initialize({ name: "codex" }), undefined);
  client.initialize({ name: "ignored-second-name" });
  const one = client.callTool("fleet_agents");
  const two = client.callTool("fleet_agents");
  release();
  assert.equal((await one).self.name, "machine-codex");
  await two;
  assert.equal(count, 1);
});

test("Room tools reject caller identity/permission injection before network access", async (t) => {
  const { client, calls, registrations } = fixture(t);
  for (const field of ["principal", "kind", "canCreateRooms", "token", "role"]) {
    await assert.rejects(client.callTool("room_list", { leaderId: "lead", [field]: "user" }), /Unexpected field/);
  }
  await assert.rejects(client.callTool("room_list", { leaderId: "bad/path" }), /Invalid leaderId/);
  await assert.rejects(client.callTool("room_send", { leaderId: "lead", roomId: "room", requestId: "send", text: "no revision" }), /expectedContextRev/);
  assert.equal(calls.length, 0);
  assert.equal(registrations.length, 0);
});

test("tool routing preserves request IDs and uses Agent WebSocket commands exclusively", async (t) => {
  const { client, calls, directory } = fixture(t);
  await client.callTool("room_create", { leaderId: "lead", id: "room", defaultDeviceId: "device" });
  await client.callTool("room_invite", { leaderId: "lead", roomId: "room", agentId: "member" });
  const body = { leaderId: "lead", roomId: "room", requestId: "send", expectedContextRev: 0, text: "private-room-text", toAgentId: "member" };
  await client.callTool("room_send", body);
  await client.callTool("room_send", body);
  await client.callTool("room_read", { leaderId: "lead", roomId: "room", afterSeq: 2 });
  await client.callTool("room_delegate", { leaderId: "lead", roomId: "room", requestId: "task", assigneeId: "member", sessionId: "session", description: "private-task-text", completionCriteria: "done" });
  await client.callTool("room_task", { leaderId: "lead", roomId: "room", taskId: "task" });
  await client.callTool("room_task", { leaderId: "lead", roomId: "room", assigneeId: "member", status: "queued" });
  await client.callTool("room_cancel", { leaderId: "lead", roomId: "room", taskId: "task", requestId: "cancel" });
  assert.deepEqual(calls[0], ["lead", "rooms.create", { id: "room", defaultDeviceId: "device", leaderId: "lead" }]);
  assert.deepEqual(calls[2], calls[3]);
  assert.equal(calls[2][2].discussionId, "main");
  assert.equal(calls[6][1], "tasks.get");
  assert.equal(calls[7][1], "tasks.list");
  assert.equal(calls[8][1], "tasks.cancel");
  assert.equal(readdirSync(directory).length, 1);
  assert.doesNotMatch(readFileSync(join(directory, "room-identity.json"), "utf8"), /private|test-token/);
});

test("cancelling an MCP call does not falsely mark the remote task stopped", async (t) => {
  const remote = [];
  let resolve;
  const { client } = fixture(t, { loadConnection: async () => class {
    async connect() {}
    call(...args) { remote.push(args); return new Promise((done) => { resolve = done; }); }
    close() {}
  } });
  const controller = new AbortController();
  const pending = client.callTool("room_cancel", { leaderId: "lead", roomId: "room", taskId: "task", requestId: "cancel" }, { signal: controller.signal });
  await new Promise((done) => setImmediate(done));
  controller.abort();
  await assert.rejects(pending, /outcome may be unknown/);
  resolve({ task: { status: "cancel_requested" } });
  assert.equal(remote.length, 1);
  assert.equal(remote[0][1], "tasks.cancel");
});

test("all Room tool schemas disallow extra fields and task detail cannot mix list filters", async (t) => {
  for (const tool of ROOM_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(new Set(ROOM_TOOLS.map((tool) => tool.name)).size, 9);
  const { client } = fixture(t);
  await assert.rejects(client.callTool("room_task", { leaderId: "lead", roomId: "room", taskId: "task", status: "queued" }), /cannot be mixed/);
});

test("stdio initialize and existing tools still work when Room registration is unavailable", (t) => {
  const directory = temporary(t);
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "compatibility-test" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
    input, encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: directory, FLEET_URL: "http://127.0.0.1:1", FLEET_TOKEN: "invalid-test-token", FLEET_AGENT_ID: "compatibility-test" },
  });
  const messages = output.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "fleet");
  const names = messages[1].result.tools.map((tool) => tool.name);
  assert.ok(names.includes("list_computers"));
  assert.ok(names.includes("room_send"));
});
