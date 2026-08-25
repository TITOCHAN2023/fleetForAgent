/**
 * Fleet hub — ordinary Node process.
 *
 * Same HTTP + WSS surface as packages/fleet-worker. No Durable Objects.
 * Devices dial OUT to /v1/device. Operators call POST /v1/*.
 * Jobs do not run here. This is a mailbox.
 *
 *   HUB_TOKEN=... PORT=8787 node index.mjs
 */
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  DESKTOP_WAIT_MS,
  advertisedUpdate,
  agentVerFromBody,
  clampHeartbeatWaitMs,
  computerPublic,
  hasComputerUse,
  normalizeCaps,
  normalizePermit,
  unsupportedCapBody,
} from "../fleet-worker/src/presence.mjs";
import { createSessionBook, fingerprintFromHeaders } from "../fleet-worker/src/session.mjs";
import { officialPlugin } from "../fleet-tool/operator.mjs";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto, x-fleet-operator",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const HUB_WAIT_MAX_MS = 30_000;
const HUB_WAIT_POLL_MS = 25;

function clampHubWaitMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(HUB_WAIT_MAX_MS, n);
}

function isHubResultDone(row) {
  if (!row || typeof row !== "object") return false;
  if (row.status === "pending" || row.status === "running") return false;
  return row.ok !== undefined || row.exit_code !== undefined || row.status === "done";
}

export function createHub({
  token = "",
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  desktopWaitMs = DESKTOP_WAIT_MS,
  latestAgentVer = process.env.FLEET_LATEST_AGENT_VER || "",
  updateBase = process.env.FLEET_UPDATE_BASE || "",
  checksumsUrl = process.env.FLEET_UPDATE_CHECKSUMS || "",
  checksumsText = process.env.FLEET_UPDATE_SUMS || "",
} = {}) {
  /** @type {Map<string, { id: string, name: string, os: string, online: boolean, lastSeen: number, agentVer?: string }>} */
  const fleet = new Map();
  /** @type {Map<string, import("ws").WebSocket>} */
  const sockets = new Map();
  /** @type {Map<string, { last?: Record<string, unknown>, byCorr: Map<string, Record<string, unknown>> }>} */
  const screens = new Map();
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  const results = new Map();
  /** @type {Map<string, ReturnType<typeof createSessionBook>>} */
  const sessions = new Map();
  /** @type {Map<string, { seq: number, waiters: Array<() => void> }>} */
  const beats = new Map();
  /** @type {Map<string, { resolve: (body: Record<string, unknown> | undefined) => void, timer: ReturnType<typeof setTimeout> }>} */
  const desktopWaiters = new Map();

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname !== "/v1/device") {
      socket.destroy();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const id = header(req, "x-device-id");
    if (!id) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      acceptDevice(ws, req, id);
    });
  });

  function acceptDevice(ws, req, id) {
    const prev = sockets.get(id);
    if (prev && prev !== ws) prev.close(1012, "replaced");
    sockets.set(id, ws);
    const name = header(req, "x-device-name") || id;
    const os = header(req, "x-device-os") || "linux";
    ws.deviceId = id;
    mark(id, { name, os, online: true });
    ws.send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 25, ...advertisedUpdate({ latestAgentVer, updateBase, checksumsUrl, checksumsText }) })));

    ws.on("message", (data) => {
      if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      onDeviceMessage(ws, parsed);
    });
    ws.on("close", () => {
      if (sockets.get(id) === ws) {
        sockets.delete(id);
        mark(id, { name: fleet.get(id)?.name ?? id, os: fleet.get(id)?.os ?? "linux", online: false });
      }
    });
  }

  function onDeviceMessage(ws, parsed) {
    if (parsed?.v !== 1) {
      ws.close(1003, "bad proto");
      return;
    }
    const id = ws.deviceId;
    if (!id) return;

    if (parsed.type === "hello") {
      mark(id, {
        name: String(parsed.body?.hostname ?? fleet.get(id)?.name ?? id),
        os: String(parsed.body?.os ?? fleet.get(id)?.os ?? "linux"),
        online: true,
        agentVer: String(parsed.body?.agent_ver ?? ""),
        ...(Array.isArray(parsed.body?.caps) ? { caps: normalizeCaps(parsed.body.caps) } : {}),
        ...(normalizePermit(parsed.body?.permit) ? { permit: normalizePermit(parsed.body.permit) } : {}),
      });
      return;
    }
    if (parsed.type === "desktop") {
      noteDesktop(parsed.corr ?? "", parsed.body ?? {});
      return;
    }
    if (parsed.type === "ping" || parsed.type === "heartbeat") {
      const prev = fleet.get(id);
      const agentVer = agentVerFromBody(parsed.body);
      mark(id, {
        name: prev?.name ?? id,
        os: prev?.os ?? "linux",
        online: true,
        ...(agentVer !== undefined ? { agentVer } : {}),
        ...(Array.isArray(parsed.body?.caps) ? { caps: normalizeCaps(parsed.body.caps) } : {}),
        ...(normalizePermit(parsed.body?.permit) ? { permit: normalizePermit(parsed.body.permit) } : {}),
      });
      noteBeat(id);
      ws.send(JSON.stringify(envelope("pong", advertisedUpdate({ latestAgentVer, updateBase, checksumsUrl, checksumsText }), parsed.id)));
      return;
    }
    if (parsed.type === "screen") {
      const slot = screens.get(id) ?? { byCorr: new Map() };
      slot.last = parsed.body ?? {};
      if (parsed.corr) slot.byCorr.set(parsed.corr, parsed.body ?? {});
      screens.set(id, slot);
      return;
    }
    if (parsed.type === "accepted" && parsed.corr) {
      deviceResults(id).set(parsed.corr, {
        status: "running",
        pane_id: parsed.body?.pane_id,
      });
      return;
    }
    if (parsed.type === "plugin_accepted" && parsed.corr) {
      deviceResults(id).set(parsed.corr, { status: parsed.body?.status ?? "running" });
      return;
    }
    if (parsed.type === "plugin_result" && parsed.corr) {
      deviceResults(id).set(parsed.corr, {
        status: "done",
        ok: parsed.body?.ok ?? false,
        result: parsed.body?.result,
        error: parsed.body?.error ?? "",
        t: parsed.t,
      });
      deviceSessions(id).finish(parsed.corr);
      return;
    }
    if (parsed.type === "result" && parsed.corr) {
      deviceResults(id).set(parsed.corr, {
        ok: parsed.body?.ok ?? false,
        exit_code: parsed.body?.exit_code ?? 1,
        error: parsed.body?.error ?? "",
        stdout: parsed.body?.stdout ?? "",
        t: parsed.t,
      });
      deviceSessions(id).finish(parsed.corr);
    }
  }

  function deviceResults(id) {
    let m = results.get(id);
    if (!m) {
      m = new Map();
      results.set(id, m);
    }
    return m;
  }

  function deviceSessions(id) {
    let book = sessions.get(id);
    if (!book) {
      book = createSessionBook();
      sessions.set(id, book);
    }
    return book;
  }

  function withFingerprint(body, fp) {
    if (fp) return { ...body, fingerprint: fp };
    return body;
  }

  function hubResultPayload(corr, row) {
    if (!row) return { status: "pending", corr };
    return { status: "done", corr, ...row };
  }

  async function waitHubResult(deviceId, corr, waitMs) {
    const budget = clampHubWaitMs(waitMs);
    const deadline = now() + budget;
    let row = deviceResults(deviceId).get(corr);
    if (budget <= 0) return row;
    while (!isHubResultDone(row) && now() < deadline) {
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(HUB_WAIT_POLL_MS, left));
      row = deviceResults(deviceId).get(corr);
    }
    return row;
  }

  function mark(id, extra) {
    const prev = fleet.get(id);
    fleet.set(id, {
      id,
      name: extra.name ?? prev?.name ?? id,
      os: extra.os ?? prev?.os ?? "linux",
      online: extra.online,
      lastSeen: now(),
      agentVer: extra.agentVer ?? prev?.agentVer,
      caps: Array.isArray(extra.caps) ? extra.caps : prev?.caps,
      permit: extra.permit !== undefined ? extra.permit : prev?.permit,
    });
  }

  function beatSlot(id) {
    let slot = beats.get(id);
    if (!slot) {
      slot = { seq: 0, waiters: [] };
      beats.set(id, slot);
    }
    return slot;
  }

  function noteBeat(id) {
    const slot = beatSlot(id);
    slot.seq += 1;
    const waiters = slot.waiters.splice(0);
    for (const w of waiters) w();
  }

  function waitDesktop(corr, waitMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        desktopWaiters.delete(corr);
        resolve(undefined);
      }, waitMs);
      desktopWaiters.set(corr, { resolve, timer });
    });
  }

  function noteDesktop(corr, body) {
    if (!corr) return;
    const waiter = desktopWaiters.get(corr);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    desktopWaiters.delete(corr);
    waiter.resolve(body);
  }

  function waitNextBeat(id, waitMs) {
    const slot = beatSlot(id);
    const start = slot.seq;
    return new Promise((resolve) => {
      const onBeat = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        slot.waiters = slot.waiters.filter((w) => w !== onBeat);
        resolve(slot.seq > start);
      }, waitMs);
      slot.waiters.push(onBeat);
    });
  }

  function computerOf(id) {
    const row = fleet.get(id);
    if (!row) return null;
    return computerPublic({
      ...row,
      online: sockets.get(row.id)?.readyState === WebSocket.OPEN,
    });
  }

  function sendTo(id, env) {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(env));
    return true;
  }

  function listComputers() {
    const computers = [...fleet.values()]
      .map((row) =>
        computerPublic({
          ...row,
          online: sockets.get(row.id)?.readyState === WebSocket.OPEN,
        }),
      )
      .filter(Boolean);
    computers.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
    return { computers };
  }

  async function handleHttp(req, res) {
    if (req.method === "OPTIONS") {
      write(res, 204, null);
      return;
    }
    const url = new URL(req.url ?? "/", "http://hub");

    if (url.pathname === "/" || url.pathname === "/v1/health") {
      write(res, 200, {
        name: "fleet-hub",
        v: 1,
        ok: true,
        backend: "node",
        ...advertisedUpdate({ latestAgentVer, updateBase, checksumsUrl, checksumsText }),
      });
      return;
    }

    if (!authorized(req.headers.authorization)) {
      write(res, 401, { error: "unauthorized" });
      return;
    }

    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch {
        write(res, 400, { error: "invalid json" });
        return;
      }
    }

    if (url.pathname === "/v1/list_computers" && req.method === "POST") {
      write(res, 200, listComputers());
      return;
    }

    if (url.pathname === "/v1/get_computer" && req.method === "POST") {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      const row = computerOf(body.device_id);
      if (!row) {
        write(res, 404, { error: "not found" });
        return;
      }
      write(res, 200, row);
      return;
    }

    if (url.pathname === "/v1/heartbeat" && req.method === "POST") {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      if (!fleet.get(body.device_id)) {
        write(res, 404, { error: "not found" });
        return;
      }
      const live = sockets.get(body.device_id);
      if (!live || live.readyState !== WebSocket.OPEN) {
        write(res, 409, { error: "offline" });
        return;
      }
      const waitMs = clampHeartbeatWaitMs(body.wait_ms);
      const pending = waitNextBeat(body.device_id, waitMs);
      live.send(JSON.stringify(envelope("ask_heartbeat", advertisedUpdate({ latestAgentVer, updateBase, checksumsUrl, checksumsText }))));
      const got = await pending;
      if (!got) {
        write(res, 409, { error: "no heartbeat" });
        return;
      }
      const row = computerOf(body.device_id);
      if (!row) {
        write(res, 404, { error: "not found" });
        return;
      }
      write(res, 200, row);
      return;
    }

    if (
      (url.pathname === "/v1/desktop_screenshot" || url.pathname === "/v1/desktop_action") &&
      req.method === "POST"
    ) {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      const row = fleet.get(body.device_id);
      if (!row) {
        write(res, 404, { error: "not found" });
        return;
      }
      const live = sockets.get(body.device_id);
      if (!live || live.readyState !== WebSocket.OPEN) {
        write(res, 409, { error: "offline" });
        return;
      }
      if (!hasComputerUse(row)) {
        write(res, 409, unsupportedCapBody(row));
        return;
      }
      const plan =
        url.pathname.endsWith("desktop_screenshot") || body.action === "screenshot"
          ? { type: "desktop_screenshot", body: { max_width: body.max_width, max_height: body.max_height } }
          : {
              type: "desktop_action",
              body: {
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
              },
            };
      const corr = randomUUID();
      const pending = waitDesktop(corr, desktopWaitMs);
      live.send(JSON.stringify(envelope(plan.type, plan.body, corr)));
      const got = await pending;
      if (!got) {
        write(res, 409, { error: "timeout", code: "TIMEOUT" });
        return;
      }
      write(res, 200, got);
      return;
    }

    if (url.pathname === "/v1/select_computer" && req.method === "POST") {
      if (!body.id) {
        write(res, 400, { error: "id required" });
        return;
      }
      write(res, 200, { selected: body.id });
      return;
    }

    if (url.pathname === "/v1/run" && req.method === "POST") {
      if (!body.device_id || !body.command) {
        write(res, 400, { error: "device_id and command required" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const corr = randomUUID();
      deviceSessions(body.device_id).claim(fp, corr);
      const ok = sendTo(
        body.device_id,
        envelope("run", withFingerprint({ command: body.command, mode: "pane" }, fp), corr),
      );
      if (!ok) {
        write(res, 409, { error: "offline" });
        return;
      }
      const waitMs = clampHubWaitMs(body.wait_ms);
      if (waitMs <= 0) {
        write(res, 200, { corr, status: "running" });
        return;
      }
      const row = await waitHubResult(body.device_id, corr, waitMs);
      write(res, 200, hubResultPayload(corr, row));
      return;
    }

    if (url.pathname === "/v1/plugin" && req.method === "POST") {
      if (!body.device_id || !body.operation) {
        write(res, 400, { error: "device_id and operation required" });
        return;
      }
      const row = fleet.get(body.device_id);
      if (!row) {
        write(res, 404, { error: "not found" });
        return;
      }
      if (!normalizeCaps(row.caps).includes("plugins")) {
        write(res, 409, { error: "unsupported", code: "UNSUPPORTED_CAP", missing: "plugins", agentVer: row.agentVer ?? "", os: row.os ?? "" });
        return;
      }
      const operation = String(body.operation);
      const pluginId = String(body.plugin_id ?? "");
      const plugin = pluginId ? officialPlugin(pluginId) : null;
      if (operation !== "list" && !plugin) {
        write(res, 404, { error: "official plugin not found" });
        return;
      }
      if (!["list", "install", "uninstall", "invoke"].includes(operation)) {
        write(res, 400, { error: "invalid plugin operation" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const corr = randomUUID();
      deviceSessions(body.device_id).claim(fp, corr);
      deviceResults(body.device_id).set(corr, { status: "pending" });
      const ok = sendTo(body.device_id, envelope("plugin", {
        operation,
        plugin_id: pluginId,
        action: body.action,
        input: body.input,
        timeout_seconds: body.timeout_seconds,
        ...(operation === "install" ? { manifest: plugin } : {}),
      }, corr));
      if (!ok) {
        write(res, 409, { error: "offline" });
        return;
      }
      write(res, 200, { corr, status: "pending" });
      return;
    }

    if (url.pathname === "/v1/plugin_result" && req.method === "POST") {
      if (!body.device_id || !body.corr) {
        write(res, 400, { error: "device_id and corr required" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const resolved = deviceSessions(body.device_id).resolve(fp, body.corr);
      if (resolved.drop || !resolved.corr) {
        write(res, 200, { corr: body.corr, status: "pending" });
        return;
      }
      const row = deviceResults(body.device_id).get(resolved.corr);
      write(res, 200, row ? { corr: resolved.corr, ...row } : { corr: resolved.corr, status: "pending" });
      return;
    }

    if (url.pathname === "/v1/type" && req.method === "POST") {
      if (!body.device_id || (body.keys == null && body.key == null)) {
        write(res, 400, { error: "device_id and keys or key required" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const resolved = deviceSessions(body.device_id).resolve(fp, body.corr);
      if (resolved.drop) {
        write(res, 200, { ok: true, status: "typed" });
        return;
      }
      const ok = sendTo(
        body.device_id,
        envelope("type", withFingerprint({ keys: body.keys, key: body.key, corr: resolved.corr }, fp)),
      );
      if (!ok) {
        write(res, 409, { error: "offline" });
        return;
      }
      write(res, 200, { ok: true, status: "typed" });
      return;
    }

    if (url.pathname === "/v1/read_screen" && req.method === "POST") {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const resolved = deviceSessions(body.device_id).resolve(fp, body.corr);
      if (resolved.drop || !resolved.corr) {
        write(res, 200, { status: "empty", screen: null });
        return;
      }
      sendTo(
        body.device_id,
        envelope("read_screen", withFingerprint({ corr: resolved.corr }, fp), resolved.corr),
      );
      const slot = screens.get(body.device_id);
      const row = slot?.byCorr.get(resolved.corr) || null;
      write(res, 200, { status: row ? "ok" : "empty", screen: row });
      return;
    }

    if (url.pathname === "/v1/list_panes" && req.method === "POST") {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      if (!sendTo(body.device_id, envelope("list_panes", {}))) {
        write(res, 200, { panes: [] });
        return;
      }
      write(res, 200, { ok: true, status: "asked" });
      return;
    }

    if (url.pathname === "/v1/get_result" && req.method === "POST") {
      if (!body.device_id) {
        write(res, 400, { error: "device_id required" });
        return;
      }
      const fp = fingerprintFromHeaders(req.headers);
      const resolved = deviceSessions(body.device_id).resolve(fp, body.corr);
      if (resolved.drop || !resolved.corr) {
        write(res, 200, { status: "pending" });
        return;
      }
      const waitMs = clampHubWaitMs(body.wait_ms);
      const row = waitMs > 0
        ? await waitHubResult(body.device_id, resolved.corr, waitMs)
        : deviceResults(body.device_id).get(resolved.corr);
      write(res, 200, hubResultPayload(resolved.corr, row));
      return;
    }

    write(res, 404, { error: "not found" });
  }

  function authorized(headerValue) {
    const need = token.trim();
    if (!need) return true;
    const h = headerValue ?? "";
    const got = h.startsWith("Bearer ") ? h.slice(7) : "";
    return got === need;
  }

  function close() {
    for (const ws of sockets.values()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    wss.close();
    return new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { server, close };
}

function envelope(type, body = {}, corr) {
  const env = { v: 1, type, id: randomUUID(), t: Date.now(), body };
  if (corr) env.corr = corr;
  return env;
}

function header(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0]?.trim() || null;
  return typeof v === "string" ? v.trim() || null : null;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function write(res, status, data) {
  const headers = { ...CORS };
  if (data === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers["content-type"] = "application/json";
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return isLoopbackHost(h.slice(1, -1));
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Empty HUB_TOKEN is loopback-only. This Node hub has no per-account flt_1. */
export function assertHubBind({ host, token } = {}) {
  const t = String(token || "").trim();
  const h = String(host || "0.0.0.0").trim() || "0.0.0.0";
  if (!t && !isLoopbackHost(h)) {
    throw new Error(
      `HUB_TOKEN required when binding ${h} (empty token is loopback-only; this Node hub has no flt_1 multi-tenant)`,
    );
  }
  return { host: h, token: t };
}

const here = fileURLToPath(import.meta.url);
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === here;
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  let bind;
  try {
    bind = assertHubBind({ host: process.env.HOST || "0.0.0.0", token: process.env.HUB_TOKEN || "" });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const hub = createHub({ token: bind.token });
  hub.server.listen(port, bind.host, () => {
    console.log(`fleet-hub http://${bind.host}:${port}  (backend=node)`);
  });
}
