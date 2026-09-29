import assert from "node:assert/strict";
import test from "node:test";
import { roomControl, RoomControlError } from "./src/room-control.mjs";

// Transactions serialize concurrent calls and commit a cloned snapshot only
// on success. Writes outside the transaction fail the test immediately.
class MemoryStorage {
  rows = new Map();
  pending = Promise.resolve();
  async get(key) { return structuredClone(this.rows.get(key)); }
  async list({ prefix }) { return new Map([...this.rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
  async put() { assert.fail("write outside transaction"); }
  async delete() { assert.fail("delete outside transaction"); }
  transaction(fn) {
    const operation = this.pending.then(async () => {
      const rows = structuredClone(this.rows);
      const result = await fn({
        get: async (key) => structuredClone(rows.get(key)),
        put: async (key, value) => { rows.set(key, structuredClone(value)); },
        delete: async (key) => rows.delete(key),
        list: async ({ prefix }) => new Map([...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])),
      });
      this.rows = rows;
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

const user = { kind: "user", id: "owner" };
const agent = (id, roomId) => ({ kind: "agent", id, ...(roomId ? { roomId } : {}) });
const error = (code, status) => (err) => err instanceof RoomControlError && err.code === code && err.status === status;

async function fixture() {
  const storage = new MemoryStorage();
  const call = (principal, action, input = {}, now = 100_000) => roomControl(storage, principal, action, input, now);
  for (const id of ["lead", "a", "b", "c", "d", "e", "outsider"]) {
    await call(user, "agents.register", { id, name: id, mode: "runtime" });
  }
  await call(user, "rooms.create", { id: "room", leaderId: "lead", defaultDeviceId: "linux" });
  return { storage, call };
}

test("parallel fifth and sixth invitations enforce one atomic membership limit", async () => {
  const { call } = await fixture();
  for (const agentId of ["a", "b", "c"]) await call(agent("lead"), "rooms.invite", { roomId: "room", agentId });
  const results = await Promise.allSettled(["d", "e"].map((agentId) => call(agent("lead"), "rooms.invite", { roomId: "room", agentId })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(error("member_limit", 409)(results.find((result) => result.status === "rejected").reason));
  const { room } = await call(user, "rooms.get", { roomId: "room" });
  assert.equal(room.memberIds.length, 5);
  assert.equal(room.membershipVersion, 5);
});

test("room-scoped Agents cannot create rooms even with global owner-granted permissions", async () => {
  const { call } = await fixture();
  await call(user, "agents.configure", { agentId: "a", canCreateRooms: true });
  await call(user, "rooms.invite", { roomId: "room", agentId: "a" });
  await assert.rejects(call(agent("a", "room"), "rooms.create", { id: "child", leaderId: "a", defaultDeviceId: "linux" }), error("forbidden", 403));
  await assert.rejects(call(agent("a"), "rooms.create", { id: "child", leaderId: "lead", defaultDeviceId: "linux" }), error("forbidden", 403));
  assert.equal((await call(agent("a"), "rooms.create", { id: "own", leaderId: "a", defaultDeviceId: "linux" })).room.leaderId, "a");
});

test("room authorization applies to reads and each mutation; scope cannot escape", async () => {
  const { call } = await fixture();
  await call(user, "rooms.invite", { roomId: "room", agentId: "a" });
  await call(user, "rooms.create", { id: "other", leaderId: "a", defaultDeviceId: "mac" });
  assert.deepEqual((await call(agent("outsider"), "rooms.list")).rooms, []);
  await assert.rejects(call(agent("outsider"), "rooms.get", { roomId: "room" }), error("room_not_found", 404));
  await assert.rejects(call(agent("a", "room"), "rooms.get", { roomId: "other" }), error("room_not_found", 404));
  await assert.rejects(call(agent("a"), "rooms.invite", { roomId: "room", agentId: "b" }), error("forbidden", 403));
  const scoped = await call(agent("a", "room"), "agents.list");
  assert.deepEqual(scoped.agents.map((entry) => entry.id), ["lead", "a"]);
  await call(user, "rooms.remove", { roomId: "room", agentId: "a" });
  await assert.rejects(call(agent("a", "room"), "agents.heartbeat"), error("room_not_found", 404));
});

test("registration is idempotent and preserves owner-granted permissions and capacity", async () => {
  const { call } = await fixture();
  await call(user, "agents.configure", { agentId: "a", canCreateRooms: true, capacity: 4 });
  const { agent: registered } = await call(user, "agents.register", { id: "a", name: "a", mode: "runtime" });
  assert.equal(registered.canCreateRooms, true);
  assert.equal(registered.capacity, 4);
  await assert.rejects(call(user, "agents.register", { id: "a", name: "replacement" }), error("agent_conflict", 409));
  await assert.rejects(call(agent("a"), "agents.register", { id: "new" }), error("forbidden", 403));
  await assert.rejects(call(agent("a"), "agents.configure", { agentId: "a", canCreateRooms: true }), error("forbidden", 403));
});

test("MCP heartbeat never becomes callable and runtime heartbeat expires after 60s", async () => {
  const { call } = await fixture();
  await call(user, "agents.register", { id: "mcp" });
  const { agent: mcp } = await call(agent("mcp"), "agents.heartbeat");
  assert.equal(mcp.online, true);
  assert.equal(mcp.callable, false);
  assert.equal((await call(agent("a"), "agents.heartbeat")).agent.callable, true);
  const before = await call(user, "agents.list", {}, 159_999);
  const after = await call(user, "agents.list", {}, 160_000);
  assert.equal(before.agents.find((entry) => entry.id === "a").callable, true);
  assert.equal(after.agents.find((entry) => entry.id === "a").online, false);
  await assert.rejects(call(agent("a"), "agents.heartbeat", { capacity: 8 }), error("invalid_input", 400));
  await assert.rejects(call(agent("a"), "agents.heartbeat", { agentId: "b" }), error("invalid_input", 400));
});

test("default device changes serialize with optimistic config version", async () => {
  const { call } = await fixture();
  const results = await Promise.allSettled(["mac", "windows"].map((defaultDeviceId) => call(user, "rooms.device", { roomId: "room", defaultDeviceId, expectedConfigVersion: 1 })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(error("config_conflict", 409)(results.find((result) => result.status === "rejected").reason));
  assert.equal((await call(user, "rooms.get", { roomId: "room" })).room.configVersion, 2);
});

test("leader replacement is explicit and removed principals lose control", async () => {
  const { call } = await fixture();
  await assert.rejects(call(user, "rooms.remove", { roomId: "room", agentId: "lead" }), error("leader_required", 409));
  await call(user, "rooms.invite", { roomId: "room", agentId: "a" });
  const { room } = await call(user, "rooms.remove", { roomId: "room", agentId: "lead", newLeaderId: "a" });
  assert.equal(room.leaderId, "a");
  assert.equal(room.controlEpoch, 2);
  await assert.rejects(call(agent("lead"), "rooms.pause", { roomId: "room" }), error("room_not_found", 404));
  const pause = await call(agent("a"), "rooms.pause", { roomId: "room" });
  const repeat = await call(agent("a"), "rooms.pause", { roomId: "room" });
  assert.equal(pause.room.controlEpoch, 3);
  assert.equal(repeat.room.controlEpoch, 3);
  assert.equal((await call(agent("a"), "rooms.resume", { roomId: "room" })).room.controlEpoch, 4);
});

test("account storage isolation and explicit registry projection prevent data disclosure", async () => {
  const { storage, call } = await fixture();
  const row = storage.rows.get("room-control:agent:a");
  storage.rows.set("room-control:agent:a", { ...row, secret: "never expose", token: "private" });
  assert.equal(JSON.stringify(await call(user, "agents.list")).includes("private"), false);
  assert.deepEqual(await roomControl(new MemoryStorage(), user, "agents.list"), { agents: [] });
  await assert.rejects(call(user, "rooms.create", { id: "escape/room", leaderId: "lead", defaultDeviceId: "linux" }), error("invalid_input", 400));
  await assert.rejects(call(user, "agents.configure", { agentId: "a", capacity: 9 }), error("invalid_input", 400));
});

test("account room limit remains atomic under concurrent creates", async () => {
  const { call } = await fixture();
  for (let i = 1; i < 31; i++) await call(user, "rooms.create", { id: `room-${i}`, leaderId: "lead", defaultDeviceId: "linux" });
  const results = await Promise.allSettled(["last", "overflow"].map((id) => call(user, "rooms.create", { id, leaderId: "lead", defaultDeviceId: "linux" })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(error("room_limit", 409)(results.find((result) => result.status === "rejected").reason));
});

async function taskFixture() {
  const context = await fixture();
  for (const agentId of ["a", "b"]) {
    await context.call(user, "rooms.invite", { roomId: "room", agentId });
    await context.call(agent(agentId), "agents.heartbeat");
  }
  await context.call(agent("lead"), "agents.heartbeat");
  const delegate = (requestId, options = {}, principal = user) => context.call(principal, "tasks.delegate", {
    roomId: "room", requestId, assigneeId: "a", sessionId: "session-a",
    description: "Implement the change", completionCriteria: "Relevant tests pass", ...options,
  });
  return { ...context, delegate };
}

test("message CAS rejects simultaneous stale answers, while exact retries precede version checks", async () => {
  const { call } = await taskFixture();
  const body = { roomId: "room", discussionId: "main", requestId: "message-a", expectedContextRev: 0, text: "first" };
  const results = await Promise.allSettled([
    call(agent("a"), "messages.send", body),
    call(agent("b"), "messages.send", { ...body, requestId: "message-b", text: "second" }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.ok(error("context_conflict", 409)(results.find((entry) => entry.status === "rejected").reason));
  assert.deepEqual(await call(agent("a"), "messages.send", body), results[0].value);
  await assert.rejects(call(agent("a"), "messages.send", { ...body, text: "altered" }), error("idempotency_conflict", 409));
  await assert.rejects(call(agent("outsider"), "messages.read", { roomId: "room", discussionId: "main" }), error("room_not_found", 404));
  const history = await call(user, "messages.read", { roomId: "room", discussionId: "main" });
  assert.equal(history.messages.length, 1);
  assert.equal(history.contextRev, 1);
});

test("message pagination stays below frame budget and preserves all history", async () => {
  const { call } = await taskFixture();
  for (let i = 0; i < 5; i++) await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: `large-${i}`, expectedContextRev: i, text: "x".repeat(16_384) });
  const first = await call(user, "messages.read", { roomId: "room", discussionId: "main" });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 64 * 1024);
  assert.equal(first.hasMore, true);
  const next = await call(user, "messages.read", { roomId: "room", discussionId: "main", afterSeq: first.nextCursor });
  assert.equal(next.messages[0].seq, first.nextCursor + 1);
  await assert.rejects(call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "oversize", expectedContextRev: 5, text: "中".repeat(6000) }), error("invalid_input", 400));
});

test("directed messages atomically queue a task; ordinary broadcast never wakes an Agent", async () => {
  const { call } = await taskFixture();
  const broadcast = await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "broadcast", expectedContextRev: 0, text: "FYI" });
  assert.equal(broadcast.task, undefined);
  const directed = await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "wake", expectedContextRev: 1, text: "Review this", toAgentId: "a" });
  assert.equal(directed.task.id, "msg_wake");
  assert.equal(directed.task.kind, "message");
  assert.equal(directed.task.sessionId, "room");
  await call(user, "agents.configure", { agentId: "b", mode: "mcp" });
  await assert.rejects(call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "no-mcp", expectedContextRev: 2, text: "Cannot wake", toAgentId: "b" }), error("agent_not_callable", 409));
  assert.equal((await call(user, "messages.read", { roomId: "room", discussionId: "main" })).contextRev, 2);
  assert.equal((await call(user, "tasks.list", { roomId: "room" })).tasks.length, 1);
});

test("message task completion publishes a version-checked reply, never an old answer", async () => {
  const { call } = await taskFixture();
  await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "ask", expectedContextRev: 0, text: "Review", toAgentId: "a" });
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "msg_ask", requestId: "claim" });
  await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "followup", expectedContextRev: 1, text: "New requirement" });
  const complete = { roomId: "room", taskId: "msg_ask", requestId: "done", executionEpoch: 1, expectedContextRev: 1, result: "Old response" };
  await assert.rejects(call(agent("a"), "tasks.complete", complete), error("context_conflict", 409));
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "msg_ask" })).task.status, "running");
  const done = await call(agent("a"), "tasks.complete", { ...complete, expectedContextRev: 2, result: "Revised response" });
  assert.equal(done.task.status, "completed");
  assert.equal(done.contextRev, 3);
  assert.equal(done.message.toAgentId, null);
});

test("claims are exclusive and session ownership survives lease expiry until confirmed stop", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("task-a");
  const claims = await Promise.allSettled(["claim-a", "claim-b"].map((requestId) => call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task-a", requestId, leaseMs: 1000 })));
  assert.equal(claims.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.ok(error("task_state_conflict", 409)(claims.find((entry) => entry.status === "rejected").reason));
  await delegate("task-b");
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "task-a" }, 101_001)).task.status, "unknown");
  await assert.rejects(call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task-b", requestId: "blocked" }, 101_001), error("session_busy", 409));
  await assert.rejects(call(agent("a"), "tasks.renew", { roomId: "room", taskId: "task-a", requestId: "late-renew", executionEpoch: 1, renewalSeq: 1 }, 101_001), error("task_state_conflict", 409));
  await call(agent("a"), "tasks.stopped", { roomId: "room", taskId: "task-a", requestId: "stopped", executionEpoch: 1, outcome: "requeue" }, 101_001);
  const newer = await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task-a", requestId: "new-claim" }, 101_001);
  assert.equal(newer.task.executionEpoch, 2);
  await assert.rejects(call(agent("a"), "tasks.complete", { roomId: "room", taskId: "task-a", requestId: "old-complete", executionEpoch: 1, result: "stale" }, 101_001), error("execution_conflict", 409));
});

test("Agent capacity applies across Rooms and independent sessions", async () => {
  const { call, delegate } = await taskFixture();
  await call(user, "agents.configure", { agentId: "a", capacity: 1 });
  await delegate("first");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "first", requestId: "claim-first" });
  await call(user, "rooms.create", { id: "other", leaderId: "a", defaultDeviceId: "mac" });
  await delegate("second", { roomId: "other", sessionId: "independent" });
  await assert.rejects(call(agent("a"), "tasks.claim", { roomId: "other", taskId: "second", requestId: "claim-second" }), error("capacity_exceeded", 409));
  await call(agent("a"), "tasks.complete", { roomId: "room", taskId: "first", requestId: "done-first", executionEpoch: 1, result: "done" });
  assert.equal((await call(agent("a"), "tasks.claim", { roomId: "other", taskId: "second", requestId: "claim-second" })).task.status, "running");
});

test("device snapshot is immutable and child tasks inherit the parent's resolved target", async () => {
  const { call, delegate } = await taskFixture();
  const [before] = await Promise.all([
    delegate("before"),
    call(user, "rooms.device", { roomId: "room", defaultDeviceId: "mac", expectedConfigVersion: 1 }),
  ]);
  assert.equal(before.task.resolvedDeviceId, "linux");
  assert.equal((await delegate("after")).task.resolvedDeviceId, "mac");
  const child = await delegate("child", { parentTaskId: "before", assigneeId: "b" }, agent("a", "room"));
  assert.equal(child.task.resolvedDeviceId, "linux");
  assert.equal(child.task.deviceSource, "parent");
  assert.equal(child.task.configVersion, 1);
  const override = await delegate("override", { parentTaskId: "before", deviceId: "explicit-device" }, agent("a"));
  assert.equal(override.task.resolvedDeviceId, "explicit-device");
  assert.equal(override.task.deviceSource, "explicit");
});

test("cancel and completion obey transaction order and cancellation only follows descendants", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("parent");
  await delegate("child", { parentTaskId: "parent", assigneeId: "b" });
  await delegate("unrelated", { sessionId: "different" });
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "claim" });
  const [cancelled, completed] = await Promise.allSettled([
    call(user, "tasks.cancel", { roomId: "room", taskId: "parent", requestId: "cancel" }),
    call(agent("a"), "tasks.complete", { roomId: "room", taskId: "parent", requestId: "complete", executionEpoch: 1, result: "done" }),
  ]);
  assert.equal(cancelled.value.task.status, "cancel_requested");
  assert.equal(completed.status, "rejected");
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "child" })).task.status, "cancelled");
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "unrelated" })).task.status, "queued");
  await assert.rejects(call(agent("a"), "tasks.stopped", { roomId: "room", taskId: "parent", requestId: "wrong-retry", executionEpoch: 1, outcome: "requeue" }), error("task_state_conflict", 409));
  const stopped = await call(agent("a"), "tasks.stopped", { roomId: "room", taskId: "parent", requestId: "stop", executionEpoch: 1, outcome: "cancelled" });
  assert.equal(stopped.task.status, "cancelled");
});

test("completion that wins before cancel stays completed", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("task");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task", requestId: "claim" });
  const [completed, cancel] = await Promise.all([
    call(agent("a"), "tasks.complete", { roomId: "room", taskId: "task", requestId: "complete", executionEpoch: 1, result: "done" }),
    call(user, "tasks.cancel", { roomId: "room", taskId: "task", requestId: "cancel" }),
  ]);
  assert.equal(completed.task.status, "completed");
  assert.equal(cancel.task.status, "completed");
});

test("revoked member cannot execute but can acknowledge its exact old execution stopping", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("task");
  await call(agent("a", "room"), "tasks.claim", { roomId: "room", taskId: "task", requestId: "claim" });
  await call(user, "rooms.remove", { roomId: "room", agentId: "a" });
  await assert.rejects(call(agent("a", "room"), "tasks.complete", { roomId: "room", taskId: "task", requestId: "complete", executionEpoch: 1, result: "done" }), error("room_not_found", 404));
  await assert.rejects(call(agent("b", "room"), "tasks.stopped", { roomId: "room", taskId: "task", requestId: "spoof", executionEpoch: 1, outcome: "cancelled" }), error("forbidden", 403));
  const stopped = await call(agent("a", "room"), "tasks.stopped", { roomId: "room", taskId: "task", requestId: "stop", executionEpoch: 1, outcome: "cancelled" });
  assert.equal(stopped.task.status, "cancelled");
});

test("task IDs cannot collide with message-created tasks; task lists return paginated summaries", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("msg_collision");
  await assert.rejects(call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "collision", expectedContextRev: 0, text: "collision", toAgentId: "a" }), error("task_conflict", 409));
  assert.equal((await call(user, "messages.read", { roomId: "room", discussionId: "main" })).messages.length, 0);
  await delegate("another");
  await delegate("b-task", { assigneeId: "b" });
  const page = await call(agent("a"), "tasks.list", { roomId: "room", assigneeId: "a", status: "queued", limit: 1 });
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].description, undefined);
  assert.equal(page.hasMore, true);
  const next = await call(agent("a"), "tasks.list", { roomId: "room", assigneeId: "a", afterId: page.nextCursor });
  assert.equal(next.tasks.length, 1);
  assert.notEqual(next.tasks[0].id, page.tasks[0].id);
});

test("pausing blocks claims and renewals while allowing completion facts and stop receipts", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("running");
  await delegate("queued", { sessionId: "separate" });
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "running", requestId: "claim" });
  await call(user, "rooms.pause", { roomId: "room" });
  await assert.rejects(call(agent("a"), "tasks.claim", { roomId: "room", taskId: "queued", requestId: "paused-claim" }), error("room_paused", 409));
  await assert.rejects(call(agent("a"), "tasks.renew", { roomId: "room", taskId: "running", requestId: "paused-renew", executionEpoch: 1, renewalSeq: 1 }), error("room_paused", 409));
  assert.equal((await call(agent("a"), "tasks.complete", { roomId: "room", taskId: "running", requestId: "complete", executionEpoch: 1, result: "already finished" })).task.status, "completed");
});

test("task history is bounded and overflow does not discard previous work", async () => {
  const { call, delegate } = await taskFixture();
  for (let i = 0; i < 128; i++) await delegate(`task-${i}`);
  await assert.rejects(delegate("overflow"), error("task_limit", 409));
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "task-0" })).task.description, "Implement the change");
});

test("over 1000 renewals use fixed storage and still allow cancellation and stopped confirmation", async () => {
  const { call, delegate, storage } = await taskFixture();
  await delegate("task");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task", requestId: "claim" });
  const rowCount = storage.rows.size;
  let latest;
  for (let i = 1; i <= 1001; i++) latest = await call(agent("a"), "tasks.renew", { roomId: "room", taskId: "task", requestId: `renew-${i}`, executionEpoch: 1, renewalSeq: i }, 100_000 + i);
  assert.equal(storage.rows.size, rowCount + 1);
  const replay = await call(agent("a"), "tasks.renew", { roomId: "room", taskId: "task", requestId: "renew-1001", executionEpoch: 1, renewalSeq: 1001 }, 102_000);
  assert.deepEqual(replay, latest);
  await assert.rejects(call(agent("a"), "tasks.renew", { roomId: "room", taskId: "task", requestId: "renew-1", executionEpoch: 1, renewalSeq: 1 }, 102_000), error("renewal_conflict", 409));
  await call(user, "tasks.cancel", { roomId: "room", taskId: "task", requestId: "cancel" });
  await call(agent("a"), "tasks.stopped", { roomId: "room", taskId: "task", requestId: "stop", executionEpoch: 1, outcome: "cancelled" });
  const result = await call(user, "tasks.get", { roomId: "room", taskId: "task" });
  assert.equal(result.events.length, 4);
  assert.equal(result.task.status, "cancelled");
});

test("over 1000 renewals cannot exhaust completion history or the permanent request ledger", async () => {
  const { call, delegate, storage } = await taskFixture();
  await delegate("task");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task", requestId: "claim" });
  for (let i = 1; i <= 1001; i++) await call(agent("a"), "tasks.renew", { roomId: "room", taskId: "task", requestId: `renew-${i}`, executionEpoch: 1, renewalSeq: i }, 100_000 + i);
  const done = await call(agent("a"), "tasks.complete", { roomId: "room", taskId: "task", requestId: "done", executionEpoch: 1, result: "finished" }, 102_000);
  assert.equal(done.task.status, "completed");
  assert.equal(done.task.eventCount, 3);
  assert.equal([...storage.rows.keys()].filter((key) => key.startsWith("room-local:request:")).length, 3);
});

test("waiting releases the session and capacity and last child completion resumes from checkpoint", async () => {
  const { call, delegate } = await taskFixture();
  await call(user, "agents.configure", { agentId: "a", capacity: 1 });
  await delegate("parent");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "parent-claim" });
  await delegate("child", { parentTaskId: "parent" }, agent("a"));
  const waiting = await call(agent("a"), "tasks.wait", { roomId: "room", taskId: "parent", requestId: "wait", executionEpoch: 1, checkpoint: "Patch applied; await test result, do not apply again" });
  assert.equal(waiting.task.status, "waiting");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "child", requestId: "child-claim" });
  await call(agent("a"), "tasks.complete", { roomId: "room", taskId: "child", requestId: "child-done", executionEpoch: 1, result: "tests passed" });
  const parent = await call(user, "tasks.get", { roomId: "room", taskId: "parent" });
  assert.equal(parent.task.status, "queued");
  assert.equal(parent.task.resume, true);
  assert.equal(parent.task.checkpoint, waiting.task.checkpoint);
  assert.equal(parent.children[0].result, "tests passed");
  const resumed = await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "parent-resume" });
  assert.equal(resumed.task.executionEpoch, 2);
  await assert.rejects(call(agent("a"), "tasks.complete", { roomId: "room", taskId: "parent", requestId: "stale-parent", executionEpoch: 1, result: "old generation" }), error("execution_conflict", 409));
});

test("children finishing before wait and mixed failed/completed children never strand the parent", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("parent");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "parent-claim" });
  for (const id of ["child-a", "child-b"]) await delegate(id, { parentTaskId: "parent", assigneeId: "b", sessionId: id }, agent("a"));
  await call(agent("b"), "tasks.claim", { roomId: "room", taskId: "child-a", requestId: "child-a-claim" });
  await call(agent("b"), "tasks.fail", { roomId: "room", taskId: "child-a", requestId: "child-a-fail", executionEpoch: 1, error: "adapter explicitly stopped before execution" });
  await call(agent("b"), "tasks.claim", { roomId: "room", taskId: "child-b", requestId: "child-b-claim" });
  await call(agent("b"), "tasks.complete", { roomId: "room", taskId: "child-b", requestId: "child-b-done", executionEpoch: 1, result: "success" });
  const wait = await call(agent("a"), "tasks.wait", { roomId: "room", taskId: "parent", requestId: "wait", executionEpoch: 1, checkpoint: "reconcile child results" });
  assert.equal(wait.task.status, "queued");
  assert.equal(wait.task.resume, true);
  const details = await call(user, "tasks.get", { roomId: "room", taskId: "parent" });
  assert.deepEqual(details.children.map((child) => child.status), ["failed", "completed"]);
  assert.match(details.children[0].error, /stopped/);
});

test("a cancelled waiting parent is never resurrected by child stop receipts", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("parent");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "parent-claim" });
  await delegate("child", { parentTaskId: "parent", assigneeId: "b" }, agent("a"));
  await call(agent("b"), "tasks.claim", { roomId: "room", taskId: "child", requestId: "child-claim" });
  await call(agent("a"), "tasks.wait", { roomId: "room", taskId: "parent", requestId: "wait", executionEpoch: 1, checkpoint: "waiting" });
  assert.equal((await call(user, "tasks.cancel", { roomId: "room", taskId: "parent", requestId: "cancel-parent" })).task.status, "cancelled");
  await call(agent("b"), "tasks.stopped", { roomId: "room", taskId: "child", requestId: "child-stopped", executionEpoch: 1, outcome: "cancelled" });
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "parent" })).task.status, "cancelled");
});

test("unknown execution cannot claim a known failure to release uncertain side effects", async () => {
  const { call, delegate } = await taskFixture();
  await delegate("task");
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "task", requestId: "claim", leaseMs: 1000 });
  await assert.rejects(call(agent("a"), "tasks.fail", { roomId: "room", taskId: "task", requestId: "fail", executionEpoch: 1, error: "network disconnected" }, 101_001), error("task_state_conflict", 409));
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "task" }, 101_001)).task.status, "unknown");
});

test("task graph cannot contain cycles and rejects a ninth delegation level", async () => {
  const { call, delegate } = await taskFixture();
  await assert.rejects(delegate("self", { parentTaskId: "self" }), error("task_not_found", 404));
  await delegate("task-0");
  for (let i = 1; i <= 8; i++) await delegate(`task-${i}`, { parentTaskId: `task-${i - 1}` });
  await assert.rejects(delegate("too-deep", { parentTaskId: "task-8" }), error("depth_limit", 409));
  await assert.rejects(call(agent("a"), "tasks.wait", { roomId: "room", taskId: "task-0", requestId: "unclaimed-wait", executionEpoch: 1, checkpoint: "wait" }), error("execution_conflict", 409));
});

test("message history quota rejects overflow without silently dropping older messages", async () => {
  const { call } = await taskFixture();
  for (let i = 0; i < 512; i++) await call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: `message-${i}`, expectedContextRev: i, text: `message ${i}` });
  await assert.rejects(call(user, "messages.send", { roomId: "room", discussionId: "main", requestId: "overflow", expectedContextRev: 512, text: "overflow" }), error("message_limit", 409));
  const first = await call(user, "messages.read", { roomId: "room", discussionId: "main", limit: 1 });
  assert.equal(first.messages[0].text, "message 0");
  assert.equal(first.contextRev, 512);
  assert.equal(first.hasMore, true);
});

test("task details bound child results and signal truncation without exceeding the transport frame", async () => {
  const { call, delegate } = await taskFixture();
  const large = "x".repeat(16_384);
  await delegate("parent", { description: large, completionCriteria: large });
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "parent-claim" });
  for (let i = 0; i < 5; i++) {
    const taskId = `child-${i}`;
    await delegate(taskId, { parentTaskId: "parent", assigneeId: "b" });
    await call(agent("b"), "tasks.claim", { roomId: "room", taskId, requestId: `claim-${i}` });
    await call(agent("b"), "tasks.complete", { roomId: "room", taskId, requestId: `complete-${i}`, executionEpoch: 1, result: large });
  }
  await call(agent("a"), "tasks.wait", { roomId: "room", taskId: "parent", requestId: "wait", executionEpoch: 1, checkpoint: large });
  await call(agent("a"), "tasks.claim", { roomId: "room", taskId: "parent", requestId: "resume" });
  await call(agent("a"), "tasks.complete", { roomId: "room", taskId: "parent", requestId: "complete", executionEpoch: 2, result: large });
  const details = await call(user, "tasks.get", { roomId: "room", taskId: "parent" });
  assert.ok(details.children.some((child) => child.resultTruncated));
  assert.equal(details.children.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(details.children)) <= 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) < 128 * 1024);
  assert.equal((await call(user, "tasks.get", { roomId: "room", taskId: "child-4" })).task.result, large);
});
