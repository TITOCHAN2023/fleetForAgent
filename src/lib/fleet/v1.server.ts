/**
 * Hub wire on the website origin. App assembles /v1/*.
 * Operators present Fleet-OAEP wraps of flt_1 tokens, not plaintext Bearer.
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
import {
  CHALLENGE_TTL_MS,
  HIGH_SEC_HANDSHAKE,
  HIGH_SEC_KEY_MISMATCH,
  HIGH_SEC_UPGRADE,
  createChallengeBook,
  hashHubToken,
  hubOrigin,
  isLegacyFlt,
  parseAuthorization,
  signChallenge,
  unwrapAuth,
} from "./token";

const HUB_WAIT_MAX_MS = 30_000;
const HUB_WAIT_POLL_MS = 25;

function clampHubWaitMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(HUB_WAIT_MAX_MS, n);
}

function isHubResultDone(row: Record<string, unknown> | undefined | null): boolean {
  if (!row) return false;
  if (row.status === "pending" || row.status === "running") return false;
  return row.ok !== undefined || row.exit_code !== undefined || row.status === "done";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHubResult(deviceId: string, corr: string, waitMs: number) {
  const budget = clampHubWaitMs(waitMs);
  const deadline = Date.now() + budget;
  let row = getResult(deviceId, corr);
  if (budget <= 0) return row;
  while (!isHubResultDone(row) && Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(HUB_WAIT_POLL_MS, left));
    row = getResult(deviceId, corr);
  }
  return row;
}

function hubResultPayload(corr: string, row: Record<string, unknown> | undefined) {
  if (!row) return { status: "pending", corr };
  return { status: "done", corr, ...row };
}

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

const gChal = globalThis as typeof globalThis & {
  __fleetChalBook__?: ReturnType<typeof createChallengeBook>;
};

function challenges() {
  gChal.__fleetChalBook__ ??= createChallengeBook();
  return gChal.__fleetChalBook__;
}

function configuredOrigin() {
  return hubOrigin(process.env.FLEET_HUB_ORIGIN || "https://fleet.ginfo.cc") || "https://fleet.ginfo.cc";
}

function highSecJson(error: string, status = 401) {
  return json({ error, code: "HIGH_SEC" }, status);
}

export async function lookupHubUser(authorization: string | null | undefined): Promise<string | null> {
  const got = await lookupHubActor(authorization);
  return got.userId ?? null;
}

async function lookupHubActor(
  authorization: string | null | undefined,
): Promise<{ userId?: string; error?: string; code?: string }> {
  const auth = parseAuthorization(authorization);
  if (auth.kind === "oaep") {
    const sql = await getSql();
    const rows = await sql<{ user_id: string; token_hash: string; kid: string; priv: string }>`
      select user_id, token_hash, kid, priv from hub_tokens where kid = ${auth.kid}
    `;
    const row = rows[0];
    if (!row?.priv || row.kid !== auth.kid) return { error: HIGH_SEC_KEY_MISMATCH, code: "HIGH_SEC" };
    let opened: { sec: string; nonce: string };
    try {
      opened = await unwrapAuth({ privatePkcs8B64: row.priv, wrapB64: auth.wrap });
    } catch {
      return { error: HIGH_SEC_KEY_MISMATCH, code: "HIGH_SEC" };
    }
    const chal = challenges().take(opened.nonce) as
      | { kid: string; userId: string; exp: number }
      | undefined;
    if (!chal || chal.kid !== auth.kid || chal.userId !== row.user_id || chal.exp < Date.now()) {
      return { error: HIGH_SEC_HANDSHAKE, code: "HIGH_SEC" };
    }
    const hash = await hashHubToken(opened.sec);
    if (hash !== row.token_hash) return { error: HIGH_SEC_KEY_MISMATCH, code: "HIGH_SEC" };
    return { userId: row.user_id };
  }
  if (auth.kind === "bearer" && (isLegacyFlt(auth.token) || auth.token.startsWith("flt_1."))) {
    return { error: HIGH_SEC_UPGRADE, code: "HIGH_SEC" };
  }
  return {};
}

async function issueChallenge(kid: string) {
  const origin = configuredOrigin();
  if (!kid) return highSecJson(HIGH_SEC_KEY_MISMATCH);
  const sql = await getSql();
  const rows = await sql<{ user_id: string; kid: string; priv: string }>`
    select user_id, kid, priv from hub_tokens where kid = ${kid}
  `;
  const row = rows[0];
  if (!row?.priv || row.kid !== kid) return highSecJson(HIGH_SEC_KEY_MISMATCH);
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const exp = Date.now() + CHALLENGE_TTL_MS;
  challenges().put(kid, nonce, { userId: row.user_id, exp });
  const sig = await signChallenge({ privatePkcs8B64: row.priv, aud: origin, kid, nonce });
  return json({ nonce, kid, aud: origin, exp, sig });
}

export async function handleHubHttp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v1/health" || path === "/v1") {
    return json({ name: "fleet-hub", v: 1, ok: true, backend: "app" });
  }
  if (path === "/v1/challenge" && request.method === "GET") {
    return issueChallenge(url.searchParams.get("kid") ?? "");
  }

  const got = await lookupHubActor(request.headers.get("authorization"));
  if (got.error) return json({ error: got.error, code: got.code }, 401);
  const userId = got.userId;
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
    const waitMs = clampHubWaitMs(body.wait_ms);
    if (waitMs <= 0) return json({ corr, status: "running" });
    const row = await waitHubResult(deviceId, corr, waitMs);
    return json(hubResultPayload(corr, row));
  }

  if (path === "/v1/type" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId || (body.keys == null && body.key == null)) return json({ error: "device_id and keys or key required" }, 400);
    if (!(await ownsDevice(userId, deviceId))) return json({ error: "not found" }, 404);
    const ok = sendToDevice(
      userId,
      deviceId,
      envelope("type", { keys: body.keys, key: body.key, corr: body.corr }),
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
    const waitMs = clampHubWaitMs(body.wait_ms);
    const row = waitMs > 0 ? await waitHubResult(deviceId, corr, waitMs) : getResult(deviceId, corr);
    return json(hubResultPayload(corr, row));
  }

  return json({ error: "not found" }, 404);
}

export async function handleHubUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? "/", "http://hub");
  if (url.pathname !== "/v1/device") return false;

  const got = await lookupHubActor(header(req, "authorization"));
  const userId = got.userId;
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
  if (parsed.type === "ping" || parsed.type === "heartbeat") {
    const sql = await getSql();
    await sql`
      update devices
      set status = ${"online"}, last_seen = now()
      where id = ${deviceId} and user_id = ${userId}
    `;
    ws.send(JSON.stringify(envelope("pong", {}, parsed.id)));
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
