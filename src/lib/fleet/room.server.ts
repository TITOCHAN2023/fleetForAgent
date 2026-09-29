import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Hooks, Peer } from "crossws";
import { RoomRelay, ROOM_FRAME_LIMIT, relayRegistration } from "../../../packages/fleet-room/relay.mjs";

export type RoomCredential = { userId: string; kid: string; tokenHash: string };
type Services = {
  authenticate(headers: Headers): Promise<RoomCredential | null>;
  current(credential: RoomCredential): Promise<boolean>;
  devices(userId: string): Promise<unknown[]>;
};
export type RoomHttpActor = { userId: string; current(): Promise<boolean> };
const globalRooms = globalThis as typeof globalThis & {
  __fleetAppRooms__?: Map<string, RoomRelay<RoomCredential>>;
  __fleetAppRoomWss__?: WebSocketServer;
};
const relays = () => globalRooms.__fleetAppRooms__ ??= new Map();

export function appRoomRelay(userId: string, services: Services): RoomRelay<RoomCredential> {
  const existing = relays().get(userId);
  if (existing) return existing;
  for (const [id, relay] of relays()) {
    relay.prune();
    if (!relay.connections.size && !relay.pending.size) relays().delete(id);
  }
  if (relays().size >= 256) throw Object.assign(new Error("Room account connection limit reached"), { status: 429 });
  const relay = new RoomRelay({
    authorize: async (credential: RoomCredential) => credential.userId === userId && services.current(credential),
    devices: () => services.devices(userId),
  });
  relays().set(userId, relay);
  return relay;
}

export const isAppRoomPath = (path: string) => ["/v1/room-agent", "/v1/room-agents", "/v1/room-control"].includes(path);
export function roomResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
export function roomFailure(error: unknown): Response {
  const err = error as { message?: string; code?: string; status?: number };
  const status = Number.isInteger(err.status) && err.status! >= 400 && err.status! <= 599 ? err.status! : 400;
  return roomResponse({ error: err.message || "Room request failed", code: err.code || "INVALID_REQUEST" }, status);
}

/** Body bytes remain in this request only. Reject before JSON parsing and
 * revalidate the original credential after this possibly slow stream ends. */
export async function readAppRoomBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ROOM_FRAME_LIMIT) {
        void reader.cancel().catch(() => {});
        throw Object.assign(new Error("Room request exceeds 128 KiB"), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value;
}

export function assertRoomCookieOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(request.url).origin)) {
    throw Object.assign(new Error("Cross-origin Room session request rejected"), { status: 403 });
  }
}

export async function handleAppRoomHttp(request: Request, actor: RoomHttpActor, services: Services): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (path === "/v1/room-agent") return roomResponse({ error: "WebSocket upgrade required" }, 426);
    if (path === "/v1/room-agents" && request.method === "GET") {
      if (!await actor.current()) return roomResponse({ error: "unauthorized" }, 401);
      return roomResponse(appRoomRelay(actor.userId, services).list());
    }
    if (path !== "/v1/room-control" || request.method !== "POST") return roomResponse({ error: "not found" }, 404);
    const body = await readAppRoomBody(request);
    if (!await actor.current()) return roomResponse({ error: "unauthorized" }, 401);
    if (Object.keys(body).some((key) => !["leaderId", "action", "input"].includes(key))) throw new Error("Unexpected Room envelope field");
    const result = await appRoomRelay(actor.userId, services).call(body.leaderId, { kind: "user", id: actor.userId }, body.action, body.input ?? {});
    if (!await actor.current()) return roomResponse({ error: "unauthorized" }, 401);
    return roomResponse(result);
  } catch (error) { return roomFailure(error); }
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

async function prepare(headers: Headers, services: Services) {
  const credential = await services.authenticate(headers);
  if (!credential || !await services.current(credential)) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const meta = relayRegistration(headers);
  return { credential, meta, relay: appRoomRelay(credential.userId, services) };
}

export async function handleAppRoomUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, services: Services): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://hub").pathname !== "/v1/room-agent") return false;
  try {
    const { credential, meta, relay } = await prepare(requestHeaders(req), services);
    if (socket.destroyed) return true;
    globalRooms.__fleetAppRoomWss__ ??= new WebSocketServer({ noServer: true, maxPayload: ROOM_FRAME_LIMIT });
    globalRooms.__fleetAppRoomWss__.handleUpgrade(req, socket, head, (ws) => {
      try { relay.attach(ws, meta, credential); }
      catch { ws.close(1008, "Room registration rejected"); }
    });
  } catch (error) {
    const status = roomFailure(error).status;
    socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
  return true;
}

// Nitro's crossws production path uses the same authority and relay as Vite.
// This adapter holds only the live peer; it has no persistence or content log.
class RelayPeerSocket extends EventTarget {
  readyState = 1;
  constructor(readonly peer: Peer) { super(); }
  send(text: string) {
    if (this.readyState !== 1) throw new Error("Room peer closed");
    if (new TextEncoder().encode(text).length > ROOM_FRAME_LIMIT || this.peer.bufferedAmount > ROOM_FRAME_LIMIT * 4) throw new Error("Room frame/backlog limit reached");
    this.peer.send(text);
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.peer.close(code, reason);
    this.dispatchEvent(new Event("close"));
  }
}

export function createAppRoomWebSocketHooks(services: Services): Partial<Hooks> {
  return {
    async upgrade(request) {
      try { return { context: { fleetRoom: await prepare(request.headers, services) } }; }
      catch (error) { return roomFailure(error); }
    },
    async open(peer) {
      const prepared = peer.context.fleetRoom as Awaited<ReturnType<typeof prepare>>;
      if (!prepared || !await services.current(prepared.credential)) { peer.close(1008, "authorization revoked"); return; }
      const socket = new RelayPeerSocket(peer);
      peer.context.roomSocket = socket;
      try { prepared.relay.attach(socket, prepared.meta, prepared.credential); }
      catch { socket.close(1008, "Room registration rejected"); }
    },
    message(peer, message) {
      const socket = peer.context.roomSocket as RelayPeerSocket | undefined;
      if (socket?.readyState === 1) socket.dispatchEvent(new MessageEvent("message", { data: message.text() }));
    },
    close(peer) { (peer.context.roomSocket as RelayPeerSocket | undefined)?.close(); },
    error(peer) { (peer.context.roomSocket as RelayPeerSocket | undefined)?.close(1011, "Room transport failed"); },
  };
}
