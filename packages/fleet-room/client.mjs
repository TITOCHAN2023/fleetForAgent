import { WebSocket } from "ws";
import { highSecAuthorization } from "../fleet-worker/src/tokenv1.mjs";
import { ROOM_FRAME_LIMIT } from "./relay.mjs";

const disconnected = () => Object.assign(new Error("Connection lost; task outcome may be unknown; retain requestId for retry"), { code: "DISCONNECTED" });

export class RoomConnection {
  constructor({ url, token, id, name = id, mode = "mcp", leader = false, capacity = 2, roomId, onRequest, onClose,
    requestTimeoutMs = 25_000, connectTimeoutMs = 12_000, heartbeatIntervalMs = 10_000, pongTimeoutMs = 10_000 }) {
    for (const [key, value] of Object.entries({ requestTimeoutMs, connectTimeoutMs, heartbeatIntervalMs, pongTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be positive`);
    }
    Object.assign(this, { url: url.replace(/\/$/, ""), token, id, name, mode, leader, capacity, roomId, onRequest, onClose,
      requestTimeoutMs, connectTimeoutMs, heartbeatIntervalMs, pongTimeoutMs });
    this.pending = new Map(); this.running = 0;
  }
  async connect() {
    if (this.connecting) throw new Error("Room connection is already connecting");
    if (this.attempt && !this.attempt.done) throw new Error("Room connection is already connected");
    this.connecting = true;
    const attempt = { abort: new AbortController(), done: false, ready: false };
    this.attempt = attempt;
    const timer = setTimeout(() => this.finish(attempt, Object.assign(new Error("Room connection timed out"), { code: "CONNECT_TIMEOUT" })), this.connectTimeoutMs);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(attempt.abort.signal.reason);
      attempt.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // The deadline starts before authorization, including crypto, fetch and
      // response body parsing. close() also aborts the actual challenge fetch.
      await Promise.race([this.openConnection(attempt), aborted]);
      return this;
    } catch (error) {
      this.finish(attempt, error);
      throw error;
    } finally {
      clearTimeout(timer);
      attempt.abort.signal.removeEventListener("abort", onAbort);
      this.connecting = false;
    }
  }
  async openConnection(attempt) {
    const signal = attempt.abort.signal;
    const authorization = await highSecAuthorization(this.token, this.url, (input, init = {}) => fetch(input, { ...init, signal }));
    signal.throwIfAborted();
    const endpoint = new URL("/v1/room-agent", this.url); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const headers = { authorization, "x-room-agent-id": this.id, "x-room-agent-name": encodeURIComponent(this.name),
      "x-room-agent-mode": this.mode, "x-room-capacity": String(this.capacity), "x-room-leader": this.leader ? "1" : "0" };
    if (this.roomId) headers["x-room-scope"] = this.roomId;
    const ws = new WebSocket(endpoint, { headers, maxPayload: ROOM_FRAME_LIMIT, handshakeTimeout: this.connectTimeoutMs });
    attempt.ws = ws; this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.on("error", () => { const error = new Error("Room connection failed"); this.finish(attempt, error); reject(error); });
      ws.on("close", () => { const error = new Error("Room connection closed"); this.finish(attempt, error); reject(error); });
      ws.on("message", (data) => {
        if (attempt.done) return;
        let m;
        try {
          m = JSON.parse(String(data));
          if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.type !== "string") throw new Error("invalid message");
        } catch { this.finish(attempt, new Error("Invalid Room message")); return; }
        if (m.type === "ready") {
          if (attempt.ready) { this.finish(attempt, new Error("Duplicate Room ready frame")); return; }
          attempt.ready = true;
          this.startHeartbeat(attempt);
          resolve();
        }
        if (m.type === "pong" && attempt.waitingForPong) {
          clearTimeout(attempt.pongTimer); attempt.waitingForPong = false;
        }
        if (m.type === "reply") {
          const p = this.pending.get(m.id); if (!p) return;
          this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(Object.assign(new Error(m.error.message), m.error)); else p.resolve(m.result);
        }
        if (m.type === "request" && this.onRequest) void this.handle(m, attempt);
      });
    });
  }
  startHeartbeat(attempt) {
    attempt.heartbeat = setInterval(() => {
      if (attempt.done || attempt.waitingForPong) return;
      attempt.waitingForPong = true;
      attempt.pongTimer = setTimeout(() => this.finish(attempt, Object.assign(new Error("Room heartbeat pong timed out"), { code: "PONG_TIMEOUT" })), this.pongTimeoutMs);
      attempt.pongTimer.unref?.();
      try { this.send({ type: "ping", running: this.running }, attempt); }
      catch (error) { this.finish(attempt, error); }
    }, this.heartbeatIntervalMs);
    attempt.heartbeat.unref?.();
  }
  finish(attempt, error = disconnected()) {
    if (!attempt || attempt.done) return;
    attempt.done = true;
    clearInterval(attempt.heartbeat); clearTimeout(attempt.pongTimer);
    attempt.abort.abort(error);
    // terminate also closes a half-open socket whose close handshake could hang.
    if (attempt.ws && attempt.ws.readyState !== WebSocket.CLOSED) attempt.ws.terminate();
    if (this.attempt !== attempt) return;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(disconnected()); }
    this.pending.clear();
    this.onClose?.(error);
  }
  send(value, attempt = this.attempt) {
    if (!attempt || attempt !== this.attempt || attempt.done || attempt.ws?.readyState !== WebSocket.OPEN) throw disconnected();
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > ROOM_FRAME_LIMIT) throw Object.assign(new Error("Room frame exceeds byte limit"), { code: "FRAME_TOO_LARGE", status: 413 });
    if (attempt.ws.bufferedAmount + Buffer.byteLength(text) > ROOM_FRAME_LIMIT * 4) throw Object.assign(new Error("Room connection output is backlogged"), { code: "BACKPRESSURE", status: 429 });
    attempt.ws.send(text);
  }
  async handle(m, attempt = this.attempt) {
    try { this.send({ type: "result", id: m.id, result: await this.onRequest(m) }, attempt); }
    catch (e) {
      try { this.send({ type: "result", id: m.id, error: { code: e.code || "LEADER_ERROR", status: e.status || 400, message: e.message } }, attempt); }
      catch (error) { this.finish(attempt, error); }
    }
  }
  call(leaderId, action, input = {}, { scopeRoomId } = {}) {
    if (!this.attempt?.ready || this.attempt.done || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(disconnected());
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error("Room request timed out; retain requestId for retry"), { code: "TIMEOUT" })); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: "call", id, leaderId, action, input, ...(scopeRoomId === undefined ? {} : { scopeRoomId }) }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  close() { this.finish(this.attempt); }
}
