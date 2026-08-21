/**
 * Hub wire on the website origin. App assembles /v1/*.
 * Bearer is the per-account hub token (flt_…), not the login session.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getSql } from "@/lib/db";
import { makeDeviceSlug } from "./cap";
import {
  attachDevice,
  detachDevice,
  getResult,
  getScreen,
  isOnline,
  putResult,
  putScreen,
  sendToDevice,
} from "./live";
import { bearerToken, hashHubToken, isHubToken } from "./token";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

type Envelope = {
  v: 1;
  type: string;
  id: string;
  corr?: string;
  t: number;
  body: Record<string, unknown>;
};

const g = globalThis as typeof globalThis & { __fleetWss__?: WebSocketServer };

function wss(): WebSocketServer {
  g.__fleetWss__ ??= new WebSocketServer({ noServer: true });
  return g.__fleetWss__;
}

export async function lookupHubUser(authorization: string | null | undefined): Promise<string | null> {
  const raw = bearerToken(authorization);
  if (!isHubToken(raw)) return null;
  const sql = await getSql();
  const rows = await sql<{ user_id: string }>`
    select user_id from hub_tokens where token_hash = ${hashHubToken(raw)}
  `;
  return rows[0]?.user_id ?? null;
}

export async function handleHubHttp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v1/health" || path === "/v1") {
    return json({ name: "fleet-hub", v: 1, ok: true, backend: "app" });
  }

  const userId = await lookupHubUser(request.headers.get("authorization"));
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    const text = (await request.text()).trim();
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
    }
  }

  if (path === "/v1/list_computers" && request.method === "POST") {
    return json({ computers: await listComputers(userId) });
  }

  if (path === "/v1/select_computer" && request.method === "POST") {
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const sql = await getSql();
    const found = await sql<{ id: string }>`
      select id from devices where id = ${id} and user_id = ${userId}
    `;
    if (!found[0]) return json({ error: "not found" }, 404);
    await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${userId}, ${id}, now())
      on conflict (user_id) do update set selected_device_id = excluded.selected_device_id, selected_at = now()
    `;
    return json({ selected: id });
  }

  if (path === "/v1/run" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    const command = String(body.command ?? "");
    if (!deviceId || !command) return json({ error: "device_id and command required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    const corr = randomUUID();
    const ok = sendToDevice(userId, deviceId, envelope("run", { command, mode: "pane" }, corr));
    if (!ok) return json({ error: "offline" }, 409);
    const sql = await getSql();
    await sql`
      insert into commands (id, user_id, device_id, command, status)
      values (${corr}, ${userId}, ${deviceId}, ${command}, ${"running"})
    `;
    return json({ corr, status: "running" });
  }

  if (path === "/v1/type" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId || body.keys == null) return json({ error: "device_id and keys required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    const ok = sendToDevice(
      userId,
      deviceId,
      envelope("type", { keys: body.keys, corr: body.corr }),
    );
    if (!ok) return json({ error: "offline" }, 409);
    return json({ ok: true, status: "typed" });
  }

  if (path === "/v1/read_screen" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId) return json({ error: "device_id required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    const corr = body.corr != null ? String(body.corr) : "";
    sendToDevice(userId, deviceId, envelope("read_screen", { corr }, corr || undefined));
    const row = getScreen(deviceId, corr || undefined);
    return json({ status: row ? "ok" : "empty", screen: row });
  }

  if (path === "/v1/list_panes" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId) return json({ error: "device_id required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    if (!sendToDevice(userId, deviceId, envelope("list_panes", {}))) {
      return json({ panes: [] });
    }
    return json({ ok: true, status: "asked" });
  }

  if (path === "/v1/get_result" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    const corr = String(body.corr ?? "");
    if (!deviceId || !corr) return json({ error: "device_id and corr required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    const row = getResult(deviceId, corr);
    if (!row) return json({ status: "pending", corr });
    return json({ status: "done", corr, ...row });
  }

  return json({ error: "not found" }, 404);
}

export async function handleHubUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? "/", "http://hub");
  if (url.pathname !== "/v1/device") return false;

  const userId = await lookupHubUser(header(req, "authorization"));
  if (!userId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }
  const deviceId = header(req, "x-device-id");
  if (!deviceId) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }

  const stolen = await stolenDevice(userId, deviceId);
  if (stolen) {
    socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }

  wss().handleUpgrade(req, socket, head, (ws) => {
    void acceptDevice(ws, req, userId, deviceId);
  });
  return true;
}

async function acceptDevice(ws: WebSocket, req: IncomingMessage, userId: string, deviceId: string) {
  const name = header(req, "x-device-name") || deviceId;
  const os = header(req, "x-device-os") || "linux";
  attachDevice(userId, deviceId, ws);
  await upsertDevice(userId, deviceId, { name, os, arch: "unknown", online: true });
  ws.send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 25 })));

  ws.on("message", (data) => {
    if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
    let parsed: Envelope;
    try {
      parsed = JSON.parse(String(data)) as Envelope;
    } catch {
      return;
    }
    void onDeviceMessage(userId, deviceId, ws, parsed);
  });
  ws.on("close", () => {
    detachDevice(deviceId, ws);
    void upsertDevice(userId, deviceId, { name, os, arch: "unknown", online: false });
  });
}

async function onDeviceMessage(userId: string, deviceId: string, ws: WebSocket, parsed: Envelope) {
  if (parsed.v !== 1) {
    ws.close(1003, "bad proto");
    return;
  }
  if (parsed.type === "hello") {
    await upsertDevice(userId, deviceId, {
      name: String(parsed.body.hostname ?? deviceId),
      os: String(parsed.body.os ?? "linux"),
      arch: String(parsed.body.arch ?? "unknown"),
      online: true,
      agentVer: String(parsed.body.agent_ver ?? ""),
    });
    return;
  }
  if (parsed.type === "screen") {
    putScreen(deviceId, parsed.body ?? {}, parsed.corr);
    return;
  }
  if (parsed.type === "accepted" && parsed.corr) {
    putResult(deviceId, parsed.corr, { status: "running", pane_id: parsed.body.pane_id });
    return;
  }
  if (parsed.type === "result" && parsed.corr) {
    const row = {
      ok: parsed.body.ok ?? false,
      exit_code: parsed.body.exit_code ?? 1,
      error: parsed.body.error ?? "",
      stdout: parsed.body.stdout ?? "",
      t: parsed.t,
    };
    putResult(deviceId, parsed.corr, row);
    const sql = await getSql();
    await sql`
      update commands
      set status = ${row.ok ? "ok" : "error"},
          exit_code = ${Number(row.exit_code)},
          stdout = ${String(row.stdout)},
          stderr = ${String(row.error)}
      where id = ${parsed.corr} and user_id = ${userId}
    `;
  }
}

async function listComputers(userId: string) {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    name: string;
    os: string;
    status: string;
    last_seen: string | Date;
  }>`
    select id, name, os, status, last_seen
    from devices
    where user_id = ${userId}
    order by created_at asc
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    os: r.os,
    online: isOnline(r.id),
    lastSeen: r.last_seen instanceof Date ? r.last_seen.getTime() : new Date(r.last_seen).getTime(),
  }));
}

async function ownsDevice(userId: string, deviceId: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    select id from devices where id = ${deviceId} and user_id = ${userId}
  `;
  return Boolean(rows[0]);
}

async function stolenDevice(userId: string, deviceId: string) {
  const sql = await getSql();
  const rows = await sql<{ user_id: string }>`select user_id from devices where id = ${deviceId}`;
  return Boolean(rows[0] && rows[0].user_id !== userId);
}

async function upsertDevice(
  userId: string,
  deviceId: string,
  extra: { name: string; os: string; arch: string; online: boolean; agentVer?: string },
) {
  const sql = await getSql();
  const existing = await sql<{ user_id: string; slug: string }>`
    select user_id, slug from devices where id = ${deviceId}
  `;
  if (existing[0] && existing[0].user_id !== userId) return;
  const status = extra.online ? "online" : "offline";
  const arch = extra.arch || "unknown";
  if (!existing[0]) {
    const slug = makeDeviceSlug(extra.name);
    await sql`
      insert into devices (id, user_id, slug, name, os, arch, location_tag, status, caps)
      values (${deviceId}, ${userId}, ${slug}, ${extra.name}, ${extra.os}, ${arch}, ${"home"}, ${status}, ${"shell,pane"})
    `;
    return;
  }
  if (arch !== "unknown") {
    await sql`
      update devices
      set name = ${extra.name}, os = ${extra.os}, arch = ${arch},
          status = ${status}, last_seen = now(), caps = ${"shell,pane"}
      where id = ${deviceId} and user_id = ${userId}
    `;
    return;
  }
  await sql`
    update devices
    set name = ${extra.name}, os = ${extra.os},
        status = ${status}, last_seen = now(), caps = ${"shell,pane"}
    where id = ${deviceId} and user_id = ${userId}
  `;
}

function envelope(type: string, body: Record<string, unknown> = {}, corr?: string): Envelope {
  const env: Envelope = { v: 1, type, id: randomUUID(), t: Date.now(), body };
  if (corr) env.corr = corr;
  return env;
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0]?.trim() || null;
  return typeof v === "string" ? v.trim() || null : null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
