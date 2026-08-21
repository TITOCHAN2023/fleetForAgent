/**
 * KEEL hub — Cloudflare Worker + one Durable Object per device.
 * Devices connect OUT over WSS. Agents call HTTPS tools.
 *
 * Deploy later with wrangler. This preview uses the same envelope
 * in src/lib/fleet/protocol.ts against a simulated fleet.
 */

export interface Env {
  DEVICE: DurableObjectNamespace;
  HUB_SIGNING_KEY: string;
}

type Envelope = {
  v: 1;
  type: string;
  id: string;
  corr?: string;
  t: number;
  body: Record<string, unknown>;
};

function envelope(type: string, body: Record<string, unknown> = {}, corr?: string): Envelope {
  const env: Envelope = { v: 1, type, id: crypto.randomUUID(), t: Date.now(), body };
  if (corr) env.corr = corr;
  return env;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/device") {
      const deviceId = request.headers.get("x-device-id");
      const token = bearer(request);
      if (!deviceId || !token) return json({ error: "unauthorized" }, 401);
      const id = env.DEVICE.idFromName(deviceId);
      return env.DEVICE.get(id).fetch(request);
    }

    if (url.pathname === "/v1/list_computers" && request.method === "POST") {
      if (!bearer(request)) return json({ error: "unauthorized" }, 401);
      return json({ computers: [] });
    }

    if (url.pathname === "/v1/select_computer" && request.method === "POST") {
      if (!bearer(request)) return json({ error: "unauthorized" }, 401);
      const body = (await request.json()) as { id?: string };
      if (!body.id) return json({ error: "id required" }, 400);
      const id = env.DEVICE.idFromName(body.id);
      return env.DEVICE.get(id).fetch(
        new Request(new URL("/select", request.url), { method: "POST", headers: request.headers }),
      );
    }

    if (url.pathname === "/v1/run" && request.method === "POST") {
      if (!bearer(request)) return json({ error: "unauthorized" }, 401);
      const body = (await request.json()) as { device_id?: string; command?: string };
      if (!body.device_id || !body.command) return json({ error: "device_id and command required" }, 400);
      const id = env.DEVICE.idFromName(body.device_id);
      return env.DEVICE.get(id).fetch(
        new Request(new URL("/run", request.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: body.command }),
        }),
      );
    }

    return json({ name: "keel-hub", v: 1 }, 200);
  },
};

export class DeviceDO implements DurableObject {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      for (const extra of this.ctx.getWebSockets()) {
        if (extra !== pair[1]) extra.close(1012, "replaced");
      }
      pair[1].serializeAttachment({ connectedAt: Date.now() });
      pair[1].send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 25 })));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as { command: string };
      const corr = crypto.randomUUID();
      const msg = envelope("run", { command: body.command, timeout_ms: 25000 }, corr);
      sockets[0]!.send(JSON.stringify(msg));
      return json({ corr, status: "running" });
    }

    return json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let parsed: Envelope;
    try {
      parsed = JSON.parse(message) as Envelope;
    } catch {
      return;
    }
    if (parsed.v !== 1) {
      ws.close(1003, "bad proto");
      return;
    }
    if (parsed.type === "pong" || parsed.type === "hello" || parsed.type === "result" || parsed.type === "chunk") {
      return;
    }
  }

  async webSocketClose() {
    /* presence drops when no sockets remain */
  }
}

function bearer(request: Request) {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
