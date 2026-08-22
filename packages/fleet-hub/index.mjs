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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto",
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
} = {}) {
  /** @type {Map<string, { id: string, name: string, os: string, online: boolean, lastSeen: number, agentVer?: string }>} */
  const fleet = new Map();
  /** @type {Map<string, import("ws").WebSocket>} */
  const sockets = new Map();
  /** @type {Map<string, { last?: Record<string, unknown>, byCorr: Map<string, Record<string, unknown>> }>} */
  const screens = new Map();
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  const results = new Map();

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
    ws.send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 25 })));

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
      });
      return;
    }
    if (parsed.type === "ping" || parsed.type === "heartbeat") {
      const prev = fleet.get(id);
      mark(id, {
        name: prev?.name ?? id,
        os: prev?.os ?? "linux",
        online: true,
      });
      ws.send(JSON.stringify(envelope("pong", {}, parsed.id)));
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
    if (parsed.type === "result" && parsed.corr) {
      deviceResults(id).set(parsed.corr, {
        ok: parsed.body?.ok ?? false,
        exit_code: parsed.body?.exit_code ?? 1,
        error: parsed.body?.error ?? "",
        stdout: parsed.body?.stdout ?? "",
        t: parsed.t,
      });
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
    });
  }

  function sendTo(id, env) {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(env));
    return true;
  }

  function listComputers() {
    const computers = [...fleet.values()].map((row) => ({
      ...row,
      online: sockets.get(row.id)?.readyState === WebSocket.OPEN,
    }));
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
      write(res, 200, { name: "fleet-hub", v: 1, ok: true, backend: "node" });
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
      const corr = randomUUID();
      const ok = sendTo(
        body.device_id,
        envelope("run", { command: body.command, mode: "pane" }, corr),
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

    if (url.pathname === "/v1/type" && req.method === "POST") {
      if (!body.device_id || (body.keys == null && body.key == null)) {
        write(res, 400, { error: "device_id and keys or key required" });
        return;
      }
      const ok = sendTo(body.device_id, envelope("type", { keys: body.keys, key: body.key, corr: body.corr }));
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
      sendTo(
        body.device_id,
        envelope("read_screen", { corr: body.corr ?? "" }, body.corr || undefined),
      );
      const slot = screens.get(body.device_id);
      const row = (body.corr && slot?.byCorr.get(body.corr)) || slot?.last || null;
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
      if (!body.device_id || !body.corr) {
        write(res, 400, { error: "device_id and corr required" });
        return;
      }
      const waitMs = clampHubWaitMs(body.wait_ms);
      const row = waitMs > 0
        ? await waitHubResult(body.device_id, body.corr, waitMs)
        : deviceResults(body.device_id).get(body.corr);
      write(res, 200, hubResultPayload(body.corr, row));
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

const here = fileURLToPath(import.meta.url);
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === here;
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const hub = createHub({ token: process.env.HUB_TOKEN || "" });
  hub.server.listen(port, host, () => {
    console.log(`fleet-hub http://${host}:${port}  (backend=node)`);
  });
}
