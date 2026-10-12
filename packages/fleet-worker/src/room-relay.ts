import { RoomRelay, relayRegistration, ROOM_FRAME_LIMIT } from "../../fleet-room/relay.mjs";

export async function readRoomBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ROOM_FRAME_LIMIT) {
        await reader.cancel();
        throw Object.assign(new Error("Room request too large"), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** No storage calls: eviction disconnects peers; only leaders retain Room records. */
export class RoomRelayDO {
  relay: RoomRelay;
  userId = "";
  constructor(_ctx: DurableObjectState, env: { FLEET: DurableObjectNamespace }) {
    const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));
    this.relay = new RoomRelay({
      authorize: async (auth: { id: string; kid?: string }) => {
        if (!auth.kid) return false;
        return (await fleet.fetch(new Request("https://fleet/validate-mcp", {
          method: "POST", body: JSON.stringify(auth),
        }))).ok;
      },
      devices: async () => {
        const res = await fleet.fetch(new Request(`https://fleet/list?user=${encodeURIComponent(this.userId)}`));
        const body = await res.json() as { computers?: unknown[] } | unknown[];
        return Array.isArray(body) ? body : body.computers || [];
      },
    });
  }
  async fetch(request: Request) {
    this.userId = request.headers.get("x-fleet-user") || "";
    if (!this.userId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const path = new URL(request.url).pathname;
    try {
      if (path === "/v1/room-agent") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
        const meta = relayRegistration(request.headers);
        const pair = new WebSocketPair(); pair[1].accept();
        try { this.relay.attach(pair[1], meta, { id: this.userId, kid: request.headers.get("x-fleet-kid") }); }
        catch (e) { pair[1].close(1008, "registration rejected"); throw e; }
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (path === "/v1/room-agents" && request.method === "GET") return Response.json(this.relay.list());
      if (path !== "/v1/room-control" || request.method !== "POST") return new Response("Not found", { status: 404 });
      const raw = new TextDecoder().decode(await readRoomBody(request));
      const { leaderId, action, input } = JSON.parse(raw);
      return Response.json(await this.relay.call(leaderId, { kind: "user", id: this.userId }, action, input));
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      return Response.json({ error: err.message || "Room request failed", code: err.code || "INVALID_REQUEST" }, { status: err.status || 400 });
    }
  }
}
