import { LOCAL_ACTIONS, localRoomControl } from "./room-tasks.mjs";

// Store this module's state on the leader's local disk, never on the relay Hub.
// Account isolation is supplied by the caller's storage routing. Never construct
// principal from request fields: it is the authenticated identity.
const AGENTS = "room-control:agent:";
const ROOMS = "room-control:room:";
const HEARTBEAT_TTL = 60_000;
const MAX_AGENTS = 256;
const MAX_ROOMS = 32;
const MAX_MEMBERS = 5;

export class RoomControlError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "RoomControlError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) {
  throw new RoomControlError(code, status, message);
}

function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    fail("invalid_input", 400, "IDs must contain 1–96 letters, digits, underscores or hyphens");
  }
  return value;
}

function name(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    fail("invalid_input", 400, "Names must contain 1–120 visible characters");
  }
  return value.trim();
}

function mode(value) {
  if (value !== "mcp" && value !== "runtime") fail("invalid_input", 400, "Mode must be mcp or runtime");
  return value;
}

function capacity(value) {
  if (!Number.isInteger(value) || value < 1 || value > 8) fail("invalid_input", 400, "Capacity must be an integer from 1 to 8");
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") fail("invalid_input", 400, "Expected a boolean");
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_input", 400, "Expected a positive version number");
  return value;
}

const FIELDS = {
  "agents.register": { id, name, mode, capacity },
  "agents.list": {},
  "agents.configure": { agentId: id, name, mode, capacity, canCreateRooms: boolean },
  "agents.heartbeat": {},
  "rooms.create": { id, name, leaderId: id, defaultDeviceId: id },
  "rooms.list": {},
  "rooms.get": { roomId: id },
  "rooms.invite": { roomId: id, agentId: id },
  "rooms.remove": { roomId: id, agentId: id, newLeaderId: id },
  "rooms.device": { roomId: id, defaultDeviceId: id, expectedConfigVersion: version },
  "rooms.pause": { roomId: id },
  "rooms.resume": { roomId: id },
};

function validateInput(action, input) {
  if (!Object.hasOwn(FIELDS, action) && !LOCAL_ACTIONS.has(action)) fail("unknown_action", 400, "Unknown Room control action");
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_input", 400, "Expected an input object");
  if (LOCAL_ACTIONS.has(action)) return input;
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(FIELDS[action], key)) fail("invalid_input", 400, `Unexpected field: ${key}`);
    result[key] = FIELDS[action][key](value);
  }
  return result;
}

function userOnly(principal) {
  if (principal.kind !== "user") fail("forbidden", 403, "Only the account owner can change Agent registration or permissions");
}

async function agentRecord(tx, agentId) {
  const agent = await tx.get(AGENTS + id(agentId));
  if (!agent) fail("agent_not_found", 404, "Agent is not registered");
  return agent;
}

// Explicit projection prevents future private registration fields from leaking.
function agentView(agent, now) {
  const { id, name, mode, capacity, canCreateRooms, createdAt, updatedAt, lastSeen } = agent;
  const online = lastSeen !== null && lastSeen <= now && now - lastSeen < HEARTBEAT_TTL;
  return { id, name, mode, capacity, canCreateRooms, createdAt, updatedAt, lastSeen, online, callable: mode === "runtime" && online };
}

function canReadRoom(principal, room) {
  return principal.kind === "user" || (
    (!principal.roomId || principal.roomId === room.id) && room.memberIds.includes(principal.id)
  );
}

async function readableRoom(tx, principal, roomId) {
  const room = await tx.get(ROOMS + id(roomId));
  // Do not disclose whether another Agent's private room exists.
  if (!room || !canReadRoom(principal, room)) fail("room_not_found", 404, "Room is not available");
  return room;
}

function managerOnly(principal, room) {
  if (principal.kind !== "user" && principal.id !== room.leaderId) fail("forbidden", 403, "Only the account owner or Room leader can manage this Room");
}

async function register(tx, principal, input, now) {
  userOnly(principal);
  const agentId = id(input.id);
  const existing = await tx.get(AGENTS + agentId);
  if (existing) {
    const changed = ["name", "mode", "capacity"].some((key) => Object.hasOwn(input, key) && input[key] !== existing[key]);
    if (changed) fail("agent_conflict", 409, "Agent already exists; use agents.configure to change registration");
    return { agent: agentView(existing, now) };
  }
  if ((await tx.list({ prefix: AGENTS })).size >= MAX_AGENTS) fail("agent_limit", 409, "Account Agent limit reached");
  const agent = {
    id: agentId, name: input.name ?? agentId, mode: input.mode ?? "mcp",
    capacity: input.capacity ?? 2, canCreateRooms: false,
    createdAt: now, updatedAt: now, lastSeen: null,
  };
  await tx.put(AGENTS + agentId, agent);
  return { agent: agentView(agent, now) };
}

async function configure(tx, principal, input, now) {
  userOnly(principal);
  const agent = await agentRecord(tx, input.agentId);
  const next = { ...agent, updatedAt: now };
  for (const key of ["name", "mode", "capacity", "canCreateRooms"]) {
    if (Object.hasOwn(input, key)) next[key] = input[key];
  }
  // Switching adapters requires a fresh heartbeat before remote availability.
  if (next.mode !== agent.mode) next.lastSeen = null;
  await tx.put(AGENTS + agent.id, next);
  return { agent: agentView(next, now) };
}

async function createRoom(tx, principal, caller, input, now) {
  const roomId = id(input.id);
  const leaderId = id(input.leaderId);
  const defaultDeviceId = id(input.defaultDeviceId);
  if (principal.kind === "agent" && (principal.roomId || !caller.canCreateRooms || leaderId !== principal.id)) {
    fail("forbidden", 403, "Room creation requires an unscoped Agent with owner-granted permission acting as leader");
  }
  await agentRecord(tx, leaderId);
  if (await tx.get(ROOMS + roomId)) fail("room_conflict", 409, "Room ID already exists");
  if ((await tx.list({ prefix: ROOMS })).size >= MAX_ROOMS) fail("room_limit", 409, "Account Room limit reached");
  const room = {
    id: roomId, name: input.name ?? roomId, leaderId, memberIds: [leaderId],
    defaultDeviceId, membershipVersion: 1, configVersion: 1,
    controlEpoch: 1, paused: false, createdAt: now, updatedAt: now,
  };
  await tx.put(ROOMS + roomId, room);
  return { room };
}

async function updateRoom(tx, principal, action, input, now) {
  const room = await readableRoom(tx, principal, input.roomId);
  if (action === "rooms.get") return { room };
  managerOnly(principal, room);
  const next = { ...room, memberIds: [...room.memberIds], updatedAt: now };
  if (action === "rooms.invite") {
    const agentId = id(input.agentId);
    await agentRecord(tx, agentId);
    if (room.memberIds.includes(agentId)) return { room };
    if (room.memberIds.length >= MAX_MEMBERS) fail("member_limit", 409, "A Room can contain at most 5 Agents including its leader");
    next.memberIds.push(agentId);
    next.membershipVersion++;
  }
  if (action === "rooms.remove") {
    const agentId = id(input.agentId);
    if (!room.memberIds.includes(agentId)) return { room };
    if (agentId === room.leaderId) {
      if (!input.newLeaderId || input.newLeaderId === agentId || !room.memberIds.includes(input.newLeaderId)) {
        fail("leader_required", 409, "Removing the leader requires an existing replacement member");
      }
      next.leaderId = input.newLeaderId;
    } else if (input.newLeaderId) {
      fail("invalid_input", 400, "Leader reassignment only applies when removing the current leader");
    }
    next.memberIds = room.memberIds.filter((member) => member !== agentId);
    next.membershipVersion++;
    next.controlEpoch++;
  }
  if (action === "rooms.device") {
    version(input.expectedConfigVersion);
    if (input.expectedConfigVersion !== room.configVersion) fail("config_conflict", 409, "Room configuration changed; reload before choosing the default device");
    next.defaultDeviceId = id(input.defaultDeviceId);
    if (next.defaultDeviceId === room.defaultDeviceId) return { room };
    next.configVersion++;
  }
  if (action === "rooms.pause" || action === "rooms.resume") {
    next.paused = action === "rooms.pause";
    if (next.paused === room.paused) return { room };
    next.controlEpoch++;
  }
  await tx.put(ROOMS + room.id, next);
  return { room: next };
}

/** Local Room authority; never invokes a model, shell or network in a transaction. */
export async function roomControl(storage, principal, action, input = {}, now = Date.now()) {
  if (!principal || !["user", "agent"].includes(principal.kind)) fail("unauthorized", 401, "Authenticated principal required");
  id(principal.id);
  if (principal.roomId !== undefined) {
    id(principal.roomId);
    if (principal.kind !== "agent") fail("unauthorized", 401, "Only Agent principals can have Room scope");
  }
  if (!Number.isSafeInteger(now) || now < 0) fail("invalid_input", 400, "Invalid server timestamp");
  const data = validateInput(action, input);
  return storage.transaction(async (tx) => {
    const caller = principal.kind === "agent" ? await agentRecord(tx, principal.id) : null;
    // A revoked member still needs to acknowledge stopping its old execution;
    // tasks.stopped checks the exact holder and execution epoch itself.
    if (principal.roomId && action !== "tasks.stopped") await readableRoom(tx, principal, principal.roomId);
    if (LOCAL_ACTIONS.has(action)) {
      return localRoomControl(tx, principal, action, data, now, { fail, id, readableRoom, agentRecord, agentView });
    }
    if (action === "agents.register") return register(tx, principal, data, now);
    if (action === "agents.configure") return configure(tx, principal, data, now);
    if (action === "agents.heartbeat") {
      if (!caller) fail("forbidden", 403, "An Agent must send its own heartbeat");
      const agent = { ...caller, lastSeen: now, updatedAt: now };
      await tx.put(AGENTS + caller.id, agent);
      return { agent: agentView(agent, now) };
    }
    if (action === "agents.list") {
      const scope = principal.roomId ? await readableRoom(tx, principal, principal.roomId) : null;
      const agents = [...(await tx.list({ prefix: AGENTS })).values()]
        .filter((agent) => !scope || scope.memberIds.includes(agent.id))
        .map((agent) => agentView(agent, now));
      return { agents };
    }
    if (action === "rooms.create") return createRoom(tx, principal, caller, data, now);
    if (action === "rooms.list") {
      const rooms = [...(await tx.list({ prefix: ROOMS })).values()].filter((room) => canReadRoom(principal, room));
      return { rooms };
    }
    return updateRoom(tx, principal, action, data, now);
  });
}
