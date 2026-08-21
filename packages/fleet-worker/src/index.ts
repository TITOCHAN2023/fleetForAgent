/**
 * Fleet hub — Cloudflare Worker + Durable Objects.
 *
 * Devices (Windows / Mac / Linux agents) dial OUT over WSS to /v1/device.
 * Operators call HTTPS: list_computers / select_computer / run / get_result.
 * No inbound ports on the machines. No intranet overlay.
 *
 * Auth: set secret HUB_TOKEN (wrangler secret put HUB_TOKEN). Empty = open (dev only).
 */

export interface Env {
  DEVICE: DurableObjectNamespace;
  FLEET: DurableObjectNamespace;
  HUB_TOKEN?: string;
}

type Envelope = {
  v: 1;
  type: string;
  id: string;
  corr?: string;
  t: number;
  body: Record<string, unknown>;
};

type DeviceRow = {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen: number;
  agentVer?: string;
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/v1/health") {
      return json({ name: "fleet-hub", v: 1, ok: true });
    }

    if (url.pathname === "/v1/device") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      const deviceId = deviceIdFrom(request);
      if (!deviceId) return json({ error: "x-device-id required" }, 400);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
      return stub.fetch(request);
    }

    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

    const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));

    if (url.pathname === "/v1/list_computers" && request.method === "POST") {
      return fleet.fetch(new Request("https://fleet/list", { method: "GET" }));
    }

    if (url.pathname === "/v1/select_computer" && request.method === "POST") {
      const body = (await request.json()) as { id?: string };
      if (!body.id) return json({ error: "id required" }, 400);
      return json({ selected: body.id });
    }

    if (url.pathname === "/v1/run" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; command?: string };
      if (!body.device_id || !body.command) {
        return json({ error: "device_id and command required" }, 400);
      }
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      return stub.fetch(
        new Request("https://device/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: body.command }),
        }),
      );
    }

    if (url.pathname === "/v1/type" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; keys?: string; corr?: string };
      if (!body.device_id || body.keys == null) return json({ error: "device_id and keys required" }, 400);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      return stub.fetch(
        new Request("https://device/type", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: body.keys, corr: body.corr }),
        }),
      );
    }

    if (url.pathname === "/v1/read_screen" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; corr?: string };
      if (!body.device_id) return json({ error: "device_id required" }, 400);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      const q = body.corr ? `?corr=${encodeURIComponent(body.corr)}` : "";
      return stub.fetch(new Request(`https://device/screen${q}`));
    }

    if (url.pathname === "/v1/list_panes" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string };
      if (!body.device_id) return json({ error: "device_id required" }, 400);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      return stub.fetch(new Request("https://device/panes", { method: "POST" }));
    }

    if (url.pathname === "/v1/get_result" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; corr?: string };
      if (!body.device_id || !body.corr) return json({ error: "device_id and corr required" }, 400);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      return stub.fetch(new Request(`https://device/result?corr=${encodeURIComponent(body.corr)}`));
    }

    return json({ error: "not found" }, 404);
  },
};

export class FleetDO implements DurableObject {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/list") {
      const computers = await this.list();
      return json({ computers });
    }
    if (url.pathname === "/upsert" && request.method === "POST") {
      const row = (await request.json()) as DeviceRow;
      await this.ctx.storage.put(`d:${row.id}`, row);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async list(): Promise<DeviceRow[]> {
    const map = await this.ctx.storage.list<DeviceRow>({ prefix: "d:" });
    const rows = [...map.values()];
    rows.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
    return rows;
  }
}

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
      const id = deviceIdFrom(request) ?? "unknown";
      pair[1].serializeAttachment({
        deviceId: id,
        name: request.headers.get("x-device-name") ?? id,
        os: request.headers.get("x-device-os") ?? "linux",
      });
      pair[1].send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 25 })));
      await this.mark(id, {
        name: request.headers.get("x-device-name") ?? id,
        os: request.headers.get("x-device-os") ?? "linux",
        online: true,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as { command: string };
      const corr = crypto.randomUUID();
      sockets[0]!.send(JSON.stringify(envelope("run", { command: body.command, mode: "pane" }, corr)));
      return json({ corr, status: "running" });
    }

    if (url.pathname === "/type" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as { keys: string; corr?: string };
      sockets[0]!.send(JSON.stringify(envelope("type", { keys: body.keys, corr: body.corr })));
      return json({ ok: true, status: "typed" });
    }

    if (url.pathname === "/screen") {
      const sockets = this.ctx.getWebSockets();
      const corr = url.searchParams.get("corr") ?? "";
      if (sockets.length) {
        sockets[0]!.send(JSON.stringify(envelope("read_screen", { corr }, corr || undefined)));
      }
      const key = corr ? `screen:${corr}` : "screen:last";
      const row = (await this.ctx.storage.get<Record<string, unknown>>(key)) ??
        (await this.ctx.storage.get<Record<string, unknown>>("screen:last"));
      return json({ status: row ? "ok" : "empty", screen: row ?? null });
    }

    if (url.pathname === "/panes" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ panes: [] });
      sockets[0]!.send(JSON.stringify(envelope("list_panes", {})));
      return json({ ok: true, status: "asked" });
    }

    if (url.pathname === "/result") {
      const corr = url.searchParams.get("corr") ?? "";
      const row = await this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`);
      if (!row) return json({ status: "pending", corr });
      return json({ status: "done", corr, ...row });
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
    const att = (ws.deserializeAttachment() ?? {}) as { deviceId?: string; name?: string; os?: string };

    if (parsed.type === "hello") {
      const os = String(parsed.body.os ?? att.os ?? "linux");
      const name = String(parsed.body.hostname ?? att.name ?? att.deviceId ?? "device");
      await this.mark(att.deviceId ?? "unknown", {
        name,
        os,
        online: true,
        agentVer: String(parsed.body.agent_ver ?? ""),
      });
      return;
    }

    if (parsed.type === "screen") {
      await this.ctx.storage.put("screen:last", parsed.body);
      if (parsed.corr) await this.ctx.storage.put(`screen:${parsed.corr}`, parsed.body);
      return;
    }

    if (parsed.type === "accepted" && parsed.corr) {
      await this.ctx.storage.put(`res:${parsed.corr}`, {
        status: "running",
        pane_id: parsed.body.pane_id,
      });
      return;
    }

    if (parsed.type === "result" && parsed.corr) {
      await this.ctx.storage.put(`res:${parsed.corr}`, {
        ok: parsed.body.ok ?? false,
        exit_code: parsed.body.exit_code ?? 1,
        error: parsed.body.error ?? "",
        stdout: parsed.body.stdout ?? "",
        t: parsed.t,
      });
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = (ws.deserializeAttachment() ?? {}) as { deviceId?: string; name?: string; os?: string };
    if (att.deviceId) {
      await this.mark(att.deviceId, { name: att.name ?? att.deviceId, os: att.os ?? "linux", online: false });
    }
  }

  private fleet() {
    return this.env.FLEET.get(this.env.FLEET.idFromName("fleet"));
  }

  private async mark(
    id: string,
    extra: { name: string; os: string; online: boolean; agentVer?: string },
  ) {
    const row: DeviceRow = {
      id,
      name: extra.name,
      os: extra.os,
      online: extra.online,
      lastSeen: Date.now(),
      agentVer: extra.agentVer,
    };
    await this.fleet().fetch(
      new Request("https://fleet/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      }),
    );
  }
}

function authorized(request: Request, env: Env): boolean {
  const need = env.HUB_TOKEN?.trim();
  if (!need) return true;
  return bearer(request) === need;
}

function bearer(request: Request) {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function deviceIdFrom(request: Request): string | null {
  const header = request.headers.get("x-device-id")?.trim();
  if (header) return header;
  const q = new URL(request.url).searchParams.get("id")?.trim();
  return q || null;
}

function envelope(type: string, body: Record<string, unknown> = {}, corr?: string): Envelope {
  const env: Envelope = { v: 1, type, id: crypto.randomUUID(), t: Date.now(), body };
  if (corr) env.corr = corr;
  return env;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
