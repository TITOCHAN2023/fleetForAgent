// Local-only durable content. The Hub must forward opaque envelopes without
// using this storage. Every operation runs inside roomControl's transaction.
const PREFIX = "room-local:";
const MAX_MESSAGES = 512;
const MAX_DISCUSSIONS = 32;
const MAX_TASKS = 128;
const MAX_REQUESTS = 2048;
const MAX_EVENTS = 64;
const ACTIVE = new Set(["running", "cancel_requested", "unknown"]);
const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const SCHEMAS = {
  "messages.send": { roomId: "id", discussionId: "id", requestId: "id", expectedContextRev: "revision", text: "text", toAgentId: "id?" },
  "messages.read": { roomId: "id", discussionId: "id", afterSeq: "revision?", limit: "limit?" },
  "tasks.delegate": { roomId: "id", requestId: "id", assigneeId: "id", sessionId: "id", description: "text", completionCriteria: "text", deviceId: "id?", parentTaskId: "id?" },
  "tasks.get": { roomId: "id", taskId: "id", afterEventSeq: "revision?", eventLimit: "limit?" },
  "tasks.list": { roomId: "id", assigneeId: "id?", status: "status?", afterId: "id?", limit: "limit?" },
  "tasks.claim": { roomId: "id", taskId: "id", requestId: "id", leaseMs: "lease?" },
  "tasks.renew": { roomId: "id", taskId: "id", requestId: "id", executionEpoch: "epoch", renewalSeq: "epoch", leaseMs: "lease?" },
  "tasks.complete": { roomId: "id", taskId: "id", requestId: "id", executionEpoch: "epoch", result: "text", expectedContextRev: "revision?" },
  "tasks.wait": { roomId: "id", taskId: "id", requestId: "id", executionEpoch: "epoch", checkpoint: "text" },
  "tasks.fail": { roomId: "id", taskId: "id", requestId: "id", executionEpoch: "epoch", error: "text" },
  "tasks.cancel": { roomId: "id", taskId: "id", requestId: "id" },
  "tasks.stopped": { roomId: "id", taskId: "id", requestId: "id", executionEpoch: "epoch", outcome: "outcome" },
};
export const LOCAL_ACTIONS = new Set(Object.keys(SCHEMAS));

// Encode components so a colon inside an ID cannot alias another room's key.
const key = (type, ...parts) => PREFIX + type + ":" + parts.map(encodeURIComponent).join(":");
const range = (type, ...parts) => key(type, ...parts) + ":";

function validate(action, input, { fail, id }) {
  const schema = SCHEMAS[action];
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(schema, field)) fail("invalid_input", 400, `Unexpected field: ${field}`);
  }
  const result = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = input[field];
    if (value === undefined && rule.endsWith("?")) continue;
    const type = rule.replace(/\?$/, "");
    if (type === "id") { result[field] = id(value); continue; }
    if (type === "text") {
      if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > 16_384 || new TextEncoder().encode(JSON.stringify(value)).length > 16_386) {
        fail("invalid_input", 400, `${field} must be nonempty text of at most 16 KiB`);
      }
    } else if (type === "status") {
      if (!["queued", "running", "waiting", "unknown", "cancel_requested", "completed", "cancelled", "failed"].includes(value)) fail("invalid_input", 400, "Invalid task status");
    } else if (type === "outcome") {
      if (value !== "cancelled" && value !== "requeue") fail("invalid_input", 400, "Stopped outcome must be cancelled or requeue");
    } else {
      const [min, max] = { revision: [0, Number.MAX_SAFE_INTEGER], epoch: [1, Number.MAX_SAFE_INTEGER], limit: [1, 100], lease: [1000, 60_000] }[type];
      if (!Number.isSafeInteger(value) || value < min || value > max) fail("invalid_input", 400, `Invalid ${field}`);
    }
    result[field] = value;
  }
  return result;
}

function taskView(task, now) {
  // An expired lease never grants a second executor permission. Keep the claim
  // and session reservation until its holder acknowledges an actual stop.
  if (task.status === "running" && task.leaseExpiresAt <= now) return { ...task, status: "unknown" };
  return task;
}

async function getTask(tx, roomId, taskId, now, fail) {
  const task = await tx.get(key("task", roomId, taskId));
  if (!task) fail("task_not_found", 404, "Task is not available in this Room");
  return taskView(task, now);
}

function executorOnly(principal, task, fail) {
  if (principal.kind !== "agent" || principal.id !== task.assigneeId) fail("forbidden", 403, "Only the assigned Agent can execute or acknowledge this task");
}

function epochMatches(task, input, fail) {
  if (task.executionEpoch !== input.executionEpoch) fail("execution_conflict", 409, "Execution generation changed");
}

async function saveTask(tx, task, eventType, principal, now, fail) {
  const eventLimit = eventType === "claimed" ? MAX_EVENTS - 2 : MAX_EVENTS;
  if (task.eventCount >= eventLimit) fail("event_limit", 409, "Task event history limit reached; no state was discarded");
  const next = { ...task, eventCount: task.eventCount + 1, updatedAt: now };
  const event = { taskId: task.id, roomId: task.roomId, seq: next.eventCount, type: eventType, actorId: principal.id, actorKind: principal.kind, executionEpoch: next.executionEpoch, status: next.status, createdAt: now };
  await tx.put(key("event", task.roomId, task.id, String(event.seq).padStart(4, "0")), event);
  await tx.put(key("task", task.roomId, task.id), next);
  if (TERMINAL.has(next.status) && next.parentTaskId) await resumeParent(tx, next, principal, now, fail);
  return { task: next };
}

async function childTasks(tx, task) {
  return [...(await tx.list({ prefix: range("task", task.roomId) })).values()].filter((entry) => entry.parentTaskId === task.id);
}

async function resumeParent(tx, child, principal, now, fail) {
  const parent = await tx.get(key("task", child.roomId, child.parentTaskId));
  if (!parent || parent.status !== "waiting") return;
  const children = await childTasks(tx, parent);
  if (children.some((entry) => !TERMINAL.has(entry.status))) return;
  await saveTask(tx, { ...parent, status: "queued", resume: true }, "resumed", principal, now, fail);
}

async function sendMessage(tx, principal, input, now, usage, fail) {
  const discussionKey = key("discussion", input.roomId, input.discussionId);
  const existing = await tx.get(discussionKey);
  const contextRev = existing?.contextRev ?? 0;
  if (contextRev !== input.expectedContextRev) fail("context_conflict", 409, "Discussion changed; read new messages before revising your answer");
  if (usage.messageCount >= MAX_MESSAGES) fail("message_limit", 409, "Room message history limit reached; no messages were discarded");
  if (!existing && usage.discussionCount >= MAX_DISCUSSIONS) fail("discussion_limit", 409, "Room discussion limit reached");
  const message = { id: input.requestId, roomId: input.roomId, discussionId: input.discussionId, authorId: principal.id, authorKind: principal.kind, toAgentId: input.toAgentId ?? null, seq: contextRev + 1, text: input.text, createdAt: now };
  await tx.put(key("message", input.roomId, input.discussionId, String(message.seq).padStart(6, "0")), message);
  await tx.put(discussionKey, { contextRev: message.seq });
  usage.messageCount++;
  if (!existing) usage.discussionCount++;
  return { message, contextRev: message.seq };
}

async function delegate(tx, principal, room, input, now, usage, helpers, message = null) {
  const { fail, agentRecord, agentView } = helpers;
  if (room.paused) fail("room_paused", 409, "Room is paused");
  if (!room.memberIds.includes(input.assigneeId)) fail("forbidden", 403, "Task assignee must be a current Room member");
  const assignee = await agentRecord(tx, input.assigneeId);
  if (assignee.mode !== "runtime") fail("agent_not_callable", 409, "An MCP-only Agent cannot receive remote tasks");
  if (!agentView(assignee, now).callable) fail("agent_offline", 409, "Task assignee has no current runtime heartbeat");
  if (await tx.get(key("task", room.id, input.requestId))) fail("task_conflict", 409, "Task ID already exists");
  if (usage.taskCount >= MAX_TASKS) fail("task_limit", 409, "Room task history limit reached; no tasks were discarded");
  const parent = input.parentTaskId ? await getTask(tx, room.id, input.parentTaskId, now, fail) : null;
  if (parent && principal.kind === "agent" && principal.id !== parent.assigneeId) fail("forbidden", 403, "Only the parent executor or account owner can delegate its child task");
  if (parent && (TERMINAL.has(parent.status) || parent.status === "cancel_requested" || parent.status === "unknown")) fail("task_state_conflict", 409, "Parent task cannot start new children");
  const depth = parent ? parent.depth + 1 : 0;
  if (depth > 8) fail("depth_limit", 409, "Task delegation depth limit reached");
  const task = {
    id: input.requestId, roomId: room.id, requesterId: principal.id, requesterKind: principal.kind,
    kind: message ? "message" : "task", messageId: message?.id ?? null, discussionId: message?.discussionId ?? null,
    assigneeId: input.assigneeId, sessionId: input.sessionId,
    description: input.description, completionCriteria: input.completionCriteria,
    parentTaskId: parent?.id ?? null, depth,
    resolvedDeviceId: input.deviceId ?? parent?.resolvedDeviceId ?? room.defaultDeviceId,
    deviceSource: input.deviceId ? "explicit" : parent ? "parent" : "room_default",
    configVersion: parent && !input.deviceId ? parent.configVersion : room.configVersion,
    status: "queued", executionEpoch: 0, renewalSeq: 0, leaseExpiresAt: null,
    controlEpoch: room.controlEpoch, eventCount: 0, createdAt: now, updatedAt: now,
  };
  usage.taskCount++;
  return saveTask(tx, task, "delegated", principal, now, fail);
}

async function claim(tx, principal, room, task, input, now, helpers) {
  const { fail, agentRecord, agentView } = helpers;
  executorOnly(principal, task, fail);
  if (room.paused) fail("room_paused", 409, "Room is paused");
  if (task.status !== "queued") fail("task_state_conflict", 409, "Task cannot be claimed; an expired execution must first acknowledge stopping");
  const agent = await agentRecord(tx, principal.id);
  if (!agentView(agent, now).callable) fail("agent_not_callable", 409, "Assigned Agent has no callable runtime");
  const tasks = [...(await tx.list({ prefix: PREFIX + "task:" })).values()];
  const active = tasks.filter((entry) => entry.assigneeId === principal.id && ACTIVE.has(entry.status));
  if (active.some((entry) => entry.sessionId === task.sessionId)) fail("session_busy", 409, "This Agent session already has an execution or an unconfirmed stop");
  if (active.length >= agent.capacity) fail("capacity_exceeded", 409, "Agent execution capacity reached");
  return saveTask(tx, { ...task, status: "running", executionEpoch: task.executionEpoch + 1, renewalSeq: 0, leaseExpiresAt: now + (input.leaseMs ?? 30_000), controlEpoch: room.controlEpoch }, "claimed", principal, now, fail);
}

async function renewTask(tx, principal, room, input, now, fail) {
  const task = await getTask(tx, room.id, input.taskId, now, fail);
  executorOnly(principal, task, fail);
  epochMatches(task, input, fail);
  if (room.paused) fail("room_paused", 409, "Room is paused; no new execution permit");
  if (task.status !== "running") fail("task_state_conflict", 409, "Execution is expired, cancelled or already finished");
  const renewalKey = key("renewal", room.id, task.id);
  const fingerprint = JSON.stringify([principal.id, input]);
  const previous = await tx.get(renewalKey);
  if (previous?.requestId === input.requestId) {
    if (previous.fingerprint !== fingerprint) fail("idempotency_conflict", 409, "Renewal request ID was reused with different content");
    return previous.result;
  }
  if (input.renewalSeq !== (task.renewalSeq ?? 0) + 1) fail("renewal_conflict", 409, "Renewal sequence is stale; old requests cannot extend a lease");
  if (await tx.get(key("request", room.id, input.requestId))) fail("idempotency_conflict", 409, "Request ID already belongs to a durable Room operation");
  const next = { ...task, renewalSeq: input.renewalSeq, leaseExpiresAt: now + (input.leaseMs ?? 30_000), controlEpoch: room.controlEpoch, updatedAt: now };
  const result = { task: next };
  // Fixed space per task: heartbeats are not user-visible history or permanent
  // requests. The monotonic sequence rejects every older renewal after replace.
  await tx.put(key("task", room.id, task.id), next);
  await tx.put(renewalKey, { requestId: input.requestId, fingerprint, result });
  return result;
}

async function cancel(tx, principal, room, task, now, fail) {
  const requester = principal.kind === task.requesterKind && principal.id === task.requesterId;
  if (principal.kind !== "user" && principal.id !== room.leaderId && !requester) fail("forbidden", 403, "Only the requester, Room leader or account owner can cancel a task");
  if (TERMINAL.has(task.status) || task.status === "cancel_requested") return { task };
  const all = [...(await tx.list({ prefix: range("task", room.id) })).values()];
  const ids = new Set([task.id]);
  // Bounded DAG: children are only created against an existing parent, depth ≤8.
  for (let depth = 0; depth <= 8; depth++) {
    for (const entry of all) if (ids.has(entry.parentTaskId)) ids.add(entry.id);
  }
  let result;
  for (const entry of all.filter((entry) => ids.has(entry.id))) {
    const current = taskView(entry, now);
    if (TERMINAL.has(current.status) || current.status === "cancel_requested") continue;
    const next = { ...current, status: ["queued", "waiting"].includes(current.status) ? "cancelled" : "cancel_requested" };
    const saved = await saveTask(tx, next, "cancel_requested", principal, now, fail);
    if (entry.id === task.id) result = saved;
  }
  return result ?? { task };
}

async function changeTask(tx, principal, room, action, input, now, usage, helpers) {
  const { fail } = helpers;
  const task = await getTask(tx, room.id, input.taskId, now, fail);
  if (action === "tasks.cancel") return cancel(tx, principal, room, task, now, fail);
  if (action === "tasks.claim") return claim(tx, principal, room, task, input, now, helpers);
  executorOnly(principal, task, fail);
  epochMatches(task, input, fail);
  if (action === "tasks.stopped") {
    if (!ACTIVE.has(task.status)) fail("task_state_conflict", 409, "Task has no execution to stop");
    if (input.outcome === "requeue" && task.status !== "unknown") fail("task_state_conflict", 409, "Only an explicitly stopped unknown execution may be requeued");
    const status = input.outcome === "requeue" ? "queued" : "cancelled";
    return saveTask(tx, { ...task, status, leaseExpiresAt: null }, "stopped", principal, now, fail);
  }
  if (task.status !== "running") fail("task_state_conflict", 409, "Execution is expired, cancelled or already finished");
  if (action === "tasks.fail") {
    return saveTask(tx, { ...task, status: "failed", error: input.error, leaseExpiresAt: null }, "failed", principal, now, fail);
  }
  if (action === "tasks.wait") {
    if (task.eventCount >= MAX_EVENTS - 5) fail("event_limit", 409, "Task cannot start another wait/resume cycle within its history budget");
    const children = await childTasks(tx, task);
    if (children.length === 0) fail("task_state_conflict", 409, "Task has no delegated children to wait for");
    const ready = children.every((child) => TERMINAL.has(child.status));
    return saveTask(tx, { ...task, status: ready ? "queued" : "waiting", resume: ready, checkpoint: input.checkpoint, leaseExpiresAt: null }, "waiting", principal, now, fail);
  }
  let reply = {};
  if (task.kind === "message") {
    if (input.expectedContextRev === undefined) fail("invalid_input", 400, "A message reply requires expectedContextRev");
    reply = await sendMessage(tx, principal, { roomId: room.id, discussionId: task.discussionId, requestId: input.requestId, expectedContextRev: input.expectedContextRev, text: input.result }, now, usage, fail);
  }
  const saved = await saveTask(tx, { ...task, status: "completed", result: input.result, leaseExpiresAt: null }, "completed", principal, now, fail);
  return { ...saved, ...reply };
}

function pageWithinBudget(rows, limit, cursorField, budget = 48 * 1024) {
  const items = [];
  let bytes = 0;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (items.length >= limit || bytes + size > budget) break;
    items.push(row);
    bytes += size;
  }
  return { items, hasMore: items.length < rows.length, nextCursor: items.at(-1)?.[cursorField] ?? null };
}

function taskSummary(task) {
  const { description: _description, completionCriteria: _criteria, result: _result, error: _error, checkpoint: _checkpoint, ...summary } = task;
  return summary;
}

function childSummaries(children, now) {
  const summaries = children.map((child) => ({ id: child.id, status: taskView(child, now).status }));
  let budget = Math.max(0, 32 * 1024 - new TextEncoder().encode(JSON.stringify(summaries)).length - children.length * 100);
  return summaries.map((summary, index) => {
    const child = children[index];
    for (const field of ["result", "error"]) {
      if (child[field] === undefined) continue;
      // Account for JSON escaping too, not only UTF-8 source text length.
      let text = child[field];
      while (text.length && new TextEncoder().encode(JSON.stringify(text)).length > budget) text = text.slice(0, Math.floor(text.length / 2));
      summary[field] = text;
      summary[field + "Truncated"] = text !== child[field];
      budget -= new TextEncoder().encode(JSON.stringify(text)).length;
    }
    return summary;
  });
}

export async function localRoomControl(tx, principal, action, rawInput, now, helpers) {
  const { fail, readableRoom } = helpers;
  const input = validate(action, rawInput, helpers);
  const stopReceipt = action === "tasks.stopped" && principal.kind === "agent";
  const room = stopReceipt ? await tx.get("room-control:room:" + input.roomId) : await readableRoom(tx, principal, input.roomId);
  if (!room || (principal.roomId && principal.roomId !== room.id)) fail("room_not_found", 404, "Room is not available");
  if (action === "messages.read") {
    const discussion = await tx.get(key("discussion", room.id, input.discussionId));
    const rows = [...(await tx.list({ prefix: range("message", room.id, input.discussionId) })).values()]
      .filter((message) => message.seq > (input.afterSeq ?? 0)).sort((a, b) => a.seq - b.seq);
    const { items: messages, ...pagination } = pageWithinBudget(rows, input.limit ?? 100, "seq");
    return { messages, contextRev: discussion?.contextRev ?? 0, ...pagination };
  }
  if (action === "tasks.list") {
    const rows = [...(await tx.list({ prefix: range("task", room.id) })).values()]
      .map((task) => taskView(task, now))
      .filter((task) => (!input.assigneeId || task.assigneeId === input.assigneeId) && (!input.status || task.status === input.status) && (!input.afterId || task.id > input.afterId))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(taskSummary);
    const { items: tasks, ...pagination } = pageWithinBudget(rows, input.limit ?? 100, "id");
    return { tasks, ...pagination };
  }
  if (action === "tasks.get") {
    const task = await getTask(tx, room.id, input.taskId, now, fail);
    const rows = [...(await tx.list({ prefix: range("event", room.id, task.id) })).values()]
      .filter((event) => event.seq > (input.afterEventSeq ?? 0)).sort((a, b) => a.seq - b.seq);
    const page = pageWithinBudget(rows, input.eventLimit ?? 100, "seq", 16 * 1024);
    const children = childSummaries(await childTasks(tx, task), now);
    return { task, events: page.items, eventsHasMore: page.hasMore, eventsNextCursor: page.nextCursor, children };
  }
  if (action === "tasks.renew") return renewTask(tx, principal, room, input, now, fail);
  // Dedupe before checking discussion/config/execution versions. The principal
  // is part of the fingerprint; request fields can never impersonate its author.
  const requestKey = key("request", room.id, input.requestId);
  const fingerprint = JSON.stringify([action, principal.kind, principal.id, input]);
  const existing = await tx.get(requestKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail("idempotency_conflict", 409, "Request ID was already used with different content or identity");
    return existing.result;
  }
  const usageKey = key("usage", room.id);
  const usage = await tx.get(usageKey) ?? { messageCount: 0, discussionCount: 0, taskCount: 0, requestCount: 0 };
  if (usage.requestCount >= MAX_REQUESTS) {
    // Reserve two receipts per possible task so a full normal ledger cannot
    // prevent cancellation and confirmation of an actual process stop.
    const critical = ["tasks.cancel", "tasks.stopped", "tasks.complete", "tasks.fail"].includes(action);
    const task = critical ? await getTask(tx, room.id, input.taskId, now, fail) : null;
    const changesState = task && !TERMINAL.has(task.status) && !(action === "tasks.cancel" && task.status === "cancel_requested");
    if (!changesState || usage.requestCount >= MAX_REQUESTS + MAX_TASKS * 2) fail("request_limit", 409, "Room request ledger limit reached; no records were discarded");
  }
  let result;
  if (action === "messages.send") {
    result = await sendMessage(tx, principal, input, now, usage, fail);
    if (input.toAgentId) {
      const taskId = helpers.id("msg_" + input.requestId);
      const delegated = await delegate(tx, principal, room, {
        requestId: taskId, assigneeId: input.toAgentId, sessionId: room.id,
        description: input.text, completionCriteria: "回复此消息",
      }, now, usage, helpers, result.message);
      result = { ...result, ...delegated };
    }
  }
  else if (action === "tasks.delegate") result = await delegate(tx, principal, room, input, now, usage, helpers);
  else result = await changeTask(tx, principal, room, action, input, now, usage, helpers);
  usage.requestCount++;
  await tx.put(usageKey, usage);
  await tx.put(requestKey, { fingerprint, result });
  return result;
}
