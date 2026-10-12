/** Live routing only. This module intentionally has no storage or logging API. */
export const ROOM_FRAME_LIMIT = 128 * 1024;
export const roomIdValid = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(id);
export class RelayError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export function relayRegistration(headers) {
  const id = headers.get("x-room-agent-id");
  let name;
  try { name = decodeURIComponent(headers.get("x-room-agent-name") || id || ""); }
  catch { throw new RelayError("INVALID_REGISTRATION", "Invalid Agent name encoding", 400); }
  const mode = headers.get("x-room-agent-mode") || "mcp";
  const scopeRoomId = headers.get("x-room-scope") || undefined;
  const capacity = Number(headers.get("x-room-capacity") || 2);
  if (!roomIdValid(id) || !name || name.length > 128 || !["mcp", "runtime"].includes(mode) ||
      (scopeRoomId && !roomIdValid(scopeRoomId)) || !Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
    throw new RelayError("INVALID_REGISTRATION", "Invalid Agent registration", 400);
  }
  return { id, name, mode, capacity, scopeRoomId, leader: mode === "runtime" && !scopeRoomId && headers.get("x-room-leader") === "1" };
}
/** @template [TAuth=unknown] */
export class RoomRelay {
  /** @param {{ authorize?: (auth: TAuth) => Promise<boolean>, devices?: () => Promise<unknown[]>, timeoutMs?: number, now?: () => number }} [options] */
  constructor({ authorize = async () => true, devices = async () => [], timeoutMs = 20_000, now = Date.now } = {}) {
    this.connections = new Set(); this.pending = new Map();
    this.authorize = authorize; this.devices = devices; this.timeoutMs = timeoutMs; this.now = now;
  }
  list() {
    this.prune();
    const byId = new Map();
    for (const c of this.connections) {
      if (c.ws.readyState !== 1 || this.now() - c.seen > 45_000 || c.meta.scopeRoomId) continue;
      const old = byId.get(c.meta.id);
      if (!old || c.meta.mode === "runtime") byId.set(c.meta.id, {
        id: c.meta.id, name: c.meta.name, mode: c.meta.mode, capacity: c.meta.capacity,
        leader: c.meta.leader, running: c.running, online: true, callable: c.meta.mode === "runtime",
      });
    }
    return { agents: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
  attach(ws, meta, auth = {}) {
    this.prune();
    if (this.connections.size >= 128) throw new RelayError("CAPACITY", "Too many Agent connections", 429);
    // One runtime owner per identity: an accidental second start cannot steal a live leader.
    for (const c of this.connections) {
      if (meta.mode === "runtime" && c.meta.mode === "runtime" && c.meta.id === meta.id && c.ws.readyState === 1) {
        throw new RelayError("ALREADY_CONNECTED", "Agent runtime is already connected");
      }
    }
    const c = { ws, meta, auth, seen: this.now(), running: 0 };
    this.connections.add(c);
    ws.addEventListener("message", (event) => { void this.receive(c, event.data).catch(() => ws.close(1008, "invalid room frame")); });
    ws.addEventListener("close", () => this.detach(c));
    ws.addEventListener("error", () => this.detach(c));
    ws.send(JSON.stringify({ type: "ready", agentId: meta.id }));
    return c;
  }
  detach(c) {
    this.connections.delete(c);
    for (const [id, p] of this.pending) if (p.connection === c) {
      this.pending.delete(id); clearTimeout(p.timer);
      p.reject(new RelayError("LEADER_OFFLINE", "Leader disconnected; execution outcome may be unknown", 503));
    }
  }
  prune() {
    for (const c of this.connections) {
      if (c.ws.readyState === 1 && this.now() - c.seen <= 45_000) continue;
      // Remove ownership before close: a half-open socket may never deliver a
      // close event, but it must not keep its identity or in-flight requests.
      this.detach(c);
      try { c.ws.close(1001, "heartbeat expired"); } catch { /* already closed */ }
    }
  }
  async receive(c, raw) {
    this.prune();
    if (!this.connections.has(c)) return;
    if (typeof raw !== "string") raw = new TextDecoder().decode(raw);
    if (new TextEncoder().encode(raw).length > ROOM_FRAME_LIMIT) throw new RelayError("FRAME_TOO_LARGE", "Frame too large", 413);
    if (!await this.authorize(c.auth)) { c.ws.close(1008, "authorization revoked"); this.detach(c); return; }
    if (!this.connections.has(c) || c.ws.readyState !== 1) return;
    const m = JSON.parse(raw); c.seen = this.now();
    if (m.type === "ping") {
      if (Number.isInteger(m.running) && m.running >= 0 && m.running <= c.meta.capacity) c.running = m.running;
      c.ws.send(JSON.stringify({ type: "pong" })); return;
    }
    if (m.type === "result") {
      const p = this.pending.get(m.id);
      if (!p || p.connection !== c) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) {
        const status = Number(m.error.status);
        p.reject(new RelayError(String(m.error.code || "LEADER_ERROR"), String(m.error.message || "Leader rejected request"),
          Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400));
      }
      else p.resolve(m.result);
      return;
    }
    if (m.type !== "call" || typeof m.id !== "string" || m.id.length > 100) throw new RelayError("INVALID_FRAME", "Invalid frame", 400);
    try {
      if (m.scopeRoomId !== undefined && (!roomIdValid(m.scopeRoomId) || (c.meta.scopeRoomId && c.meta.scopeRoomId !== m.scopeRoomId))) {
        throw new RelayError("INVALID_SCOPE", "Room scope cannot be widened or changed", 403);
      }
      const scopeRoomId = c.meta.scopeRoomId || m.scopeRoomId;
      if (scopeRoomId && !["directory", "agents.list", "rooms.list"].includes(m.action) && m.input?.roomId !== scopeRoomId) {
        throw new RelayError("INVALID_SCOPE", "Request must target its scoped Room", 403);
      }
      const result = m.action === "directory" ? this.list() : await this.call(m.leaderId, {
        kind: "agent", id: c.meta.id, ...(scopeRoomId ? { roomId: scopeRoomId } : {}),
      }, m.action, m.input);
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: "reply", id: m.id, result }));
    } catch (e) {
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: "reply", id: m.id, error: { code: e.code || "RELAY_FAILED", message: e.message, status: e.status || 500 } }));
    }
  }
  async call(leaderId, principal, action, input = {}) {
    this.prune();
    if (!roomIdValid(leaderId) || typeof action !== "string" || action.length > 80 || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new RelayError("INVALID_REQUEST", "Invalid Room command", 400);
    }
    if (this.pending.size >= 128) throw new RelayError("CAPACITY", "Too many pending requests", 429);
    const c = [...this.connections].find((c) => c.meta.id === leaderId && c.meta.leader && c.ws.readyState === 1 && this.now() - c.seen <= 45_000);
    if (!c) throw new RelayError("LEADER_OFFLINE", "Leader is offline; Room history stays on the leader", 503);
    if (!await this.authorize(c.auth)) { c.ws.close(1008, "authorization revoked"); this.detach(c); throw new RelayError("LEADER_OFFLINE", "Leader authorization revoked", 503); }
    const devices = await this.devices();
    this.prune();
    // Both awaits above yield: capacity and ownership must be checked again before dispatch.
    if (!this.connections.has(c) || c.ws.readyState !== 1) throw new RelayError("LEADER_OFFLINE", "Leader disconnected before dispatch", 503);
    if (this.pending.size >= 128) throw new RelayError("CAPACITY", "Too many pending requests", 429);
    const frame = { type: "request", id: crypto.randomUUID(), principal, action, input, agents: this.list().agents, devices };
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).length > ROOM_FRAME_LIMIT) throw new RelayError("FRAME_TOO_LARGE", "Room command too large", 413);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new RelayError("LEADER_TIMEOUT", "Leader did not acknowledge; retry only with the same requestId", 504));
      }, this.timeoutMs);
      this.pending.set(frame.id, { connection: c, resolve, reject, timer });
      try { c.ws.send(text); } catch (e) { this.pending.delete(frame.id); clearTimeout(timer); reject(e); }
    });
  }
  close() { for (const c of this.connections) { c.ws.close(1001, "shutdown"); this.detach(c); } }
}
