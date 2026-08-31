/**
 * Hub wire on the website origin. App assembles /v1/*.
 * Operators present Fleet-OAEP wraps of flt_1 tokens, not plaintext Bearer.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getSql } from "@/lib/db";
import { officialPlugin } from "../../../packages/fleet-tool/operator.mjs";
import { makeDeviceSlug } from "./cap";
import {
  DeviceAliasError,
  deviceIdConflictsWithAlias,
  resolveDeviceReference,
} from "./device-alias";
import { setDeviceAliasForUser } from "./device-alias.server";
import {
  attachDevice,
  detachDevice,
  getAgentVer,
  getResult,
  getScreen,
  isOnline,
  noteHeartbeat,
  putAgentVer,
  putResult,
  putScreen,
  sendToDevice,
  waitNextHeartbeat,
  cancelHeartbeatWait,
  waitDesktop,
  noteDesktop,
  cancelDesktopWait,
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
import {
  DESKTOP_WAIT_MS,
  agentVerFromBody,
  clampHeartbeatWaitMs,
  computerPublic,
  hasComputerUse,
  joinCaps,
  normalizeCaps,
  normalizePermit,
  unsupportedCapBody,
} from "../../../packages/fleet-worker/src/presence.mjs";

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

  if (path === "/v1/set_computer_alias" && request.method === "POST") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId) return json({ error: "device_id required" }, 400);
    if (!Object.prototype.hasOwnProperty.call(body, "alias")) {
      return json({ error: "alias required" }, 400);
    }
    try {
      return json(await setDeviceAliasForUser(userId, deviceId, body.alias));
    } catch (error) {
      if (error instanceof DeviceAliasError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }

  if (path === "/v1/get_computer" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    if (!reference) return json({ error: "device_id required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    const row = (await listComputers(userId)).find((c) => c.id === deviceId);
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  }

  if (path === "/v1/heartbeat" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    if (!reference) return json({ error: "device_id required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    if (!isOnline(deviceId)) return json({ error: "offline" }, 409);
    const waitMs = clampHeartbeatWaitMs(body.wait_ms);
    const pending = waitNextHeartbeat(deviceId, waitMs);
    const ok = sendToDevice(userId, deviceId, envelope("ask_heartbeat", {}));
    if (!ok) {
      cancelHeartbeatWait(deviceId);
      return json({ error: "offline" }, 409);
    }
    const got = await pending;
    if (!got) return json({ error: "no heartbeat" }, 409);
    const row = (await listComputers(userId)).find((c) => c.id === deviceId);
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  }

  if ((path === "/v1/desktop_screenshot" || path === "/v1/desktop_action") && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    if (!reference) return json({ error: "device_id required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    const catalog = (await listComputers(userId)).find((c) => c.id === deviceId);
    if (!catalog) return json({ error: "not found" }, 404);
    if (!isOnline(deviceId)) return json({ error: "offline" }, 409);
    if (!hasComputerUse(catalog)) return json(unsupportedCapBody(catalog), 409);
    const isShot = path.endsWith("desktop_screenshot") || body.action === "screenshot";
    const wsType = isShot ? "desktop_screenshot" : "desktop_action";
    const wsBody = isShot
      ? { max_width: body.max_width, max_height: body.max_height }
      : {
          action: body.action,
          x: body.x,
          y: body.y,
          x2: body.x2,
          y2: body.y2,
          text: body.text,
          key: body.key,
          keys: body.keys,
          scroll_x: body.scroll_x,
          scroll_y: body.scroll_y,
          duration_ms: body.duration_ms,
          frame_id: body.frame_id,
        };
    const corr = randomUUID();
    const pending = waitDesktop(corr, DESKTOP_WAIT_MS);
    const ok = sendToDevice(userId, deviceId, envelope(wsType, wsBody, corr));
    if (!ok) {
      cancelDesktopWait(corr);
      return json({ error: "offline" }, 409);
    }
    const got = await pending;
    if (!got) return json({ error: "timeout", code: "TIMEOUT" }, 409);
    return json(got);
  }

  if (path === "/v1/plugin" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    const operation = String(body.operation ?? "");
    const pluginId = String(body.plugin_id ?? "");
    if (!reference || !operation) return json({ error: "device_id and operation required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    if (!isOnline(deviceId)) return json({ error: "offline" }, 409);
    const catalog = (await listComputers(userId)).find((computer) => computer.id === deviceId);
    if (!catalog) return json({ error: "not found" }, 404);
    if (!normalizeCaps(catalog.caps).includes("plugins")) {
      return json({ error: "unsupported", code: "UNSUPPORTED_CAP", missing: "plugins", agentVer: catalog.agentVer ?? "", os: catalog.os ?? "" }, 409);
    }
    const plugin = pluginId ? officialPlugin(pluginId) : null;
    if (operation !== "list" && !plugin) return json({ error: "official plugin not found" }, 404);
    if (!new Set(["list", "install", "uninstall", "invoke"]).has(operation)) {
      return json({ error: "invalid plugin operation" }, 400);
    }
    const corr = randomUUID();
    const payload: Record<string, unknown> = {
      operation,
      plugin_id: pluginId,
      action: body.action,
      input: body.input,
      timeout_seconds: body.timeout_seconds,
    };
    if (operation === "install") payload.manifest = plugin;
    putResult(deviceId, corr, { status: "pending" });
    if (!sendToDevice(userId, deviceId, envelope("plugin", payload, corr))) {
      return json({ error: "offline" }, 409);
    }
    return json({ corr, status: "pending" });
  }

  if (path === "/v1/plugin_result" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    const corr = String(body.corr ?? "");
    if (!reference || !corr) return json({ error: "device_id and corr required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    const row = getResult(deviceId, corr);
    return json(row ? { corr, ...row } : { corr, status: "pending" });
  }

  if (path === "/v1/select_computer" && request.method === "POST") {
    const reference = String(body.id ?? "");
    if (!reference) return json({ error: "id required" }, 400);
    const id = await resolveDeviceId(userId, reference);
    if (!id) return json({ error: "not found" }, 404);
    const sql = await getSql();
    await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${userId}, ${id}, now())
      on conflict (user_id) do update set selected_device_id = excluded.selected_device_id, selected_at = now()
    `;
    return json({ selected: id });
  }

  if (path === "/v1/run" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    const command = String(body.command ?? "");
    if (!reference || !command) return json({ error: "device_id and command required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
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
    const reference = String(body.device_id ?? "");
    if (!reference || (body.keys == null && body.key == null)) return json({ error: "device_id and keys or key required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    const ok = sendToDevice(
      userId,
      deviceId,
      envelope("type", { keys: body.keys, key: body.key, corr: body.corr }),
    );
    if (!ok) return json({ error: "offline" }, 409);
    return json({ ok: true, status: "typed" });
  }

  if (path === "/v1/read_screen" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    if (!reference) return json({ error: "device_id required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    const corr = body.corr != null ? String(body.corr) : "";
    sendToDevice(userId, deviceId, envelope("read_screen", { corr }, corr || undefined));
    const row = getScreen(deviceId, corr || undefined);
    return json({ status: row ? "ok" : "empty", screen: row });
  }

  if (path === "/v1/list_panes" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    if (!reference) return json({ error: "device_id required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
    if (!sendToDevice(userId, deviceId, envelope("list_panes", {}))) {
      return json({ panes: [] });
    }
    return json({ ok: true, status: "asked" });
  }

  if (path === "/v1/get_result" && request.method === "POST") {
    const reference = String(body.device_id ?? "");
    const corr = String(body.corr ?? "");
    if (!reference || !corr) return json({ error: "device_id and corr required" }, 400);
    const deviceId = await resolveDeviceId(userId, reference);
    if (!deviceId) return json({ error: "not found" }, 404);
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
  const accepted = await upsertDevice(userId, deviceId, {
    name,
    os,
    arch: "unknown",
    online: true,
  });
  if (!accepted) {
    ws.close(1008, "device id conflicts with an existing device");
    return;
  }
  attachDevice(userId, deviceId, ws);
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
    const helloVer = agentVerFromBody(parsed.body);
    putAgentVer(deviceId, helloVer);
    await upsertDevice(userId, deviceId, {
      name: String(parsed.body.hostname ?? deviceId),
      os: String(parsed.body.os ?? "linux"),
      arch: String(parsed.body.arch ?? "unknown"),
      online: true,
      agentVer: helloVer,
      caps: Array.isArray(parsed.body.caps) ? normalizeCaps(parsed.body.caps) : undefined,
      permit: normalizePermit(parsed.body.permit) ?? undefined,
    });
    return;
  }
  if (parsed.type === "desktop") {
    noteDesktop(parsed.corr ?? "", parsed.body ?? {});
    return;
  }
  if (parsed.type === "ping" || parsed.type === "heartbeat") {
    const sql = await getSql();
    const reportedVer = agentVerFromBody(parsed.body);
    await sql`
      update devices
      set status = ${"online"}, last_seen = now(),
          agent_ver = coalesce(${reportedVer ?? null}, agent_ver)
      where id = ${deviceId} and user_id = ${userId}
    `;
    const pingCaps = Array.isArray(parsed.body.caps) ? joinCaps(normalizeCaps(parsed.body.caps)) : null;
    const pingPermit = normalizePermit(parsed.body.permit);
    if (pingCaps != null) {
      await sql`update devices set caps = ${pingCaps} where id = ${deviceId} and user_id = ${userId}`;
    }
    if (pingPermit) {
      await sql`update devices set permit = ${pingPermit} where id = ${deviceId} and user_id = ${userId}`;
    }
    putAgentVer(deviceId, reportedVer);
    noteHeartbeat(deviceId);
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
  if (parsed.type === "plugin_accepted" && parsed.corr) {
    putResult(deviceId, parsed.corr, { status: parsed.body.status ?? "running" });
    return;
  }
  if (parsed.type === "plugin_result" && parsed.corr) {
    putResult(deviceId, parsed.corr, {
      status: "done",
      ok: parsed.body.ok ?? false,
      result: parsed.body.result,
      error: parsed.body.error ?? "",
      t: parsed.t,
    });
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
    alias: string | null;
    os: string;
    status: string;
    last_seen: string | Date;
    agent_ver: string | null;
    caps: string | null;
    permit: string | null;
  }>`
    select id, name, alias, os, status, last_seen, agent_ver, caps, permit
    from devices
    where user_id = ${userId}
    order by created_at asc
  `;
  return rows.map((r) =>
    computerPublic({
      id: r.id,
      name: r.name,
      alias: r.alias,
      os: r.os,
      online: isOnline(r.id),
      lastSeen: r.last_seen instanceof Date ? r.last_seen.getTime() : new Date(r.last_seen).getTime(),
      agentVer: getAgentVer(r.id) ?? r.agent_ver?.trim() ?? "",
      caps: r.caps,
      permit: r.permit,
    }),
  ).filter((row): row is NonNullable<typeof row> => Boolean(row));
}

async function resolveDeviceId(userId: string, reference: unknown) {
  return resolveDeviceReference(await getSql(), userId, reference);
}

async function stolenDevice(userId: string, deviceId: string) {
  const sql = await getSql();
  const rows = await sql<{ user_id: string }>`select user_id from devices where id = ${deviceId}`;
  if (rows[0]) return rows[0].user_id !== userId;
  return deviceIdConflictsWithAlias(sql, userId, deviceId);
}

async function upsertDevice(
  userId: string,
  deviceId: string,
  extra: {
    name: string;
    os: string;
    arch: string;
    online: boolean;
    agentVer?: string;
    caps?: string[];
    permit?: "off" | "ask" | "allow" | null;
  },
) {
  const sql = await getSql();
  const existing = await sql<{ user_id: string; slug: string }>`
    select user_id, slug from devices where id = ${deviceId}
  `;
  if (existing[0] && existing[0].user_id !== userId) return false;
  const status = extra.online ? "online" : "offline";
  const arch = extra.arch || "unknown";
  const capsText = extra.caps ? joinCaps(extra.caps) : null;
  const permit = extra.permit ?? null;
  const agentVer = extra.agentVer?.trim() || null;
  if (!existing[0]) {
    if (await deviceIdConflictsWithAlias(sql, userId, deviceId)) return false;
    const slug = makeDeviceSlug(extra.name);
    await sql`
      insert into devices (id, user_id, slug, name, os, arch, location_tag, status, caps, permit, agent_ver)
      values (${deviceId}, ${userId}, ${slug}, ${extra.name}, ${extra.os}, ${arch}, ${"home"}, ${status}, ${capsText ?? "shell,pane"}, ${permit}, ${agentVer})
    `;
    return true;
  }
  if (arch !== "unknown") {
    await sql`
      update devices
      set name = ${extra.name}, os = ${extra.os}, arch = ${arch},
          status = ${status}, last_seen = now(),
          agent_ver = coalesce(${agentVer}, agent_ver)
      where id = ${deviceId} and user_id = ${userId}
    `;
  } else {
    await sql`
      update devices
      set name = ${extra.name}, os = ${extra.os},
          status = ${status}, last_seen = now(),
          agent_ver = coalesce(${agentVer}, agent_ver)
      where id = ${deviceId} and user_id = ${userId}
    `;
  }
  if (capsText != null) {
    await sql`update devices set caps = ${capsText} where id = ${deviceId} and user_id = ${userId}`;
  }
  if (permit != null) {
    await sql`update devices set permit = ${permit} where id = ${deviceId} and user_id = ${userId}`;
  }
  return true;
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
