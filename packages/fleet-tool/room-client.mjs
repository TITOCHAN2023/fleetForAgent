import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const ID = { type: "string", pattern: "^[A-Za-z0-9_-]{1,96}$", minLength: 1, maxLength: 96 };
const TEXT = { type: "string", minLength: 1, maxLength: 16_384 };
const REV = { type: "integer", minimum: 0 };
const LIMIT = { type: "integer", minimum: 1, maximum: 100 };
const routing = { leaderId: ID, roomId: ID };
const definition = (name, description, properties, required) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export const ROOM_TOOLS = [
  definition("fleet_agents", "List this account's currently connected Fleet Agents and this MCP identity. MCP-only entries cannot be remotely invoked. Room history remains exclusively on its leader.", {}, []),
  definition("room_create", "Create a Room on its online leader. Requires this authenticated Agent to be that leader with owner-granted permission; this tool never grants permissions. Keep the same id when checking an uncertain response.", { leaderId: ID, id: ID, name: { type: "string", minLength: 1, maxLength: 120 }, defaultDeviceId: ID }, ["leaderId", "id", "defaultDeviceId"]),
  definition("room_invite", "Invite an existing Agent. Only the Room leader can invite; at most five Agents including the leader.", { ...routing, agentId: ID }, ["leaderId", "roomId", "agentId"]),
  definition("room_list", "List Rooms accessible to this Agent on one online leader. No local history cache is created.", { leaderId: ID }, ["leaderId"]),
  definition("room_read", "Read one discussion from its leader. Follow hasMore/nextCursor until complete before generating a reply against contextRev.", { ...routing, discussionId: ID, afterSeq: REV, limit: LIMIT }, ["leaderId", "roomId"]),
  definition("room_send", "Append a version-checked message. Only explicit toAgentId wakes a callable member; broadcast only records history. Retain requestId and unchanged payload after a lost response. On context_conflict, read new messages and revise the answer.", { ...routing, discussionId: ID, requestId: ID, expectedContextRev: REV, text: TEXT, toAgentId: ID }, ["leaderId", "roomId", "requestId", "expectedContextRev", "text"]),
  definition("room_delegate", "Delegate a bounded task to a callable member in this Room. The leader fixes its target device at enqueue time. Keep requestId and payload for retry; queued is not completed.", { ...routing, requestId: ID, assigneeId: ID, sessionId: ID, description: TEXT, completionCriteria: TEXT, deviceId: ID, parentTaskId: ID }, ["leaderId", "roomId", "requestId", "assigneeId", "sessionId", "description", "completionCriteria"]),
  definition("room_task", "Get a task and its result/events/children by taskId, or list summaries without taskId. Follow pagination; retrieve truncated child results individually. Unknown means an old execution has not confirmed stopping.", { ...routing, taskId: ID, assigneeId: ID, status: { type: "string", enum: ["queued", "running", "waiting", "unknown", "cancel_requested", "completed", "cancelled", "failed"] }, afterId: ID, limit: LIMIT, afterEventSeq: REV }, ["leaderId", "roomId"]),
  definition("room_cancel", "Request cancellation of a task and its descendants. cancel_requested is not proof the process stopped; only cancelled is confirmed. Keep requestId for uncertain-response retries.", { ...routing, taskId: ID, requestId: ID }, ["leaderId", "roomId", "taskId", "requestId"]),
];

export function stableRoomIdentity({ env = process.env, directory = join(homedir(), ".fleet"), host = hostname(), url, clientName = "mcp" }) {
  if (typeof clientName !== "string" || !clientName.trim() || clientName.length > 128) clientName = "mcp";
  let id = env.FLEET_AGENT_ID;
  if (id !== undefined && !new RegExp(ID.pattern).test(id)) throw new Error("Invalid FLEET_AGENT_ID");
  if (!id) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "room-identity.json");
    const temporary = join(directory, `room-identity-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: 1, seed: randomUUID() }) + "\n", { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, filename); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { unlinkSync(temporary); }
    const record = JSON.parse(readFileSync(filename, "utf8"));
    if (record.version !== 1 || typeof record.seed !== "string" || !/^[a-f0-9-]{36}$/.test(record.seed)) throw new Error("Invalid Fleet Room identity file; not overwritten");
    id = "mcp_" + createHash("sha256").update([record.seed, url.replace(/\/$/, ""), clientName].join("\0")).digest("hex").slice(0, 32);
  }
  const label = (value) => String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").trim().slice(0, 45);
  const name = env.FLEET_AGENT_NAME || `${label(host)}-${label(clientName)}`;
  if (!name.trim() || name.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) throw new Error("Invalid FLEET_AGENT_NAME");
  return { id, name };
}

function validate(name, input) {
  const tool = ROOM_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown Room tool: ${name}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Room arguments must be an object");
  const { properties, required } = tool.inputSchema;
  for (const key of required) if (input[key] === undefined) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unexpected field: ${key}`);
    const schema = properties[key];
    if (schema.type === "integer") {
      if (!Number.isSafeInteger(value) || value < schema.minimum || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${key}`);
    } else if (typeof value !== "string" || (schema.minLength && !value.trim()) || value.length > (schema.maxLength ?? 128) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value))) {
      throw new Error(`Invalid ${key}`);
    }
    if (schema === TEXT && Buffer.byteLength(value) > 16_384) throw new Error(`${key} exceeds 16 KiB`);
  }
  if (name === "room_task") {
    const incompatible = input.taskId ? ["assigneeId", "status", "afterId", "limit"] : ["afterEventSeq"];
    if (incompatible.some((key) => input[key] !== undefined)) throw new Error("Task detail and task list arguments cannot be mixed");
  }
  return { ...input };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Room request cancelled locally; outcome may be unknown. Retain requestId for retry."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createRoomTools({ url, token, env = process.env, directory, host, loadConnection = async () => (await import("../fleet-room/client.mjs")).RoomConnection, warn = (text) => process.stderr.write(text + "\n") }) {
  let identity;
  let clientName = "mcp";
  let connection;
  let connecting;
  let ready = false;
  let closed = false;
  let retryTimer;
  let warned = false;
  let initialized = false;

  function retry() {
    if (closed || retryTimer || !url || !token || env.FLEET_ROOM_ENABLED === "0") return;
    retryTimer = setTimeout(() => { retryTimer = undefined; backgroundConnect(); }, 30_000);
    retryTimer.unref?.();
  }
  function backgroundConnect() {
    void connect().catch(() => {
      if (!closed && !warned) { warned = true; warn("Fleet Room registration unavailable; existing Fleet device tools remain available."); }
      retry();
    });
  }
  async function connect() {
    if (closed) throw new Error("Fleet Room client is closed");
    if (!url || !token) throw new Error("Need FLEET_URL and FLEET_TOKEN for Room tools");
    if (env.FLEET_ROOM_ENABLED === "0") throw new Error("Fleet Room tools are disabled by FLEET_ROOM_ENABLED=0");
    if (connecting) return connecting;
    if (ready) return connection;
    connecting = (async () => {
      identity ??= stableRoomIdentity({ env, directory, host, url, clientName });
      const Connection = await loadConnection();
      if (closed) throw new Error("Fleet Room client is closed");
      const current = new Connection({ url, token, ...identity, mode: "mcp", leader: false, capacity: 2,
        onClose: () => { if (connection === current) { ready = false; connection = undefined; } retry(); },
      });
      connection = current;
      try {
        await current.connect();
        if (closed) { current.close(); throw new Error("Fleet Room client is closed"); }
        ready = true;
        warned = false;
        clearTimeout(retryTimer); retryTimer = undefined;
        return current;
      } catch (error) { current.close(); if (connection === current) connection = undefined; throw error; }
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }
  return {
    tools: ROOM_TOOLS,
    hasTool: (name) => ROOM_TOOLS.some((tool) => tool.name === name),
    initialize(clientInfo = {}) {
      if (initialized || closed) return;
      initialized = true;
      clientName = clientInfo.name || "mcp";
      if (url && token && env.FLEET_ROOM_ENABLED !== "0") backgroundConnect();
    },
    async callTool(name, input = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const args = validate(name, input);
      const client = await abortable(connect(), signal);
      const { leaderId = "", ...body } = args;
      if (name === "fleet_agents") return { ...await abortable(client.call("", "directory", {}), signal), self: { ...identity, mode: "mcp", callable: false } };
      const actions = { room_create: "rooms.create", room_invite: "rooms.invite", room_list: "rooms.list", room_read: "messages.read", room_send: "messages.send", room_delegate: "tasks.delegate", room_cancel: "tasks.cancel" };
      const action = name === "room_task" ? (body.taskId ? "tasks.get" : "tasks.list") : actions[name];
      if (name === "room_create") body.leaderId = leaderId;
      if (name === "room_read" || name === "room_send") body.discussionId ??= "main";
      return abortable(client.call(leaderId, action, body), signal);
    },
    async shutdown() { closed = true; clearTimeout(retryTimer); connection?.close(); },
  };
}
