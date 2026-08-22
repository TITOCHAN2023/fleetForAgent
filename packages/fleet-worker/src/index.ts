/**
 * Fleet hub — Cloudflare Worker + Durable Objects.
 *
 * Devices (Windows / Mac / Linux agents) dial OUT over WSS to /v1/device.
 * Operators call HTTPS: list_computers / select_computer / run / get_result.
 * No inbound ports on the machines. No intranet overlay.
 *
 * Auth: set secret HUB_TOKEN (wrangler secret put HUB_TOKEN). Empty = open (dev only).
 */

import { handleOAuth } from "./oauth";
import {
  ANON_FINGERPRINT,
  FLEET_OPERATOR_HEADER,
  fingerprintFromHeaders,
  resolveTicket,
} from "./session.mjs";

export interface Env {
  DEVICE: DurableObjectNamespace;
  FLEET: DurableObjectNamespace;
  HUB_TOKEN?: string;
  ASSETS?: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
}

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

function hubResultPayload(corr: string, row: Record<string, unknown> | undefined) {
  if (!row) return { status: "pending", corr };
  return { status: "done", corr, ...row };
}

async function waitDeviceResult(
  getRow: () => Promise<Record<string, unknown> | undefined>,
  waitMs: number,
) {
  const budget = clampHubWaitMs(waitMs);
  const deadline = Date.now() + budget;
  let row = await getRow();
  if (budget <= 0) return row;
  while (!isHubResultDone(row) && Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(HUB_WAIT_POLL_MS, left)));
    row = await getRow();
  }
  return row;
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
  userId?: string;
};

type Actor = { id: string; email?: string; super?: boolean };

type UserRow = {
  id: string;
  email: string;
  salt: string;
  pass: string;
  tokenHash?: string;
  tokenPrefix?: string;
  tokenAt?: number;
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto, x-fleet-operator",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hub = url.pathname === "/v1" || url.pathname.startsWith("/v1/");

    if (!hub) {
      if (!env.ASSETS) return new Response("site missing", { status: 500 });
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/v1/health") {
      return json({ name: "fleet-hub", v: 1, ok: true });
    }

    const oauth = await handleOAuth(request, env);
    if (oauth) return oauth;

    const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));

    if ((url.pathname === "/v1/register" || url.pathname === "/v1/login") && request.method === "POST") {
      return json({ error: "email login disabled" }, 404);
    }
    if (url.pathname === "/v1/logout" && request.method === "POST") {
      await fleet.fetch(
        new Request("https://fleet/logout", { method: "POST", headers: { cookie: request.headers.get("cookie") ?? "" } }),
      );
      return withCookies(json({ ok: true }), 'fleet_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    }
    if (url.pathname === "/v1/me" && request.method === "GET") {
      const actor = await resolveActor(request, env, fleet);
      if (!actor || actor.super) return json({ error: "unauthorized" }, 401);
      return json({ id: actor.id, email: actor.email });
    }
    if (url.pathname === "/v1/hub_token" && request.method === "GET") {
      const actor = await resolveActor(request, env, fleet);
      if (!actor || actor.super) return json({ error: "unauthorized" }, 401);
      return fleet.fetch(new Request(`https://fleet/token-meta?user=${encodeURIComponent(actor.id)}`));
    }
    if (url.pathname === "/v1/hub_token" && request.method === "POST") {
      const actor = await resolveActor(request, env, fleet);
      if (!actor || actor.super) return json({ error: "unauthorized" }, 401);
      return fleet.fetch(new Request(`https://fleet/token-issue?user=${encodeURIComponent(actor.id)}`, { method: "POST" }));
    }

    if (url.pathname === "/v1/device") {
      const actor = await resolveActor(request, env, fleet);
      if (!actor) return json({ error: "unauthorized" }, 401);
      const deviceId = deviceIdFrom(request);
      if (!deviceId) return json({ error: "x-device-id required" }, 400);
      const headers = new Headers(request.headers);
      headers.set("x-fleet-user", actor.id);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
      return stub.fetch(new Request(request, { headers }));
    }

    const actor = await resolveActor(request, env, fleet);
    if (!actor) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/v1/list_computers" && request.method === "POST") {
      const q = actor.super ? "" : `?user=${encodeURIComponent(actor.id)}`;
      return fleet.fetch(new Request(`https://fleet/list${q}`));
    }

    if (url.pathname === "/v1/select_computer" && request.method === "POST") {
      const body = (await request.json()) as { id?: string };
      if (!body.id) return json({ error: "id required" }, 400);
      return json({ selected: body.id });
    }

    if (url.pathname === "/v1/run" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; command?: string; wait_ms?: number };
      if (!body.device_id || !body.command) {
        return json({ error: "device_id and command required" }, 400);
      }
      if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      const fp = fingerprintFromHeaders(request.headers);
      return stub.fetch(
        new Request("https://device/run", {
          method: "POST",
          headers: operatorHeaders(request),
          body: JSON.stringify({ command: body.command, wait_ms: body.wait_ms, fingerprint: fp }),
        }),
      );
    }

    if (url.pathname === "/v1/type" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; keys?: string; key?: string; corr?: string };
      if (!body.device_id || (body.keys == null && body.key == null)) return json({ error: "device_id and keys or key required" }, 400);
      if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      const fp = fingerprintFromHeaders(request.headers);
      return stub.fetch(
        new Request("https://device/type", {
          method: "POST",
          headers: operatorHeaders(request),
          body: JSON.stringify({ keys: body.keys, key: body.key, corr: body.corr, fingerprint: fp }),
        }),
      );
    }

    if (url.pathname === "/v1/read_screen" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; corr?: string };
      if (!body.device_id) return json({ error: "device_id required" }, 400);
      if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      const q = body.corr ? `?corr=${encodeURIComponent(body.corr)}` : "";
      return stub.fetch(new Request(`https://device/screen${q}`, { headers: operatorHeaders(request) }));
    }

    if (url.pathname === "/v1/list_panes" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string };
      if (!body.device_id) return json({ error: "device_id required" }, 400);
      if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      return stub.fetch(new Request("https://device/panes", { method: "POST" }));
    }

    if (url.pathname === "/v1/get_result" && request.method === "POST") {
      const body = (await request.json()) as { device_id?: string; corr?: string; wait_ms?: number };
      if (!body.device_id) return json({ error: "device_id required" }, 400);
      if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
      const q = new URLSearchParams();
      if (body.corr) q.set("corr", body.corr);
      const waitMs = clampHubWaitMs(body.wait_ms);
      if (waitMs > 0) q.set("wait_ms", String(waitMs));
      const suffix = q.toString() ? `?${q}` : "";
      return stub.fetch(new Request(`https://device/result${suffix}`, { headers: operatorHeaders(request) }));
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
      const user = url.searchParams.get("user");
      const computers = await this.list(user);
      return json({ computers });
    }
    if (url.pathname === "/device") {
      const id = url.searchParams.get("id") ?? "";
      const row = await this.ctx.storage.get<DeviceRow>(`d:${id}`);
      return json(row ?? {});
    }
    if (url.pathname === "/upsert" && request.method === "POST") {
      const row = (await request.json()) as DeviceRow;
      const prev = await this.ctx.storage.get<DeviceRow>(`d:${row.id}`);
      if (prev?.userId && row.userId && prev.userId !== row.userId && row.userId !== "*") {
        return json({ error: "taken" }, 409);
      }
      await this.ctx.storage.put(`d:${row.id}`, { ...prev, ...row });
      return json({ ok: true });
    }
    if (url.pathname === "/oauth" && request.method === "POST") {
      const body = (await request.json()) as { email?: string; provider?: string };
      return this.oauthUser(body.email ?? "", body.provider ?? "oauth");
    }
    if (url.pathname === "/oauth-pending" && request.method === "POST") {
      const body = (await request.json()) as { state?: string; provider?: "google" | "x"; verifier?: string; exp?: number };
      if (!body.state || !body.provider) return json({ error: "bad pending" }, 400);
      await this.ctx.storage.put(`oauth:${body.state}`, {
        provider: body.provider,
        verifier: body.verifier,
        exp: body.exp ?? Date.now() + 600_000,
      });
      return json({ ok: true });
    }
    if (url.pathname === "/oauth-pending" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const row = await this.ctx.storage.get<{ provider: "google" | "x"; verifier?: string; exp: number }>(
        `oauth:${state}`,
      );
      if (state) await this.ctx.storage.delete(`oauth:${state}`);
      if (!row) return json({ error: "missing" }, 404);
      return json(row);
    }
    if ((url.pathname === "/register" || url.pathname === "/login") && request.method === "POST") {
      return json({ error: "email login disabled" }, 404);
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      const sid = cookie(request, "fleet_session");
      if (sid) await this.ctx.storage.delete(`sess:${sid}`);
      return json({ ok: true });
    }
    if (url.pathname === "/resolve") {
      return json((await this.resolve(request)) ?? {});
    }
    if (url.pathname === "/token-meta") {
      const userId = url.searchParams.get("user") ?? "";
      const user = await this.userById(userId);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({
        hasToken: Boolean(user.tokenHash),
        prefix: user.tokenPrefix ?? "",
        createdAt: user.tokenAt ?? 0,
      });
    }
    if (url.pathname === "/token-issue" && request.method === "POST") {
      const userId = url.searchParams.get("user") ?? "";
      const user = await this.userById(userId);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.tokenHash) await this.ctx.storage.delete(`tok:${user.tokenHash}`);
      const minted = await mintHubToken();
      user.tokenHash = minted.hash;
      user.tokenPrefix = minted.prefix;
      user.tokenAt = Date.now();
      await this.ctx.storage.put(`u:${user.email}`, user);
      await this.ctx.storage.put(`id:${user.id}`, user.email);
      await this.ctx.storage.put(`tok:${minted.hash}`, user.id);
      return json({ token: minted.raw, prefix: minted.prefix });
    }
    return json({ error: "not found" }, 404);
  }

  async list(userId: string | null): Promise<DeviceRow[]> {
    const map = await this.ctx.storage.list<DeviceRow>({ prefix: "d:" });
    let rows = [...map.values()];
    if (userId) rows = rows.filter((r) => r.userId === userId);
    rows.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
    return rows.map(({ id, name, os, online, lastSeen, agentVer }) => ({
      id,
      name,
      os,
      online,
      lastSeen,
      agentVer,
    }));
  }

  async resolve(request: Request): Promise<Actor | null> {
    const sid = cookie(request, "fleet_session");
    if (sid) {
      const userId = await this.ctx.storage.get<string>(`sess:${sid}`);
      if (userId) {
        const email = await this.ctx.storage.get<string>(`id:${userId}`);
        const user = email ? await this.ctx.storage.get<UserRow>(`u:${email}`) : null;
        if (user) return { id: user.id, email: user.email };
      }
    }
    const tok = bearer(request);
    if (tok.startsWith("flt_")) {
      const hash = await sha256hex(tok);
      const userId = await this.ctx.storage.get<string>(`tok:${hash}`);
      if (userId) {
        const email = await this.ctx.storage.get<string>(`id:${userId}`);
        return { id: userId, email: email ?? undefined };
      }
    }
    return null;
  }

  async userById(userId: string): Promise<UserRow | null> {
    const email = await this.ctx.storage.get<string>(`id:${userId}`);
    if (!email) return null;
    return (await this.ctx.storage.get<UserRow>(`u:${email}`)) ?? null;
  }

  async register(email: string, password: string): Promise<Response> {
    email = email.trim().toLowerCase();
    if (!email.includes("@") || password.length < 8) {
      return json({ error: "email and password (8+) required" }, 400);
    }
    if (await this.ctx.storage.get(`u:${email}`)) return json({ error: "exists" }, 409);
    const salt = crypto.randomUUID().replace(/-/g, "");
    const user: UserRow = {
      id: crypto.randomUUID(),
      email,
      salt,
      pass: await pbkdf2(password, salt),
    };
    await this.ctx.storage.put(`u:${email}`, user);
    await this.ctx.storage.put(`id:${user.id}`, email);
    return this.issueSession(user);
  }

  async oauthUser(email: string, provider: string): Promise<Response> {
    email = email.trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "email required" }, 400);
    let user = await this.ctx.storage.get<UserRow>(`u:${email}`);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email,
        salt: provider,
        pass: `oauth:${provider}`,
      };
      await this.ctx.storage.put(`u:${email}`, user);
      await this.ctx.storage.put(`id:${user.id}`, email);
    }
    return this.issueSession(user);
  }

  async login(email: string, password: string): Promise<Response> {
    email = email.trim().toLowerCase();
    const user = await this.ctx.storage.get<UserRow>(`u:${email}`);
    if (!user || (await pbkdf2(password, user.salt)) !== user.pass) {
      return json({ error: "invalid" }, 401);
    }
    return this.issueSession(user);
  }

  async issueSession(user: UserRow): Promise<Response> {
    const sid = crypto.randomUUID() + crypto.randomUUID();
    await this.ctx.storage.put(`sess:${sid}`, user.id);
    const res = json({ id: user.id, email: user.email });
    return withCookies(
      res,
      `fleet_session=${sid}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
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
        userId: request.headers.get("x-fleet-user") ?? undefined,
      });
      pair[1].send(JSON.stringify(envelope("hello_ok", { heartbeat_s: 3600 })));
      await this.mark(id, {
        name: request.headers.get("x-device-name") ?? id,
        os: request.headers.get("x-device-os") ?? "linux",
        online: true,
        userId: request.headers.get("x-fleet-user") ?? undefined,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as { command: string; wait_ms?: number; fingerprint?: string };
      const fp = deviceFingerprint(request, body.fingerprint);
      const corr = crypto.randomUUID();
      await this.claimSession(fp, corr);
      sockets[0]!.send(JSON.stringify(envelope("run", withFingerprint({ command: body.command, mode: "pane" }, fp), corr)));
      const waitMs = clampHubWaitMs(body.wait_ms);
      if (waitMs <= 0) return json({ corr, status: "running" });
      const row = await waitDeviceResult(() => this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`), waitMs);
      return json(hubResultPayload(corr, row));
    }

    if (url.pathname === "/type" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as { keys?: string; key?: string; corr?: string; fingerprint?: string };
      const fp = deviceFingerprint(request, body.fingerprint);
      const resolved = await this.resolveSession(fp, body.corr);
      if (resolved.drop) return json({ ok: true, status: "typed" });
      sockets[0]!.send(
        JSON.stringify(envelope("type", withFingerprint({ keys: body.keys, key: body.key, corr: resolved.corr }, fp))),
      );
      return json({ ok: true, status: "typed" });
    }

    if (url.pathname === "/screen") {
      const sockets = this.ctx.getWebSockets();
      const ticket = url.searchParams.get("corr") ?? "";
      const fp = deviceFingerprint(request);
      const resolved = await this.resolveSession(fp, ticket);
      if (resolved.drop || !resolved.corr) return json({ status: "empty", screen: null });
      const corr = resolved.corr;
      if (sockets.length) {
        sockets[0]!.send(JSON.stringify(envelope("read_screen", withFingerprint({ corr }, fp), corr)));
      }
      const owned = (await this.ctx.storage.get<Record<string, unknown>>(`screen:${corr}`)) ?? null;
      return json({ status: owned ? "ok" : "empty", screen: owned });
    }

    if (url.pathname === "/panes" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ panes: [] });
      sockets[0]!.send(JSON.stringify(envelope("list_panes", {})));
      return json({ ok: true, status: "asked" });
    }

    if (url.pathname === "/result") {
      const ticket = url.searchParams.get("corr") ?? "";
      const fp = deviceFingerprint(request);
      const resolved = await this.resolveSession(fp, ticket);
      if (resolved.drop || !resolved.corr) return json({ status: "pending" });
      const corr = resolved.corr;
      const waitMs = clampHubWaitMs(url.searchParams.get("wait_ms"));
      const row = waitMs > 0
        ? await waitDeviceResult(() => this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`), waitMs)
        : await this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`);
      return json(hubResultPayload(corr, row));
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
    const att = (ws.deserializeAttachment() ?? {}) as {
      deviceId?: string;
      name?: string;
      os?: string;
      userId?: string;
    };

    if (parsed.type === "hello") {
      const os = String(parsed.body.os ?? att.os ?? "linux");
      const name = String(parsed.body.hostname ?? att.name ?? att.deviceId ?? "device");
      await this.mark(att.deviceId ?? "unknown", {
        name,
        os,
        online: true,
        agentVer: String(parsed.body.agent_ver ?? ""),
        userId: att.userId,
      });
      return;
    }

    if (parsed.type === "ping" || parsed.type === "heartbeat") {
      await this.mark(att.deviceId ?? "unknown", {
        name: att.name ?? att.deviceId ?? "device",
        os: att.os ?? "linux",
        online: true,
        userId: att.userId,
      });
      ws.send(JSON.stringify(envelope("pong", {}, parsed.id)));
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
      await this.finishSession(parsed.corr);
    }
  }

  async webSocketClose(ws: WebSocket) {
    // Replacing a socket closes the old one; that close must not flip the
    // device offline while the new connection is already accepted.
    const still = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (still.length > 0) return;
    const att = (ws.deserializeAttachment() ?? {}) as {
      deviceId?: string;
      name?: string;
      os?: string;
      userId?: string;
    };
    if (att.deviceId) {
      await this.mark(att.deviceId, {
        name: att.name ?? att.deviceId,
        os: att.os ?? "linux",
        online: false,
        userId: att.userId,
      });
    }
  }

  private fleet() {
    return this.env.FLEET.get(this.env.FLEET.idFromName("fleet"));
  }

  private async claimSession(fp: string, corr: string) {
    await this.ctx.storage.put(`own:${corr}`, fp);
    await this.ctx.storage.put(`live:${fp}`, corr);
    const alive = (await this.ctx.storage.get<string[]>(`alive:${fp}`)) ?? [];
    if (!alive.includes(corr)) alive.push(corr);
    await this.ctx.storage.put(`alive:${fp}`, alive);
  }

  private async finishSession(corr: string) {
    const fp = await this.ctx.storage.get<string>(`own:${corr}`);
    if (fp === undefined) return;
    const alive = (await this.ctx.storage.get<string[]>(`alive:${fp}`)) ?? [];
    await this.ctx.storage.put(
      `alive:${fp}`,
      alive.filter((c) => c !== corr),
    );
  }

  private async resolveSession(fp: string, ticket?: string | null) {
    const corr = ticket == null ? "" : String(ticket).trim();
    const owner = corr ? await this.ctx.storage.get<string>(`own:${corr}`) : undefined;
    const live = (await this.ctx.storage.get<string>(`live:${fp}`)) ?? "";
    return resolveTicket({ fingerprint: fp, ticket: corr, owner, live });
  }

  private async mark(
    id: string,
    extra: { name: string; os: string; online: boolean; agentVer?: string; userId?: string },
  ) {
    const row: DeviceRow = {
      id,
      name: extra.name,
      os: extra.os,
      online: extra.online,
      lastSeen: Date.now(),
      agentVer: extra.agentVer,
      userId: extra.userId,
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

async function resolveActor(
  request: Request,
  env: Env,
  fleet: DurableObjectStub,
): Promise<Actor | null> {
  const need = env.HUB_TOKEN?.trim();
  if (need && bearer(request) === need) return { id: "*", super: true };
  const res = await fleet.fetch(new Request("https://fleet/resolve", { headers: request.headers }));
  const data = (await res.json()) as Actor;
  return data.id ? data : null;
}

async function owns(fleet: DurableObjectStub, actor: Actor, deviceId: string): Promise<boolean> {
  if (actor.super) return true;
  const res = await fleet.fetch(new Request(`https://fleet/device?id=${encodeURIComponent(deviceId)}`));
  const row = (await res.json()) as DeviceRow;
  return Boolean(row.id && row.userId === actor.id);
}

function withCookies(res: Response, setCookie?: string): Response {
  const headers = new Headers(res.headers);
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

async function sha256hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mintHubToken() {
  const raw = "flt_" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { raw, hash: await sha256hex(raw), prefix: raw.slice(0, 12) };
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

function operatorHeaders(request: Request): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const fp = fingerprintFromHeaders(request.headers);
  if (fp) headers.set(FLEET_OPERATOR_HEADER, fp);
  return headers;
}

function deviceFingerprint(request: Request, bodyFp?: string): string {
  const headerFp = fingerprintFromHeaders(request.headers);
  if (headerFp) return headerFp;
  return bodyFp == null ? ANON_FINGERPRINT : String(bodyFp).trim();
}

function withFingerprint(body: Record<string, unknown>, fp: string): Record<string, unknown> {
  if (fp) return { ...body, fingerprint: fp };
  return body;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
