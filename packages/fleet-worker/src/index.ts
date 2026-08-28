/**
 * Fleet hub — Cloudflare Worker + Durable Objects.
 *
 * Devices (Windows / Mac / Linux agents) dial OUT over WSS to /v1/device.
 * Operators call HTTPS: list_computers / get_computer / heartbeat / select_computer / run / get_result.
 * No inbound ports on the machines. No intranet overlay.
 *
 * Auth: per-account flt_1 tokens (RSA-2048, aud = HUB_ORIGIN). /v1 operators
 * and agents present Fleet-OAEP wraps. Remote MCP uses Bearer to initialize
 * Streamable HTTP or classic SSE sessions; session endpoints never carry the token. Optional secret
 * HUB_TOKEN is a super operator for HTTP list/run only — it cannot steal a
 * device WebSocket. Empty HUB_TOKEN = no super user. Optional ADMIN_EMAILS
 * is a cookie-session list for /ops on this same Worker. Empty = no admins.
 */

import { handleOAuth } from "./oauth";
import { applyBannedState, rejectIfBanned } from "./ban.mjs";
import { canClaimDevice, deviceOwnerConflict } from "./bind.mjs";
import {
  deviceCatalogKey,
  listCatalogDevices,
  markUserDeviceIndexReady,
  rememberDeviceOwner,
} from "./device-catalog.mjs";
import { handleOpsRoute, isOpsAdmin } from "./ops.mjs";
import {
  DESKTOP_WAIT_MS,
  advertisedUpdate,
  agentVerFromBody,
  archFromBody,
  clampHeartbeatWaitMs,
  computerPublic,
  hasComputerUse,
  normalizeCaps,
  normalizePermit,
  unsupportedCapBody,
} from "./presence.mjs";
import {
  ANON_FINGERPRINT,
  FLEET_OPERATOR_HEADER,
  fingerprintFromHeaders,
  resolveTicket,
} from "./session.mjs";
import { isFleetToolTgzPath, serveFleetToolTgz } from "./tarball.mjs";
import {
  isInitializeMessage,
  isJsonRpcMessage,
  isMcpActivity,
  McpRpcSession,
  negotiateStreamableProtocolVersion,
  type JsonRpcMessage,
  type McpOperatorState,
} from "../../fleet-tool/mcp-protocol.mjs";
import {
  isDeviceTransportPath,
  officialPlugin,
  wrapTransportRpc,
} from "../../fleet-tool/operator.mjs";
import {
  MCP_SESSION_IDLE_MS,
  MCP_SESSION_MAX_AGE_MS,
  McpSseSession,
  isMcpSessionExpired,
} from "./mcp-sse.mjs";
import {
  isPluginArtifactPath,
  serveOfficialPluginArtifact,
  withPluginArtifactMirrors,
} from "./plugin-artifact.mjs";
import {
  buildPeerSessionTicketStatement,
  PEER_SESSION_CONTROL_MAX_BYTES,
  PEER_SESSION_PROTOCOL,
  PEER_SESSION_TTL_MS,
  PeerSessionDO,
  PeerSessionError,
  readPeerSessionControlText,
  type PeerSessionRecord,
} from "./peer-session";
import {
  audMismatch,
  bearerToken,
  CHALLENGE_TTL_MS,
  HIGH_SEC_HANDSHAKE,
  HIGH_SEC_KEY_MISMATCH,
  HIGH_SEC_UPGRADE,
  dropChallengeNonce,
  hashHubToken,
  hubOrigin,
  isLegacyFlt,
  mintTokenV1,
  nextChallengeList,
  parseAuthorization,
  signChallenge,
  signFleetStatement,
  unwrapAuth,
  verifyTokenV1,
} from "./tokenv1.mjs";

export interface Env {
  DEVICE: DurableObjectNamespace;
  FLEET: DurableObjectNamespace;
  MCP: DurableObjectNamespace;
  PEER_SESSION: DurableObjectNamespace;
  HUB_TOKEN?: string;
  ADMIN_EMAILS?: string;
  HUB_ORIGIN?: string;
  ASSETS?: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  LATEST_AGENT_VER?: string;
  AGENT_UPDATE_BASE?: string;
  AGENT_UPDATE_CHECKSUMS?: string;
  AGENT_UPDATE_SUMS?: string;
  RTC_STUN_URLS?: string;
}

export { PeerSessionDO };

export const PEER_SESSION_ACCOUNT_LIMIT = 32;

type PeerSessionReservation = {
  sessionId: string;
  expiresAt: number;
};

function updateAdvert(env: Env) {
  return advertisedUpdate({
    latestAgentVer: env.LATEST_AGENT_VER,
    updateBase: env.AGENT_UPDATE_BASE,
    checksumsUrl: env.AGENT_UPDATE_CHECKSUMS,
    checksumsText: env.AGENT_UPDATE_SUMS,
  });
}

const HUB_WAIT_MAX_MS = 30_000;
const HUB_WAIT_POLL_MS = 25;
const RTC_SIGNAL_TTL_MS = 60_000;
const RTC_SDP_MAX_BYTES = 128 << 10;
export const DEVICE_WS_TEXT_MAX_BYTES = 16 << 20;
type PeerDeliveryState = { id: string; at: number; state: "pending" | "acked" };

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

function isDeviceEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.v === 1 &&
    typeof row.type === "string" &&
    row.type.length > 0 &&
    Boolean(row.body) &&
    typeof row.body === "object" &&
    !Array.isArray(row.body)
  );
}

type DeviceRow = {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen: number;
  agentVer?: string;
  arch?: string;
  userId?: string;
  caps?: string[];
  permit?: "off" | "ask" | "allow";
};

type WsAttachment = {
  deviceId?: string;
  name?: string;
  os?: string;
  userId?: string;
  kid?: string;
  caps?: string[];
  permit?: string;
  agentVer?: string;
};

type Actor = { id: string; email?: string; kid?: string; super?: boolean; banned?: boolean };

type UserRow = {
  id: string;
  email: string;
  salt: string;
  pass: string;
  tokenHash?: string;
  tokenPrefix?: string;
  tokenAt?: number;
  kid?: string;
  pub?: string;
  priv?: string;
  banned?: boolean;
  bannedAt?: number;
};

type SignedFleetStatement = { payload: string; sig: string };
type RevocationNotice = {
  kid: string;
  statement: SignedFleetStatement;
};

type RtcSignalRow = {
  sid: string;
  userId: string;
  kid: string;
  deviceId: string;
  operatorId: string;
  offer: string;
  answer?: string;
  ticket?: SignedFleetStatement;
  createdAt: number;
  exp: number;
};

type Resolved =
  | { actor: Actor; error?: never; status?: never; code?: never }
  | { actor?: undefined; error: string; status: number; code?: string };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, x-device-id, x-device-name, x-device-os, x-fleet-proto, x-fleet-operator",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const hub = url.pathname === "/v1" || url.pathname.startsWith("/v1/");

    if (path === "/ops") {
      const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));
      return dispatchOps(request, env, fleet, "/ops");
    }

    if (isFleetToolTgzPath(path)) {
      if (!env.ASSETS) return new Response("site missing", { status: 500 });
      return serveFleetToolTgz(await env.ASSETS.fetch(request));
    }

    if (path === "/mcp/sse") {
      return dispatchMcpSse(request, env);
    }

    if (path === "/mcp") {
      return dispatchMcpHttp(request, env);
    }

    if (!hub) {
      if (!env.ASSETS) return new Response("site missing", { status: 500 });
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/v1/health") {
      return json({ name: "fleet-hub", v: 1, ok: true, ...updateAdvert(env) });
    }

    const oauth = await handleOAuth(request, env);
    if (oauth) return oauth;

    const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));

    if (url.pathname === "/v1/challenge" && request.method === "GET") {
      const kid = url.searchParams.get("kid") ?? "";
      return fleetChallenge(fleet, kid, configuredOrigin(env));
    }

    if (
      (url.pathname === "/v1/register" || url.pathname === "/v1/login") &&
      request.method === "POST"
    ) {
      return json({ error: "email login disabled" }, 404);
    }
    if (url.pathname === "/v1/logout" && request.method === "POST") {
      await fleet.fetch(
        new Request("https://fleet/logout", {
          method: "POST",
          headers: { cookie: request.headers.get("cookie") ?? "" },
        }),
      );
      return withCookies(
        json({ ok: true }),
        "fleet_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      );
    }
    if (url.pathname === "/v1/me" && request.method === "GET") {
      const resolved = await resolveActor(request, env, fleet);
      if (!resolved.actor || resolved.actor.super) return deny(resolved, true);
      return json({
        id: resolved.actor.id,
        email: resolved.actor.email,
        ops: isOpsAdmin(resolved.actor, env.ADMIN_EMAILS),
      });
    }
    if (url.pathname === "/v1/hub_token" && request.method === "GET") {
      const resolved = await resolveActor(request, env, fleet);
      if (!resolved.actor || resolved.actor.super) return deny(resolved, true);
      return fleet.fetch(
        new Request(`https://fleet/token-meta?user=${encodeURIComponent(resolved.actor.id)}`),
      );
    }
    if (url.pathname === "/v1/hub_token" && request.method === "POST") {
      const resolved = await resolveActor(request, env, fleet);
      if (!resolved.actor || resolved.actor.super) return deny(resolved, true);
      const aud = encodeURIComponent(configuredOrigin(env));
      return fleet.fetch(
        new Request(
          `https://fleet/token-issue?user=${encodeURIComponent(resolved.actor.id)}&aud=${aud}`,
          {
            method: "POST",
          },
        ),
      );
    }

    if (url.pathname === "/v1/ops/overview" && request.method === "GET") {
      return dispatchOps(request, env, fleet, "/v1/ops/overview");
    }
    if (url.pathname === "/v1/ops/banned" && request.method === "POST") {
      return dispatchOps(request, env, fleet, "/v1/ops/banned");
    }

    if (url.pathname === "/v1/device") {
      const resolved = await resolveActor(request, env, fleet);
      if (!resolved.actor) return deny(resolved);
      const actor = resolved.actor;
      if (!actor.kid || actor.super) {
        return json({ error: "device WebSocket requires a per-account Hub token" }, 401);
      }
      const deviceId = deviceIdFrom(request);
      if (!deviceId) return json({ error: "x-device-id required" }, 400);
      const rowRes = await fleet.fetch(
        new Request(`https://fleet/device?id=${encodeURIComponent(deviceId)}`),
      );
      const row = (await rowRes.json()) as DeviceRow;
      if (!canClaimDevice(row.userId, actor.id)) {
        return json({ error: "taken" }, 409);
      }
      const headers = new Headers(request.headers);
      headers.set("x-fleet-user", actor.id);
      if (actor.kid) headers.set("x-fleet-kid", actor.kid);
      const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
      return stub.fetch(new Request(request, { headers }));
    }

    const resolved = await resolveActor(request, env, fleet);
    if (!resolved.actor) return deny(resolved);
    const response = await handleAuthorizedOperatorRequest(request, env, fleet, resolved.actor);
    return response ?? json({ error: "not found" }, 404);
  },
};

async function handleAuthorizedOperatorRequest(
  request: Request,
  env: Env,
  fleet: DurableObjectStub,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (isPluginArtifactPath(url.pathname)) {
    if (actor.super) return json({ error: "account authentication required" }, 401);
    return serveOfficialPluginArtifact(request);
  }

  if (url.pathname.startsWith("/v1/plugin-peer-session/")) {
    return handlePeerSessionOperatorRequest(request, env, fleet, actor);
  }

  if (url.pathname === "/v1/rtc/config" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { device_id?: string };
    if (!actor.kid || actor.super)
      return json({ error: "RTC requires a per-account hub token" }, 401);
    if (!body.device_id) return json({ error: "device_id required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const catalog = await fleet.fetch(
      new Request(`https://fleet/device?id=${encodeURIComponent(body.device_id)}`),
    );
    const row = (await catalog.json()) as DeviceRow;
    if (!row.online || !normalizeCaps(row.caps).includes("rtc_v1")) {
      return json({ available: false, reason: "agent does not advertise rtc_v1" });
    }
    return json({ available: true, stun_urls: rtcStunURLs(env) });
  }

  if (url.pathname === "/v1/rtc/offer" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      device_id?: string;
      sid?: string;
      offer?: string;
    };
    if (!actor.kid || actor.super)
      return json({ error: "RTC requires a per-account hub token" }, 401);
    if (!body.device_id || !validRtcSid(body.sid) || !validRtcSdp(body.offer)) {
      return json({ error: "valid device_id, sid, and offer required" }, 400);
    }
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(
      new Request("https://device/rtc-offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sid: body.sid,
          offer: body.offer,
          user_id: actor.id,
          kid: actor.kid,
          device_id: body.device_id,
          operator_id: fingerprintFromHeaders(request.headers),
          stun_urls: rtcStunURLs(env),
        }),
      }),
    );
  }

  if (url.pathname === "/v1/rtc/session" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { device_id?: string; sid?: string };
    if (!actor.kid || actor.super)
      return json({ error: "RTC requires a per-account hub token" }, 401);
    if (!body.device_id || !validRtcSid(body.sid))
      return json({ error: "device_id and sid required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(
      new Request("https://device/rtc-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sid: body.sid,
          user_id: actor.id,
          kid: actor.kid,
          operator_id: fingerprintFromHeaders(request.headers),
        }),
      }),
    );
  }

  if (url.pathname === "/v1/rtc/cancel" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { device_id?: string; sid?: string };
    if (!actor.kid || actor.super)
      return json({ error: "RTC requires a per-account hub token" }, 401);
    if (!body.device_id || !validRtcSid(body.sid))
      return json({ error: "device_id and sid required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(
      new Request("https://device/rtc-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sid: body.sid,
          user_id: actor.id,
          kid: actor.kid,
          operator_id: fingerprintFromHeaders(request.headers),
        }),
      }),
    );
  }

  if (url.pathname === "/v1/rtc/result" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      device_id?: string;
      corr?: string;
      type?: string;
    };
    if (!body.device_id || !validRtcCorr(String(body.corr ?? "")) || body.type !== "desktop") {
      return json({ error: "valid device_id, corr, and type required" }, 400);
    }
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    const q = new URLSearchParams({ corr: body.corr!, type: body.type });
    return stub.fetch(
      new Request(`https://device/rtc-result?${q}`, { headers: operatorHeaders(request) }),
    );
  }

  if (url.pathname === "/v1/list_computers" && request.method === "POST") {
    const q = actor.super ? "" : `?user=${encodeURIComponent(actor.id)}`;
    return fleet.fetch(new Request(`https://fleet/list${q}`));
  }

  if (url.pathname === "/v1/get_computer" && request.method === "POST") {
    const body = (await request.json()) as { device_id?: string };
    if (!body.device_id) return json({ error: "device_id required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const res = await fleet.fetch(
      new Request(`https://fleet/device?id=${encodeURIComponent(body.device_id)}`),
    );
    const row = computerPublic(await res.json());
    return row ? json(row) : json({ error: "not found" }, 404);
  }

  if (url.pathname === "/v1/heartbeat" && request.method === "POST") {
    const body = (await request.json()) as { device_id?: string; wait_ms?: number };
    if (!body.device_id) return json({ error: "device_id required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const catalog = await fleet.fetch(
      new Request(`https://fleet/device?id=${encodeURIComponent(body.device_id)}`),
    );
    if (!computerPublic(await catalog.json())) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(
      new Request("https://device/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: body.device_id, wait_ms: body.wait_ms }),
      }),
    );
  }

  if (
    (url.pathname === "/v1/desktop_screenshot" || url.pathname === "/v1/desktop_action") &&
    request.method === "POST"
  ) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceId = String(body.device_id ?? "");
    if (!deviceId) return json({ error: "device_id required" }, 400);
    if (!(await owns(fleet, actor, deviceId))) return json({ error: "not found" }, 404);
    const catalog = await fleet.fetch(
      new Request(`https://fleet/device?id=${encodeURIComponent(deviceId)}`),
    );
    const row = (await catalog.json()) as DeviceRow;
    if (!computerPublic(row)) return json({ error: "not found" }, 404);
    if (!hasComputerUse(row)) return json(unsupportedCapBody(row), 409);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
    return stub.fetch(
      new Request("https://device/desktop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(desktopPlan(url.pathname, body)),
      }),
    );
  }

  if (url.pathname === "/v1/plugin" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceId = String(body.device_id ?? "");
    const operation = String(body.operation ?? "");
    const pluginId = String(body.plugin_id ?? "");
    if (!deviceId || !operation) return json({ error: "device_id and operation required" }, 400);
    if (!(await owns(fleet, actor, deviceId))) return json({ error: "not found" }, 404);
    const catalog = await fleet.fetch(
      new Request(`https://fleet/device?id=${encodeURIComponent(deviceId)}`),
    );
    const row = (await catalog.json()) as DeviceRow;
    if (!computerPublic(row)) return json({ error: "not found" }, 404);
    if (!normalizeCaps(row.caps).includes("plugins")) {
      return json(
        {
          error: "unsupported",
          code: "UNSUPPORTED_CAP",
          missing: "plugins",
          agentVer: row.agentVer ?? "",
          os: row.os ?? "",
        },
        409,
      );
    }
    const plugin = pluginId ? officialPlugin(pluginId) : null;
    if (operation !== "list" && !plugin) return json({ error: "official plugin not found" }, 404);
    if (!["list", "install", "uninstall", "invoke"].includes(operation)) {
      return json({ error: "invalid plugin operation" }, 400);
    }
    if (operation === "invoke") {
      const action = String(body.action ?? "").trim();
      if (!plugin || !isTaskPluginAction(plugin, action)) {
        return json(
          {
            error: "plugin action requires the peer runtime",
            code: "WRONG_PLUGIN_RUNTIME",
          },
          409,
        );
      }
    }
    const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
    return stub.fetch(
      new Request("https://device/plugin", {
        method: "POST",
        headers: operatorHeaders(request),
        body: JSON.stringify({
          operation,
          plugin_id: pluginId,
          action: body.action,
          input: body.input,
          timeout_seconds: body.timeout_seconds,
          ...(operation === "install"
            ? { manifest: withPluginArtifactMirrors(plugin, configuredOrigin(env)) }
            : {}),
        }),
      }),
    );
  }

  if (url.pathname === "/v1/plugin_result" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { device_id?: string; corr?: string };
    if (!body.device_id || !body.corr) return json({ error: "device_id and corr required" }, 400);
    if (!(await owns(fleet, actor, body.device_id))) return json({ error: "not found" }, 404);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(
      new Request(`https://device/plugin-result?corr=${encodeURIComponent(body.corr)}`, {
        headers: operatorHeaders(request),
      }),
    );
  }

  if (url.pathname === "/v1/select_computer" && request.method === "POST") {
    const body = (await request.json()) as { id?: string };
    return body.id ? json({ selected: body.id }) : json({ error: "id required" }, 400);
  }

  if (url.pathname === "/v1/run" && request.method === "POST") {
    const body = (await request.json()) as {
      device_id?: string;
      command?: string;
      wait_ms?: number;
    };
    if (!body.device_id || !body.command)
      return json({ error: "device_id and command required" }, 400);
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
    const body = (await request.json()) as {
      device_id?: string;
      keys?: string;
      key?: string;
      corr?: string;
    };
    if (!body.device_id || (body.keys == null && body.key == null)) {
      return json({ error: "device_id and keys or key required" }, 400);
    }
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
    return stub.fetch(
      new Request(`https://device/screen${q}`, { headers: operatorHeaders(request) }),
    );
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
    return stub.fetch(
      new Request(`https://device/result${suffix}`, { headers: operatorHeaders(request) }),
    );
  }

  return null;
}

async function handlePeerSessionOperatorRequest(
  request: Request,
  env: Env,
  fleet: DurableObjectStub,
  actor: Actor,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!actor.kid || actor.super) {
    return json({ error: "peer sessions require a per-account Hub token" }, 401);
  }
  const operatorId = fingerprintFromHeaders(request.headers);
  if (!operatorId) return json({ error: "X-Fleet-Operator required" }, 400);
  const url = new URL(request.url);
  const action = url.pathname.slice("/v1/plugin-peer-session/".length);
  if (!["create", "authorize", "signal", "inbox/poll", "status", "event"].includes(action)) {
    return json({ error: "not found" }, 404);
  }
  let rawBody: string;
  try {
    rawBody = await readPeerSessionControlText(request, PEER_SESSION_CONTROL_MAX_BYTES);
  } catch (error) {
    if (error instanceof PeerSessionError) return json({ error: error.message }, error.status);
    return json({ error: "invalid peer session control request" }, 400);
  }
  const body = (() => {
    try {
      return JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "JSON object required" }, 400);
  }

  let sessionId: string;
  let payload: Record<string, unknown>;
  if (action === "create") {
    sessionId = String(body.session_id ?? "");
    if (!validPeerSessionId(sessionId)) {
      return json({ error: "valid session_id required" }, 400);
    }
    const protocolId = String(body.protocol_id ?? "").trim();
    const initiator = String(body.initiator ?? "");
    if (initiator !== "source" && initiator !== "target") {
      return json({ error: "initiator must be source or target" }, 400);
    }
    const sourceSpec = peerEndpointSpec(body.source, protocolId, "source");
    const targetSpec = peerEndpointSpec(body.target, protocolId, "target");
    if (!sourceSpec || !targetSpec || !samePeerProtocol(sourceSpec.protocol, targetSpec.protocol)) {
      return json(
        {
          error: "official plugins do not share the selected peer protocol",
          code: "UNSUPPORTED_PLUGIN",
        },
        409,
      );
    }
    const prepared: Array<Record<string, unknown>> = [];
    for (const spec of [sourceSpec, targetSpec]) {
      const endpoint = spec.endpoint;
      if (endpoint.kind === "tool" && endpoint.id !== operatorId) {
        return json({ error: "tool endpoint must match X-Fleet-Operator" }, 403);
      }
      if (endpoint.kind === "tool") {
        prepared.push({ ...endpoint, name: "Fleet Tool" });
        continue;
      }
      const catalog = await fleet.fetch(
        new Request(`https://fleet/device?id=${encodeURIComponent(String(endpoint.id))}`),
      );
      const row = (await catalog.json()) as DeviceRow;
      if (!row.id || row.userId !== actor.id) return json({ error: "not found" }, 404);
      if (!row.online) return json({ error: "device offline", code: "OFFLINE" }, 409);
      const advertised = normalizeCaps(row.caps);
      if (!advertised.includes(PEER_SESSION_PROTOCOL)) {
        return json(
          {
            error: "unsupported",
            code: "UNSUPPORTED_CAP",
            missing: PEER_SESSION_PROTOCOL,
            agentVer: row.agentVer ?? "",
            os: row.os ?? "",
          },
          409,
        );
      }
      prepared.push({ ...endpoint, name: row.name || endpoint.id });
    }
    payload = {
      session_id: sessionId,
      user_id: actor.id,
      kid: actor.kid,
      operator_id: operatorId,
      coordinator: { kind: "tool", id: operatorId, name: "Fleet Tool" },
      protocol: sourceSpec.protocol,
      initiator,
      source: prepared[0],
      target: prepared[1],
    };
  } else {
    sessionId = String(body.session_id ?? "");
    if (!validPeerSessionId(sessionId)) return json({ error: "valid session_id required" }, 400);
    const { session_id: _sessionId, ...rest } = body;
    payload = rest;
  }

  const reservation = await reservePeerSession(fleet, actor.id, sessionId);
  if (!reservation.ok) return withCors(reservation);

  const headers = new Headers({
    "content-type": "application/json",
    "x-fleet-user": actor.id,
    "x-fleet-kid": actor.kid,
    "x-peer-caller-kind": "tool",
    "x-peer-caller-id": operatorId,
  });
  const response = await env.PEER_SESSION.get(env.PEER_SESSION.idFromName(sessionId)).fetch(
    new Request(`https://peer-session/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
  );
  const responseHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) responseHeaders.set(key, value);
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

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
      const row = await this.ctx.storage.get<DeviceRow>(deviceCatalogKey(id));
      return json(row ?? {});
    }
    if (url.pathname === "/upsert" && request.method === "POST") {
      const row = (await request.json()) as DeviceRow;
      const prev = await this.ctx.storage.get<DeviceRow>(deviceCatalogKey(row.id));
      if (deviceOwnerConflict(prev?.userId, row.userId)) {
        return json({ error: "taken" }, 409);
      }
      const next: DeviceRow = { ...prev, ...row, id: row.id };
      if (prev?.userId && !row.userId) next.userId = prev.userId;
      await this.ctx.storage.put(deviceCatalogKey(row.id), next);
      await rememberDeviceOwner(this.ctx.storage, prev, next);
      return json({ ok: true });
    }
    if (url.pathname === "/oauth" && request.method === "POST") {
      const body = (await request.json()) as { email?: string; provider?: string };
      return this.oauthUser(body.email ?? "", body.provider ?? "oauth");
    }
    if (url.pathname === "/oauth-pending" && request.method === "POST") {
      const body = (await request.json()) as {
        state?: string;
        provider?: "google" | "x";
        verifier?: string;
        exp?: number;
      };
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
      const row = await this.ctx.storage.get<{
        provider: "google" | "x";
        verifier?: string;
        exp: number;
      }>(`oauth:${state}`);
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
    if (url.pathname === "/challenge" && request.method === "GET") {
      return this.challenge(url.searchParams.get("kid") ?? "", url.searchParams.get("aud") ?? "");
    }
    if (url.pathname === "/resolve-wrap" && request.method === "POST") {
      const body = (await request.json()) as { kid?: string; wrap?: string };
      return this.resolveWrap(body.kid ?? "", body.wrap ?? "");
    }
    if (url.pathname === "/resolve-bearer" && request.method === "POST") {
      const body = (await request.json()) as { token?: string };
      return this.resolveBearer(body.token ?? "");
    }
    if (url.pathname === "/validate-mcp" && request.method === "POST") {
      const body = (await request.json()) as { id?: string; kid?: string };
      return this.validateMcp(body.id ?? "", body.kid ?? "");
    }
    if (url.pathname === "/rtc-ticket" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return this.rtcTicket(body);
    }
    if (url.pathname === "/peer-session-ticket" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { record?: PeerSessionRecord };
      return this.peerSessionTicket(body.record);
    }
    if (url.pathname === "/peer-session-reserve" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        user_id?: unknown;
        session_id?: unknown;
      };
      return this.reservePeerSession(
        String(body.user_id ?? ""),
        String(body.session_id ?? ""),
      );
    }
    if (url.pathname === "/token-meta") {
      const userId = url.searchParams.get("user") ?? "";
      const user = await this.userById(userId);
      if (!user) return json({ error: "unauthorized" }, 401);
      const banned = rejectIfBanned(user);
      if (banned) return json({ error: banned.error }, banned.status);
      return json({
        hasToken: Boolean(user.tokenHash),
        prefix: user.tokenPrefix ?? "",
        createdAt: user.tokenAt ?? 0,
      });
    }
    if (url.pathname === "/ops-catalog") {
      return json({ users: await this.listOpsUsers(), devices: await this.listOpsDevices() });
    }
    if (url.pathname === "/ops-banned" && request.method === "POST") {
      const body = (await request.json()) as { id?: string; banned?: boolean };
      const row = await this.setUserBanned(body.id ?? "", body.banned);
      if (!row) return json({ error: "not found" }, 404);
      return json(row);
    }
    if (url.pathname === "/token-issue" && request.method === "POST") {
      const userId = url.searchParams.get("user") ?? "";
      const user = await this.userById(userId);
      if (!user) return json({ error: "unauthorized" }, 401);
      const banned = rejectIfBanned(user);
      if (banned) return json({ error: banned.error }, banned.status);
      const revocation = await this.beginTokenRevocation(user);
      // A live RTC channel bypasses the hub data path, so revocation is not
      // complete until every device DO has closed its control socket. Keep the
      // old signing key for a retry if a kick fails; the revoked marker already
      // prevents all new authentication with it.
      await this.kickUserDevices(user.id, revocation);
      await this.revokeToken(user);
      const minted = await mintTokenV1({ aud: url.searchParams.get("aud") ?? "" });
      user.tokenHash = minted.hash;
      user.tokenPrefix = minted.prefix;
      user.tokenAt = Date.now();
      user.kid = minted.kid;
      user.pub = minted.pub;
      user.priv = minted.priv;
      await this.ctx.storage.put(`u:${user.email}`, user);
      await this.ctx.storage.put(`id:${user.id}`, user.email);
      await this.ctx.storage.put(`tok:${minted.hash}`, user.id);
      await this.ctx.storage.put(`kid:${minted.kid}`, user.id);
      return json({ token: minted.raw, prefix: minted.prefix });
    }
    return json({ error: "not found" }, 404);
  }

  async list(userId: string | null): Promise<DeviceRow[]> {
    const rows = await listCatalogDevices<DeviceRow>(this.ctx.storage, userId);
    rows.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      os: r.os,
      online: r.online,
      lastSeen: r.lastSeen,
      agentVer: r.agentVer,
      caps: normalizeCaps(r.caps),
      permit: normalizePermit(r.permit),
    }));
  }

  private async reservePeerSession(
    userId: string,
    sessionId: string,
  ): Promise<Response> {
    if (
      !/^[a-zA-Z0-9._:@-]{1,128}$/.test(userId) ||
      !validPeerSessionId(sessionId)
    ) {
      return json({ error: "invalid peer session reservation" }, 400);
    }

    const now = Date.now();
    const key = `peer-session-reservations:${userId}`;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PeerSessionReservation[]>(key);
      const current = (Array.isArray(stored) ? stored : []).filter(
        (item): item is PeerSessionReservation =>
          Boolean(
            item &&
              validPeerSessionId(item.sessionId) &&
              Number.isFinite(item.expiresAt) &&
              item.expiresAt > now,
          ),
      );
      const known = current.find((item) => item.sessionId === sessionId);
      if (known) {
        if (!Array.isArray(stored) || current.length !== stored.length) {
          await txn.put(key, current);
        }
        return { ok: true as const, replay: true, expiresAt: known.expiresAt };
      }
      if (current.length >= PEER_SESSION_ACCOUNT_LIMIT) {
        if (!Array.isArray(stored) || current.length !== stored.length) {
          await txn.put(key, current);
        }
        return {
          ok: false as const,
          retryAfterMs: Math.max(1, Math.min(...current.map((item) => item.expiresAt)) - now),
        };
      }
      const expiresAt = now + PEER_SESSION_TTL_MS;
      await txn.put(key, [...current, { sessionId, expiresAt }]);
      return { ok: true as const, replay: false, expiresAt };
    });

    if (!result.ok) {
      const response = json(
        {
          error: "too many peer sessions",
          code: "PEER_SESSION_LIMIT",
          limit: PEER_SESSION_ACCOUNT_LIMIT,
          retry_after_ms: result.retryAfterMs,
        },
        429,
      );
      response.headers.set(
        "retry-after",
        String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      );
      return response;
    }
    return json({
      ok: true,
      session_id: sessionId,
      replay: result.replay,
      expires_at: result.expiresAt,
    });
  }

  async resolve(request: Request): Promise<Actor | null> {
    const sid = cookie(request, "fleet_session");
    if (sid) {
      const userId = await this.ctx.storage.get<string>(`sess:${sid}`);
      if (userId) {
        const email = await this.ctx.storage.get<string>(`id:${userId}`);
        const user = email ? await this.ctx.storage.get<UserRow>(`u:${email}`) : null;
        if (user) return { id: user.id, email: user.email, banned: Boolean(user.banned) };
      }
    }
    return null;
  }

  async challenge(kid: string, aud: string): Promise<Response> {
    const origin = hubOrigin(aud);
    if (!kid || !origin) return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    if (await this.ctx.storage.get(`revoked:${kid}`))
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    const userId = await this.ctx.storage.get<string>(`kid:${kid}`);
    const user = userId ? await this.userById(userId) : null;
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (!user?.priv || user.kid !== kid) return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const exp = Date.now() + CHALLENGE_TTL_MS;
    const live = (await this.ctx.storage.get<string[]>(`chals:${kid}`)) ?? [];
    const { list, dropped } = nextChallengeList(live, nonce);
    await Promise.all(dropped.map((n) => this.ctx.storage.delete(`chal:${n}`)));
    await this.ctx.storage.put(`chal:${nonce}`, { kid, userId: user.id, exp });
    await this.ctx.storage.put(`chals:${kid}`, list);
    const sig = await signChallenge({ privatePkcs8B64: user.priv, aud: origin, kid, nonce });
    if (await this.ctx.storage.get(`revoked:${kid}`))
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    return json({ nonce, kid, aud: origin, exp, sig });
  }

  async resolveWrap(kid: string, wrap: string): Promise<Response> {
    if (!kid || !wrap) return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    if (await this.ctx.storage.get(`revoked:${kid}`))
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    const userId = await this.ctx.storage.get<string>(`kid:${kid}`);
    const user = userId ? await this.userById(userId) : null;
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (!user?.priv || user.kid !== kid) return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    let opened: { sec: string; nonce: string };
    try {
      opened = await unwrapAuth({ privatePkcs8B64: user.priv, wrapB64: wrap });
    } catch {
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    }
    const chal = await this.ctx.storage.get<{ kid: string; userId: string; exp: number }>(
      `chal:${opened.nonce}`,
    );
    await this.ctx.storage.delete(`chal:${opened.nonce}`);
    const live = (await this.ctx.storage.get<string[]>(`chals:${kid}`)) ?? [];
    await this.ctx.storage.put(`chals:${kid}`, dropChallengeNonce(live, opened.nonce));
    if (!chal || chal.kid !== kid || chal.userId !== user.id || chal.exp < Date.now()) {
      return highSecJson(HIGH_SEC_HANDSHAKE, 401);
    }
    const hash = await hashHubToken(opened.sec);
    if (await this.ctx.storage.get(`revoked:${kid}`))
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    if (hash !== user.tokenHash) return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    return json({ id: user.id, email: user.email, kid });
  }

  async resolveBearer(token: string): Promise<Response> {
    let claims: Awaited<ReturnType<typeof verifyTokenV1>>;
    try {
      claims = await verifyTokenV1(token);
    } catch (error) {
      return highSecJson(error instanceof Error ? error.message : HIGH_SEC_UPGRADE, 401);
    }
    const origin = configuredOrigin(this.env);
    if (claims.aud !== origin) return highSecJson(audMismatch(claims.aud, origin), 401);
    const userId = await this.ctx.storage.get<string>(`kid:${claims.kid}`);
    const user = userId ? await this.userById(userId) : null;
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    const hash = await hashHubToken(claims.sec);
    if (
      !user ||
      user.kid !== claims.kid ||
      user.pub !== claims.pub ||
      user.tokenHash !== hash ||
      (await this.ctx.storage.get(`revoked:${claims.kid}`))
    ) {
      return highSecJson(HIGH_SEC_KEY_MISMATCH, 401);
    }
    return json({ id: user.id, email: user.email, kid: claims.kid });
  }

  async validateMcp(userId: string, kid: string): Promise<Response> {
    const user = userId ? await this.userById(userId) : null;
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (
      !user ||
      !kid ||
      user.kid !== kid ||
      !user.tokenHash ||
      (await this.ctx.storage.get(`revoked:${kid}`))
    ) {
      return json({ error: "Hub token was reset or revoked" }, 401);
    }
    return json({ id: user.id, email: user.email });
  }

  async rtcTicket(body: Record<string, unknown>): Promise<Response> {
    const userId = String(body.user_id ?? "");
    const kid = String(body.kid ?? "");
    const user = userId ? await this.userById(userId) : null;
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (
      !user?.priv ||
      !kid ||
      user.kid !== kid ||
      !user.tokenHash ||
      (await this.ctx.storage.get(`revoked:${kid}`))
    ) {
      return json({ error: "Hub token was reset or revoked" }, 401);
    }
    const now = Date.now();
    const statement = {
      v: 1,
      kind: "rtc_session",
      sid: String(body.sid ?? ""),
      kid,
      device_id: String(body.device_id ?? ""),
      operator_id: String(body.operator_id ?? ""),
      offer_fp: String(body.offer_fp ?? ""),
      answer_fp: String(body.answer_fp ?? ""),
      iat: now,
      exp: Math.min(Number(body.exp) || now + RTC_SIGNAL_TTL_MS, now + RTC_SIGNAL_TTL_MS),
    };
    if (
      !validRtcSid(statement.sid) ||
      !statement.device_id ||
      !statement.operator_id ||
      !validRtcFingerprint(statement.offer_fp) ||
      !validRtcFingerprint(statement.answer_fp) ||
      statement.exp <= statement.iat
    ) {
      return json({ error: "invalid RTC ticket" }, 400);
    }
    return json({ statement: await signFleetStatement({ privatePkcs8B64: user.priv, statement }) });
  }

  async peerSessionTicket(record?: PeerSessionRecord): Promise<Response> {
    if (!record?.userId || !record.kid) return json({ error: "invalid peer session ticket" }, 400);
    const user = await this.userById(record.userId);
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (
      !user?.priv ||
      user.kid !== record.kid ||
      !user.tokenHash ||
      (await this.ctx.storage.get(`revoked:${record.kid}`))
    ) {
      return json({ error: "Hub token was reset or revoked" }, 401);
    }
    try {
      const statement = buildPeerSessionTicketStatement(record);
      return json({
        statement: await signFleetStatement({
          privatePkcs8B64: user.priv,
          statement: { ...statement },
        }),
      });
    } catch {
      return json({ error: "invalid peer session ticket" }, 400);
    }
  }

  async revokeToken(user: UserRow) {
    if (user.tokenHash) await this.ctx.storage.delete(`tok:${user.tokenHash}`);
    if (user.kid) {
      const live = (await this.ctx.storage.get<string[]>(`chals:${user.kid}`)) ?? [];
      await Promise.all(live.map((n) => this.ctx.storage.delete(`chal:${n}`)));
      await this.ctx.storage.delete(`chals:${user.kid}`);
      await this.ctx.storage.delete(`kid:${user.kid}`);
    }
    user.tokenHash = undefined;
    user.tokenPrefix = undefined;
    user.kid = undefined;
    user.pub = undefined;
    user.priv = undefined;
    await this.ctx.storage.put(`u:${user.email}`, user);
  }

  async beginTokenRevocation(user: UserRow): Promise<RevocationNotice | null> {
    if (!user.kid || !user.priv) return null;
    const kid = user.kid;
    await this.ctx.storage.put(`revoked:${kid}`, Date.now());
    const previous = (await this.ctx.storage.get<string[]>(`revoked-kids:${user.id}`)) ?? [];
    const kids = [...previous.filter((value) => value !== kid), kid];
    while (kids.length > 16) {
      const dropped = kids.shift();
      if (dropped) await this.ctx.storage.delete(`revoked:${dropped}`);
    }
    await this.ctx.storage.put(`revoked-kids:${user.id}`, kids);
    const statement = await signFleetStatement({
      privatePkcs8B64: user.priv,
      statement: { v: 1, kind: "auth_revoked", kid, at: Date.now(), reason: "token_reset" },
    });
    return { kid, statement };
  }

  async kickUserDevices(userId: string, revocation: RevocationNotice | null = null) {
    const devices = (await this.list(userId)).filter((device) => device.online);
    for (let i = 0; i < devices.length; i += 32) {
      await Promise.all(
        devices.slice(i, i + 32).map((d) =>
          this.env.DEVICE.get(this.env.DEVICE.idFromName(d.id))
            .fetch(
              new Request("https://device/kick", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(revocation ?? {}),
              }),
            )
            .then((response) => {
              if (!response.ok) throw new Error(`device revocation failed: ${response.status}`);
            }),
        ),
      );
    }
  }

  async userById(userId: string): Promise<UserRow | null> {
    const email = await this.ctx.storage.get<string>(`id:${userId}`);
    if (!email) return null;
    return (await this.ctx.storage.get<UserRow>(`u:${email}`)) ?? null;
  }

  async listOpsUsers() {
    const map = await this.ctx.storage.list<UserRow>({ prefix: "u:" });
    return [...map.values()]
      .filter((u) => u && u.id && u.email)
      .map((u) => ({
        id: u.id,
        email: u.email,
        banned: Boolean(u.banned),
        hasToken: Boolean(u.tokenHash || u.kid),
      }));
  }

  async listOpsDevices() {
    const map = await this.ctx.storage.list<DeviceRow>({ prefix: "d:" });
    return [...map.values()]
      .filter((d) => d && d.id)
      .map((d) => ({
        id: d.id,
        os: d.os,
        arch: d.arch,
        agentVer: d.agentVer,
        online: Boolean(d.online),
        lastSeen: d.lastSeen,
        userId: d.userId,
      }));
  }

  async setUserBanned(id: string, banned: boolean | undefined) {
    if (typeof banned !== "boolean") return null;
    const user = await this.userById(String(id || "").trim());
    if (!user) return null;
    applyBannedState(user, banned);
    await this.ctx.storage.put(`u:${user.email}`, user);
    return { id: user.id, banned: Boolean(user.banned), bannedAt: user.bannedAt };
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
    await markUserDeviceIndexReady(this.ctx.storage, user.id);
    return this.issueSession(user);
  }

  async oauthUser(email: string, provider: string): Promise<Response> {
    email = email.trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "email required" }, 400);
    let user = await this.ctx.storage.get<UserRow>(`u:${email}`);
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email,
        salt: provider,
        pass: `oauth:${provider}`,
      };
      await this.ctx.storage.put(`u:${email}`, user);
      await this.ctx.storage.put(`id:${user.id}`, email);
      await markUserDeviceIndexReady(this.ctx.storage, user.id);
    }
    return this.issueSession(user);
  }

  async login(email: string, password: string): Promise<Response> {
    email = email.trim().toLowerCase();
    const user = await this.ctx.storage.get<UserRow>(`u:${email}`);
    if (!user || (await pbkdf2(password, user.salt)) !== user.pass) {
      return json({ error: "invalid" }, 401);
    }
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    return this.issueSession(user);
  }

  async issueSession(user: UserRow): Promise<Response> {
    const banned = rejectIfBanned(user);
    if (banned) return json({ error: banned.error }, banned.status);
    const sid = crypto.randomUUID() + crypto.randomUUID();
    await this.ctx.storage.put(`sess:${sid}`, user.id);
    const res = json({ id: user.id, email: user.email });
    return withCookies(
      res,
      `fleet_session=${sid}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
  }
}

class HubRpcError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error || body.code || `hub returned ${status}`));
    this.status = status;
    this.body = body;
  }
}

type McpHttpStoredSession = {
  actorId: string;
  kid: string;
  fingerprint: string;
  protocolVersion: string;
  openedAt: number;
  lastActivityAt: number;
  operatorState: McpOperatorState;
};

const MCP_HTTP_STORAGE_KEY = "http:session";

export class McpDO implements DurableObject {
  ctx: DurableObjectState;
  env: Env;
  private session: McpSseSession | null = null;
  private actor: Actor | null = null;
  private kid = "";
  private fingerprint = "";
  private httpSession: McpRpcSession | null = null;
  private httpStored: McpHttpStoredSession | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/open" && request.method === "GET") {
      if (this.session) return json({ error: "MCP session already open" }, 409);
      const id = request.headers.get("x-fleet-actor") ?? "";
      const kid = request.headers.get("x-fleet-kid") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!id || !kid || !sessionId) return json({ error: "unauthorized" }, 401);
      this.actor = { id, kid };
      this.kid = kid;
      this.fingerprint = crypto.randomUUID();
      this.session = new McpSseSession({ rpc: (path, body) => this.rpc(path, body) });
      return this.session.open(sessionId);
    }

    if (url.pathname === "/message" && request.method === "POST") {
      if (!this.session || this.session.closed || !this.actor || !this.kid) {
        return json({ error: "MCP session not found" }, 404);
      }
      const message = (await request.json().catch(() => null)) as JsonRpcMessage | null;
      if (!isJsonRpcMessage(message)) return json({ error: "invalid JSON-RPC message" }, 400);
      this.ctx.waitUntil(this.session.dispatch(message, () => this.authorize()));
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/http-open" && request.method === "POST") {
      if (await this.ctx.storage.get(MCP_HTTP_STORAGE_KEY)) {
        return json({ error: "MCP session already open" }, 409);
      }
      const actorId = request.headers.get("x-fleet-actor") ?? "";
      const kid = request.headers.get("x-fleet-kid") ?? "";
      const message = (await request.json().catch(() => null)) as JsonRpcMessage | null;
      if (!actorId || !kid) return json({ error: "unauthorized" }, 401);
      if (!isInitializeMessage(message) || message.id === undefined) {
        return jsonRpcError(null, -32600, "initialize request required", 400);
      }
      const now = Date.now();
      this.actor = { id: actorId, kid };
      this.kid = kid;
      this.fingerprint = crypto.randomUUID();
      this.httpStored = {
        actorId,
        kid,
        fingerprint: this.fingerprint,
        protocolVersion: negotiateStreamableProtocolVersion(message),
        openedAt: now,
        lastActivityAt: now,
        operatorState: {},
      };
      this.httpSession = this.newHttpSession(this.httpStored);
      await this.ctx.storage.put(MCP_HTTP_STORAGE_KEY, this.httpStored);
      const response = await this.httpSession.dispatch(message, () => this.authorize());
      await this.persistHttpSession(message.method);
      return response ? json(response) : jsonRpcError(null, -32603, "initialize failed", 500);
    }

    if (url.pathname === "/http-message" && request.method === "POST") {
      if (!(await this.restoreHttpSession())) return json({ error: "MCP session not found" }, 404);
      const message = (await request.json().catch(() => null)) as JsonRpcMessage | null;
      if (!isJsonRpcMessage(message))
        return jsonRpcError(null, -32700, "invalid JSON-RPC message", 400);
      const response = await this.httpSession!.dispatch(message, () => this.authorize());
      await this.persistHttpSession(message.method);
      return response ? json(response) : new Response(null, { status: 202, headers: CORS });
    }

    if (url.pathname === "/http-close" && request.method === "DELETE") {
      if (!(await this.ctx.storage.get(MCP_HTTP_STORAGE_KEY))) {
        return json({ error: "MCP session not found" }, 404);
      }
      await this.ctx.storage.delete(MCP_HTTP_STORAGE_KEY);
      this.httpSession = null;
      this.httpStored = null;
      this.actor = null;
      this.kid = "";
      this.fingerprint = "";
      return new Response(null, { status: 204, headers: CORS });
    }

    return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } });
  }

  private newHttpSession(stored: McpHttpStoredSession): McpRpcSession {
    return new McpRpcSession({
      rpc: (path, body) => this.rpc(path, body),
      state: stored.operatorState,
      protocolVersion: stored.protocolVersion,
    });
  }

  private async restoreHttpSession(): Promise<boolean> {
    const stored =
      this.httpStored ??
      (await this.ctx.storage.get<McpHttpStoredSession>(MCP_HTTP_STORAGE_KEY)) ??
      null;
    if (!stored) return false;
    if (
      isMcpSessionExpired({
        now: Date.now(),
        expiresAt: stored.openedAt + MCP_SESSION_MAX_AGE_MS,
        lastActivityAt: stored.lastActivityAt,
        idleMs: MCP_SESSION_IDLE_MS,
      })
    ) {
      await this.ctx.storage.delete(MCP_HTTP_STORAGE_KEY);
      this.httpStored = null;
      this.httpSession = null;
      this.actor = null;
      this.kid = "";
      this.fingerprint = "";
      return false;
    }
    this.httpStored = stored;
    this.actor = { id: stored.actorId, kid: stored.kid };
    this.kid = stored.kid;
    this.fingerprint = stored.fingerprint;
    this.httpSession ??= this.newHttpSession(stored);
    return true;
  }

  private async persistHttpSession(method: string | undefined): Promise<void> {
    if (!this.httpStored || !this.httpSession) return;
    if (isMcpActivity(method)) this.httpStored.lastActivityAt = Date.now();
    this.httpStored.operatorState = this.httpSession.getState();
    await this.ctx.storage.put(MCP_HTTP_STORAGE_KEY, this.httpStored);
  }

  private async authorize(): Promise<void> {
    if (!this.actor || !this.kid) throw new Error("MCP session not found");
    const fleet = this.env.FLEET.get(this.env.FLEET.idFromName("fleet"));
    const response = await fleet.fetch(
      new Request("https://fleet/validate-mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: this.actor.id, kid: this.kid }),
      }),
    );
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new HubRpcError(response.status, body);
  }

  private async rpc(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.actor) throw new Error("MCP session not found");
    const fleet = this.env.FLEET.get(this.env.FLEET.idFromName("fleet"));
    const request = new Request(`https://mcp.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [FLEET_OPERATOR_HEADER]: this.fingerprint,
      },
      body: JSON.stringify(body),
    });
    const response =
      (await handleAuthorizedOperatorRequest(request, this.env, fleet, this.actor)) ??
      json({ error: "not found" }, 404);
    const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new HubRpcError(response.status, value);
    return wrapTransportRpc(value, isDeviceTransportPath(path) ? "ws" : null);
  }
}

export class DeviceDO implements DurableObject {
  ctx: DurableObjectState;
  env: Env;
  private beatSeq = 0;
  private beatWaiters: Array<() => void> = [];
  private desktopWaiters = new Map<
    string,
    {
      resolve: (body: Record<string, unknown> | undefined) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private rtcDesktopResults = new Map<
    string,
    { body: Record<string, unknown>; expiresAt: number }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/kick" && request.method === "POST") {
      const revocation = (await request.json().catch(() => ({}))) as Partial<RevocationNotice>;
      for (const ws of this.ctx.getWebSockets()) {
        if (revocation.kid && revocation.statement?.payload && revocation.statement.sig) {
          ws.send(
            JSON.stringify(
              envelope("auth_revoked", {
                kid: revocation.kid,
                statement: revocation.statement,
              }),
            ),
          );
        }
        ws.close(1008, "token reset");
      }
      return json({ ok: true });
    }

    if (url.pathname === "/plugin-peer-session-push" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const ws = sockets[0]!;
      const att = (ws.deserializeAttachment() ?? {}) as WsAttachment;
      if (!normalizeCaps(att.caps).includes(PEER_SESSION_PROTOCOL)) {
        return json({ error: "unsupported", code: "UNSUPPORTED_CAP" }, 409);
      }
      const push = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const type = String(push.type ?? "");
      const body = push.body;
      if (
        ![
          "peer_session_prepare",
          "peer_session_round_prepare",
          "peer_session_signal",
          "peer_session_ticket",
          "peer_session_update",
        ].includes(type)
      ) {
        return json({ error: "invalid peer session push" }, 400);
      }
      if (
        String(push.user_id ?? "") !== att.userId ||
        String(push.kid ?? "") !== att.kid ||
        String(push.device_id ?? "") !== att.deviceId ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return json({ error: "peer session owner changed" }, 401);
      }
      const deliveryId = String(push.delivery_id ?? "");
      if (!/^ps:[a-zA-Z0-9:._@-]{1,384}$/.test(deliveryId)) {
        return json({ error: "invalid peer session delivery" }, 400);
      }
      const encoded = JSON.stringify({
        delivery_id: deliveryId,
        ...(body as Record<string, unknown>),
      });
      if (new TextEncoder().encode(encoded).byteLength > RTC_SDP_MAX_BYTES + 8192) {
        return json({ error: "peer session control frame too large" }, 413);
      }
      const deliveryState = await this.ctx.storage.transaction(async (txn) => {
        const key = "peer-delivery-ids";
        const now = Date.now();
        const current = ((await txn.get<PeerDeliveryState[]>(key)) ?? []).filter(
          (item) => item.at + PEER_SESSION_TTL_MS > now,
        );
        const known = current.find((item) => item.id === deliveryId);
        if (known?.state === "acked") return "acked" as const;
        if (known) return "pending" as const;
        if (current.length >= 4096) return "full" as const;
        await txn.put(key, [...current, { id: deliveryId, at: now, state: "pending" }]);
        return "fresh" as const;
      });
      if (deliveryState === "acked") return json({ ok: true, acknowledged: true });
      if (deliveryState === "full")
        return json({ error: "peer delivery dedupe backpressure" }, 409);
      ws.send(JSON.stringify(envelope(type, JSON.parse(encoded) as Record<string, unknown>)));
      return json({ ok: true, replay: deliveryState === "pending" });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const id = deviceIdFrom(request) ?? "unknown";
      const userId = request.headers.get("x-fleet-user") ?? undefined;
      const kid = request.headers.get("x-fleet-kid") ?? undefined;
      if (!userId || !kid) {
        return json({ error: "device WebSocket requires a per-account Hub token" }, 401);
      }
      const validated = await this.fleet().fetch(
        new Request("https://fleet/validate-mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: userId, kid }),
        }),
      );
      if (!validated.ok) return json({ error: "Hub token was reset or revoked" }, 401);
      const claimed = await this.mark(id, {
        name: request.headers.get("x-device-name") ?? id,
        os: request.headers.get("x-device-os") ?? "linux",
        online: true,
        userId,
      });
      if (!claimed) return json({ error: "taken" }, 409);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      for (const extra of this.ctx.getWebSockets()) {
        if (extra !== pair[1]) extra.close(1012, "replaced");
      }
      pair[1].serializeAttachment({
        deviceId: id,
        name: request.headers.get("x-device-name") ?? id,
        os: request.headers.get("x-device-os") ?? "linux",
        userId,
        kid,
      });
      pair[1].send(
        JSON.stringify(envelope("hello_ok", { heartbeat_s: 3600, ...updateAdvert(this.env) })),
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/rtc-offer" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const ws = sockets[0]!;
      const att = (ws.deserializeAttachment() ?? {}) as WsAttachment;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const sid = String(body.sid ?? "");
      const offer = String(body.offer ?? "");
      const userId = String(body.user_id ?? "");
      const kid = String(body.kid ?? "");
      const operatorId = String(body.operator_id ?? "");
      if (!validRtcSid(sid) || !validRtcSdp(offer) || !userId || !kid || !operatorId) {
        return json({ error: "invalid RTC offer" }, 400);
      }
      if (att.userId !== userId || att.kid !== kid)
        return json({ error: "token session changed" }, 401);
      if (!normalizeCaps(att.caps).includes("rtc_v1")) {
        return json({ error: "unsupported", code: "UNSUPPORTED_CAP", missing: "rtc_v1" }, 409);
      }
      const now = Date.now();
      const row: RtcSignalRow = {
        sid,
        userId,
        kid,
        deviceId: String(body.device_id ?? att.deviceId ?? ""),
        operatorId,
        offer,
        createdAt: now,
        exp: now + RTC_SIGNAL_TTL_MS,
      };
      await this.ctx.storage.put(`rtc:${sid}`, row);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm == null || row.exp < alarm) await this.ctx.storage.setAlarm(row.exp);
      ws.send(
        JSON.stringify(
          envelope("rtc_offer", {
            sid,
            offer,
            operator_id: operatorId,
            stun_urls: Array.isArray(body.stun_urls) ? body.stun_urls : [],
          }),
        ),
      );
      return json({ sid, status: "offered" });
    }

    if (url.pathname === "/rtc-session" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const sid = String(body.sid ?? "");
      const row = validRtcSid(sid) ? await this.ctx.storage.get<RtcSignalRow>(`rtc:${sid}`) : null;
      if (!row || row.exp < Date.now()) return json({ error: "RTC session not found" }, 404);
      if (!sameRtcOwner(row, body)) return json({ error: "RTC session not found" }, 404);
      if (!row.answer || !row.ticket) return json({ sid, status: "waiting" });
      return json({
        sid,
        status: "ready",
        answer: row.answer,
        statement: row.ticket,
        exp: row.exp,
      });
    }

    if (url.pathname === "/rtc-cancel" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const sid = String(body.sid ?? "");
      const row = validRtcSid(sid) ? await this.ctx.storage.get<RtcSignalRow>(`rtc:${sid}`) : null;
      if (!row || !sameRtcOwner(row, body)) return json({ ok: true });
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(JSON.stringify(envelope("rtc_cancel", { sid })));
      }
      await this.ctx.storage.delete(`rtc:${sid}`);
      return json({ ok: true });
    }

    if (url.pathname === "/rtc-result") {
      const corr = url.searchParams.get("corr") ?? "";
      const type = url.searchParams.get("type") ?? "";
      const fp = deviceFingerprint(request);
      const resolved = await this.resolveSession(fp, corr);
      if (resolved.drop || !resolved.corr || type !== "desktop") return json({ status: "pending" });
      const body = this.takeRtcDesktopResult(resolved.corr);
      return json(body ? { status: "done", body } : { status: "pending" });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as {
        command: string;
        wait_ms?: number;
        fingerprint?: string;
      };
      const fp = deviceFingerprint(request, body.fingerprint);
      const corr = crypto.randomUUID();
      await this.claimSession(fp, corr);
      sockets[0]!.send(
        JSON.stringify(
          envelope("run", withFingerprint({ command: body.command, mode: "pane" }, fp), corr),
        ),
      );
      const waitMs = clampHubWaitMs(body.wait_ms);
      if (waitMs <= 0) return json({ corr, status: "running" });
      const row = await waitDeviceResult(
        () => this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`),
        waitMs,
      );
      return json(hubResultPayload(corr, row));
    }

    if (url.pathname === "/plugin" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as Record<string, unknown>;
      const fp = deviceFingerprint(request);
      const corr = crypto.randomUUID();
      await this.claimSession(fp, corr);
      await this.ctx.storage.put(`res:${corr}`, { status: "pending" });
      sockets[0]!.send(JSON.stringify(envelope("plugin", body, corr)));
      return json({ corr, status: "pending" });
    }

    if (url.pathname === "/plugin-result") {
      const corr = url.searchParams.get("corr") ?? "";
      const fp = deviceFingerprint(request);
      const resolved = await this.resolveSession(fp, corr);
      if (resolved.drop || !resolved.corr) return json({ corr, status: "pending" });
      const row = await this.ctx.storage.get<Record<string, unknown>>(`res:${resolved.corr}`);
      return json(
        row ? { corr: resolved.corr, ...row } : { corr: resolved.corr, status: "pending" },
      );
    }

    if (url.pathname === "/type" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json()) as {
        keys?: string;
        key?: string;
        corr?: string;
        fingerprint?: string;
      };
      const fp = deviceFingerprint(request, body.fingerprint);
      const resolved = await this.resolveSession(fp, body.corr);
      if (resolved.drop) return json({ ok: true, status: "typed" });
      sockets[0]!.send(
        JSON.stringify(
          envelope(
            "type",
            withFingerprint({ keys: body.keys, key: body.key, corr: resolved.corr }, fp),
          ),
        ),
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
        sockets[0]!.send(
          JSON.stringify(envelope("read_screen", withFingerprint({ corr }, fp), corr)),
        );
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
      const row =
        waitMs > 0
          ? await waitDeviceResult(
              () => this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`),
              waitMs,
            )
          : await this.ctx.storage.get<Record<string, unknown>>(`res:${corr}`);
      return json(hubResultPayload(corr, row));
    }

    if (url.pathname === "/desktop" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const ws = sockets[0]!;
      const att = (ws.deserializeAttachment() ?? {}) as WsAttachment;
      if (!Array.isArray(att.caps)) {
        return json({ error: "not ready", code: "NOT_READY" }, 409);
      }
      if (!hasComputerUse({ caps: att.caps })) {
        return json(unsupportedCapBody({ agentVer: att.agentVer ?? "", os: att.os ?? "" }), 409);
      }
      const plan = (await request.json()) as { type?: string; body?: Record<string, unknown> };
      const type = plan.type === "desktop_action" ? "desktop_action" : "desktop_screenshot";
      const corr = crypto.randomUUID();
      const pending = this.waitDesktop(corr, DESKTOP_WAIT_MS);
      ws.send(JSON.stringify(envelope(type, plan.body ?? {}, corr)));
      const got = await pending;
      if (!got) return json({ error: "timeout", code: "TIMEOUT" }, 409);
      return json(got);
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return json({ error: "offline" }, 409);
      const body = (await request.json().catch(() => ({}))) as {
        device_id?: string;
        wait_ms?: number;
      };
      const att = (sockets[0]!.deserializeAttachment() ?? {}) as { deviceId?: string };
      const id = body.device_id || att.deviceId || "unknown";
      const waitMs = clampHeartbeatWaitMs(body.wait_ms);
      const pending = this.waitNextBeat(waitMs);
      sockets[0]!.send(JSON.stringify(envelope("ask_heartbeat", updateAdvert(this.env))));
      const got = await pending;
      if (!got) return json({ error: "no heartbeat" }, 409);
      const res = await this.fleet().fetch(
        new Request(`https://fleet/device?id=${encodeURIComponent(id)}`),
      );
      const row = computerPublic(await res.json());
      if (!row) return json({ error: "not found" }, 404);
      return json(row);
    }

    return json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message.length > DEVICE_WS_TEXT_MAX_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    const messageBytes = new TextEncoder().encode(message).byteLength;
    if (messageBytes > DEVICE_WS_TEXT_MAX_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      return;
    }
    if (!isDeviceEnvelope(value)) {
      ws.close(1003, "bad proto");
      return;
    }
    const parsed = value;
    if (
      (parsed.type === "peer_session_ack" ||
        parsed.type === "peer_session_authorized" ||
        parsed.type === "peer_session_signal" ||
        parsed.type === "peer_session_event") &&
      messageBytes > PEER_SESSION_CONTROL_MAX_BYTES
    ) {
      ws.close(1009, "peer control frame too large");
      return;
    }
    const att = (ws.deserializeAttachment() ?? {}) as WsAttachment;

    if (parsed.type === "hello") {
      const os = String(parsed.body.os ?? att.os ?? "linux");
      const name = String(parsed.body.hostname ?? att.name ?? att.deviceId ?? "device");
      if (Array.isArray(parsed.body.caps)) att.caps = normalizeCaps(parsed.body.caps);
      else if (!Array.isArray(att.caps)) att.caps = [];
      const permit = normalizePermit(parsed.body.permit);
      if (permit) att.permit = permit;
      const agentVer = String(parsed.body.agent_ver ?? att.agentVer ?? "");
      att.agentVer = agentVer;
      const arch = archFromBody(parsed.body);
      ws.serializeAttachment({
        deviceId: att.deviceId,
        name,
        os,
        userId: att.userId,
        kid: att.kid,
        caps: att.caps,
        permit: att.permit,
        agentVer,
      });
      await this.mark(att.deviceId ?? "unknown", {
        name,
        os,
        online: true,
        agentVer,
        userId: att.userId,
        ...(Array.isArray(parsed.body.caps) ? { caps: normalizeCaps(parsed.body.caps) } : {}),
        ...(permit ? { permit } : {}),
        ...(arch !== undefined ? { arch } : {}),
      });
      return;
    }

    if (parsed.type === "desktop") {
      const corr = parsed.corr ?? "";
      const body = parsed.body ?? {};
      if (!this.noteDesktop(corr, body)) this.rememberRtcDesktopResult(corr, body);
      return;
    }

    if (parsed.type === "peer_session_ack") {
      await this.handlePeerSessionAck(att, parsed);
      return;
    }

    if (
      parsed.type === "peer_session_authorized" ||
      parsed.type === "peer_session_signal" ||
      parsed.type === "peer_session_event"
    ) {
      await this.handlePeerSessionMessage(ws, att, parsed);
      return;
    }

    if (parsed.type === "rtc_claim" && parsed.corr) {
      const operatorId = String(parsed.body?.operator_id ?? "").trim();
      const sid = String(parsed.body?.sid ?? "").trim();
      if (validRtcSid(sid) && validRtcOperatorId(operatorId) && validRtcCorr(parsed.corr)) {
        await this.claimSession(operatorId, parsed.corr);
      }
      return;
    }

    if (parsed.type === "rtc_answer") {
      const sid = String(parsed.body?.sid ?? "");
      const answer = String(parsed.body?.answer ?? "");
      const row = validRtcSid(sid) ? await this.ctx.storage.get<RtcSignalRow>(`rtc:${sid}`) : null;
      if (!row || row.exp < Date.now() || !validRtcSdp(answer)) return;
      if (row.userId !== att.userId || row.kid !== att.kid || row.deviceId !== att.deviceId) return;
      const offerFp = rtcFingerprint(row.offer);
      const answerFp = rtcFingerprint(answer);
      if (!offerFp || !answerFp) return;
      const signed = await this.fleet().fetch(
        new Request("https://fleet/rtc-ticket", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sid,
            user_id: row.userId,
            kid: row.kid,
            device_id: row.deviceId,
            operator_id: row.operatorId,
            offer_fp: offerFp,
            answer_fp: answerFp,
            exp: row.exp,
          }),
        }),
      );
      if (!signed.ok) return;
      const value = (await signed.json()) as { statement?: SignedFleetStatement };
      if (!value.statement) return;
      row.answer = answer;
      row.ticket = value.statement;
      await this.ctx.storage.put(`rtc:${sid}`, row);
      ws.send(JSON.stringify(envelope("rtc_ticket", { sid, statement: row.ticket })));
      return;
    }

    if (parsed.type === "rtc_closed") {
      const sid = String(parsed.body?.sid ?? "");
      if (validRtcSid(sid)) await this.ctx.storage.delete(`rtc:${sid}`);
      return;
    }

    if (parsed.type === "ping" || parsed.type === "heartbeat") {
      const body = parsed.body ?? {};
      const agentVer = agentVerFromBody(body);
      const arch = archFromBody(body);
      if (Array.isArray(body.caps)) att.caps = normalizeCaps(body.caps);
      const permit = normalizePermit(body.permit);
      if (permit) att.permit = permit;
      if (agentVer !== undefined) att.agentVer = agentVer;
      ws.serializeAttachment({
        deviceId: att.deviceId,
        name: att.name ?? att.deviceId ?? "device",
        os: att.os ?? "linux",
        userId: att.userId,
        kid: att.kid,
        caps: att.caps,
        permit: att.permit,
        agentVer: att.agentVer,
      });
      await this.mark(att.deviceId ?? "unknown", {
        name: att.name ?? att.deviceId ?? "device",
        os: att.os ?? "linux",
        online: true,
        userId: att.userId,
        ...(agentVer !== undefined ? { agentVer } : {}),
        ...(Array.isArray(body.caps) ? { caps: normalizeCaps(body.caps) } : {}),
        ...(permit ? { permit } : {}),
        ...(arch !== undefined ? { arch } : {}),
      });
      this.noteBeat();
      ws.send(JSON.stringify(envelope("pong", updateAdvert(this.env), parsed.id)));
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

    if (parsed.type === "plugin_accepted" && parsed.corr) {
      await this.ctx.storage.put(`res:${parsed.corr}`, { status: parsed.body.status ?? "running" });
      return;
    }

    if (parsed.type === "plugin_result" && parsed.corr) {
      await this.ctx.storage.put(`res:${parsed.corr}`, {
        status: "done",
        ok: parsed.body.ok ?? false,
        result: parsed.body.result,
        error: parsed.body.error ?? "",
        t: parsed.t,
      });
      await this.finishSession(parsed.corr);
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

  async alarm() {
    const now = Date.now();
    const sessions = await this.ctx.storage.list<RtcSignalRow>({ prefix: "rtc:" });
    let next = 0;
    for (const [key, row] of sessions) {
      if (!row || row.exp <= now) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (next === 0 || row.exp < next) next = row.exp;
    }
    if (next > 0) await this.ctx.storage.setAlarm(next);
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

  private async handlePeerSessionMessage(ws: WebSocket, att: WsAttachment, parsed: Envelope) {
    const sessionId = String(parsed.body?.session_id ?? "");
    if (
      !validPeerSessionId(sessionId) ||
      !att.userId ||
      !att.kid ||
      !att.deviceId ||
      !normalizeCaps(att.caps).includes(PEER_SESSION_PROTOCOL)
    ) {
      ws.send(
        JSON.stringify(
          envelope("peer_session_update", {
            session_id: sessionId,
            ok: false,
            status: 400,
            error: "invalid peer session request",
          }),
        ),
      );
      return;
    }
    const action =
      parsed.type === "peer_session_authorized"
        ? "authorize"
        : parsed.type === "peer_session_signal"
          ? "signal"
          : "event";
    const reservation = await reservePeerSession(
      this.fleet(),
      att.userId,
      sessionId,
    );
    if (!reservation.ok) {
      const value = (await reservation.json().catch(() => ({}))) as Record<string, unknown>;
      ws.send(
        JSON.stringify(
          envelope("peer_session_update", {
            session_id: sessionId,
            ok: false,
            status: reservation.status,
            error: String(value.error ?? "peer session reservation failed"),
            ...value,
          }),
        ),
      );
      return;
    }
    const { session_id: _sessionId, ...payload } = parsed.body;
    const response = await this.env.PEER_SESSION.get(
      this.env.PEER_SESSION.idFromName(sessionId),
    ).fetch(
      new Request(`https://peer-session/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-user": att.userId,
          "x-fleet-kid": att.kid,
          "x-peer-caller-kind": "device",
          "x-peer-caller-id": att.deviceId,
        },
        body: JSON.stringify(payload),
      }),
    );
    const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const session =
      value.session && typeof value.session === "object"
        ? (value.session as Record<string, unknown>)
        : null;
    ws.send(
      JSON.stringify(
        envelope("peer_session_update", {
          session_id: sessionId,
          ok: response.ok,
          status: response.status,
          ...(typeof session?.phase === "string" ? { phase: session.phase } : {}),
          ...value,
        }),
      ),
    );
  }

  private async handlePeerSessionAck(att: WsAttachment, parsed: Envelope) {
    const sessionId = String(parsed.body?.session_id ?? "");
    const deliveryId = String(parsed.body?.delivery_id ?? "");
    if (
      !validPeerSessionId(sessionId) ||
      !/^ps:[a-zA-Z0-9:._@-]{1,384}$/.test(deliveryId) ||
      !att.userId ||
      !att.kid ||
      !att.deviceId ||
      !normalizeCaps(att.caps).includes(PEER_SESSION_PROTOCOL)
    ) {
      return;
    }
    const reservation = await reservePeerSession(
      this.fleet(),
      att.userId,
      sessionId,
    );
    if (!reservation.ok) return;
    const response = await this.env.PEER_SESSION.get(
      this.env.PEER_SESSION.idFromName(sessionId),
    ).fetch(
      new Request("https://peer-session/delivery/ack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-user": att.userId,
          "x-fleet-kid": att.kid,
          "x-peer-caller-kind": "device",
          "x-peer-caller-id": att.deviceId,
        },
        body: JSON.stringify({ delivery_id: deliveryId }),
      }),
    );
    if (!response.ok) return;
    await this.ctx.storage.transaction(async (txn) => {
      const key = "peer-delivery-ids";
      const now = Date.now();
      const current = ((await txn.get<PeerDeliveryState[]>(key)) ?? []).filter(
        (item) => item.at + PEER_SESSION_TTL_MS > now,
      );
      const known = current.find((item) => item.id === deliveryId);
      if (known) {
        known.state = "acked";
        known.at = now;
        await txn.put(key, current);
      }
    });
  }

  private noteBeat() {
    this.beatSeq += 1;
    const waiters = this.beatWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitDesktop(corr: string, waitMs: number): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.desktopWaiters.delete(corr);
        resolve(undefined);
      }, waitMs);
      this.desktopWaiters.set(corr, { resolve, timer });
    });
  }

  private noteDesktop(corr: string, body: Record<string, unknown>): boolean {
    if (!corr) return false;
    const waiter = this.desktopWaiters.get(corr);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.desktopWaiters.delete(corr);
    waiter.resolve(body);
    return true;
  }

  private rememberRtcDesktopResult(corr: string, body: Record<string, unknown>) {
    if (!validRtcCorr(corr)) return;
    const now = Date.now();
    for (const [key, row] of this.rtcDesktopResults) {
      if (row.expiresAt <= now) this.rtcDesktopResults.delete(key);
    }
    while (this.rtcDesktopResults.size >= 32) {
      const oldest = this.rtcDesktopResults.keys().next().value;
      if (typeof oldest !== "string") break;
      this.rtcDesktopResults.delete(oldest);
    }
    this.rtcDesktopResults.set(corr, { body, expiresAt: now + 15_000 });
  }

  private takeRtcDesktopResult(corr: string): Record<string, unknown> | undefined {
    const row = this.rtcDesktopResults.get(corr);
    this.rtcDesktopResults.delete(corr);
    if (!row || row.expiresAt <= Date.now()) return undefined;
    return row.body;
  }

  private waitNextBeat(waitMs: number): Promise<boolean> {
    const start = this.beatSeq;
    return new Promise((resolve) => {
      const onBeat = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.beatWaiters = this.beatWaiters.filter((w) => w !== onBeat);
        resolve(this.beatSeq > start);
      }, waitMs);
      this.beatWaiters.push(onBeat);
    });
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
    extra: {
      name: string;
      os: string;
      online: boolean;
      agentVer?: string;
      arch?: string;
      userId?: string;
      caps?: string[];
      permit?: "off" | "ask" | "allow";
    },
  ): Promise<boolean> {
    const row: DeviceRow = {
      id,
      name: extra.name,
      os: extra.os,
      online: extra.online,
      lastSeen: Date.now(),
      agentVer: extra.agentVer,
      arch: extra.arch,
      userId: extra.userId,
    };
    if (Array.isArray(extra.caps)) row.caps = extra.caps;
    if (extra.permit) row.permit = extra.permit;
    const res = await this.fleet().fetch(
      new Request("https://fleet/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      }),
    );
    return res.ok;
  }
}

function desktopPlan(
  path: string,
  body: Record<string, unknown>,
): { type: string; body: Record<string, unknown> } {
  if (path.endsWith("desktop_screenshot") || body.action === "screenshot") {
    return {
      type: "desktop_screenshot",
      body: { max_width: body.max_width, max_height: body.max_height },
    };
  }
  return {
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
}

async function resolveSession(request: Request, fleet: DurableObjectStub): Promise<Actor | null> {
  const res = await fleet.fetch(new Request("https://fleet/resolve", { headers: request.headers }));
  const sess = (await res.json()) as Actor;
  return sess.id ? sess : null;
}

async function putOpsBanned(fleet: DurableObjectStub, id: string, banned: boolean) {
  const res = await fleet.fetch(
    new Request("https://fleet/ops-banned", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, banned }),
    }),
  );
  if (!res.ok) return null;
  return (await res.json()) as { id: string; banned: boolean };
}

async function dispatchOps(
  request: Request,
  env: Env,
  fleet: DurableObjectStub,
  path: string,
): Promise<Response> {
  const sess = await resolveSession(request, fleet);
  let catalog: { users?: unknown[]; devices?: unknown[] } = {};
  if (path !== "/ops") {
    const res = await fleet.fetch(new Request("https://fleet/ops-catalog"));
    catalog = (await res.json()) as { users?: unknown[]; devices?: unknown[] };
  }
  return handleOpsRoute({
    path,
    method: request.method,
    actor: sess,
    adminEmails: env.ADMIN_EMAILS,
    users: catalog.users,
    devices: catalog.devices,
    body:
      path === "/v1/ops/banned"
        ? ((await request.json().catch(() => ({}))) as { id?: string; banned?: boolean })
        : undefined,
    setBanned: (id, banned) => putOpsBanned(fleet, id, banned),
  });
}

async function dispatchMcpSse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (request.method === "GET") {
    const actor = await resolveMcpBearer(request, env);
    if (actor instanceof Response) return actor;
    const sessionId = crypto.randomUUID();
    const stub = env.MCP.get(env.MCP.idFromName(sessionId));
    return stub.fetch(
      new Request(`https://mcp/open?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: {
          "x-fleet-actor": actor.id,
          "x-fleet-kid": actor.kid,
        },
      }),
    );
  }

  if (request.method === "POST") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!validMcpSessionId(sessionId)) {
      return json({ error: "MCP session not found" }, 404);
    }
    const stub = env.MCP.get(env.MCP.idFromName(sessionId));
    return stub.fetch(
      new Request("https://mcp/message", {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") || "application/json" },
        body: request.body,
      }),
    );
  }

  return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
}

async function dispatchMcpHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const sessionId = request.headers.get("mcp-session-id")?.trim() ?? "";
  if (request.method === "DELETE") {
    if (!validMcpSessionId(sessionId)) return json({ error: "MCP session not found" }, 404);
    const stub = env.MCP.get(env.MCP.idFromName(sessionId));
    return stub.fetch(new Request("https://mcp/http-close", { method: "DELETE" }));
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE", ...CORS } });
  }

  const message = (await request.json().catch(() => null)) as JsonRpcMessage | null;
  if (!isJsonRpcMessage(message))
    return jsonRpcError(null, -32700, "invalid JSON-RPC message", 400);

  if (!sessionId) {
    if (!isInitializeMessage(message) || message.id === undefined) {
      return jsonRpcError(message.id ?? null, -32600, "initialize request required", 400);
    }
    const actor = await resolveMcpBearer(request, env);
    if (actor instanceof Response) return actor;
    const nextSessionId = crypto.randomUUID();
    const stub = env.MCP.get(env.MCP.idFromName(nextSessionId));
    const response = await stub.fetch(
      new Request("https://mcp/http-open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-actor": actor.id,
          "x-fleet-kid": actor.kid,
        },
        body: JSON.stringify(message),
      }),
    );
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("Mcp-Session-Id", nextSessionId);
    for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  }

  if (!validMcpSessionId(sessionId)) return json({ error: "MCP session not found" }, 404);
  const stub = env.MCP.get(env.MCP.idFromName(sessionId));
  return stub.fetch(
    new Request("https://mcp/http-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    }),
  );
}

async function resolveMcpBearer(
  request: Request,
  env: Env,
): Promise<(Actor & { kid: string }) | Response> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return json({ error: "Authorization: Bearer <Hub token> required" }, 401);
  const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));
  const resolved = await fleet.fetch(
    new Request("https://fleet/resolve-bearer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  const actor = (await resolved.json().catch(() => ({}))) as Actor & {
    kid?: string;
    error?: string;
  };
  if (!resolved.ok || !actor.id || !actor.kid) {
    return json({ error: actor.error || "unauthorized" }, resolved.status || 401);
  }
  return { ...actor, kid: actor.kid };
}

function validMcpSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function configuredOrigin(env: Env): string {
  return hubOrigin(env.HUB_ORIGIN || "https://fleet.ginfo.cc") || "https://fleet.ginfo.cc";
}

function highSecJson(error: string, status = 401) {
  return json({ error, code: "HIGH_SEC" }, status);
}

function deny(resolved: Resolved, rejectSuper = false) {
  if (resolved.actor && rejectSuper) return json({ error: "unauthorized" }, 401);
  if ("error" in resolved && resolved.error) {
    return json(
      resolved.code ? { error: resolved.error, code: resolved.code } : { error: resolved.error },
      resolved.status ?? 401,
    );
  }
  return json({ error: "unauthorized" }, 401);
}

function fleetChallenge(fleet: DurableObjectStub, kid: string, aud: string) {
  const q = new URLSearchParams({ kid, aud });
  return fleet.fetch(new Request(`https://fleet/challenge?${q}`));
}

async function resolveActor(
  request: Request,
  env: Env,
  fleet: DurableObjectStub,
): Promise<Resolved> {
  const need = env.HUB_TOKEN?.trim();
  const auth = parseAuthorization(request.headers.get("authorization"));
  if (need && auth.kind === "bearer" && auth.token === need)
    return { actor: { id: "*", super: true } };

  if (auth.kind === "oaep") {
    const wrapRes = await fleet.fetch(
      new Request("https://fleet/resolve-wrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kid: auth.kid, wrap: auth.wrap }),
      }),
    );
    const data = (await wrapRes.json()) as Actor & { error?: string; code?: string };
    if (data.error === "banned") return { error: "banned", status: 403 };
    if (wrapRes.ok && data.id) return { actor: { id: data.id, email: data.email, kid: data.kid } };
    return {
      error: data.error || HIGH_SEC_KEY_MISMATCH,
      status: wrapRes.status || 401,
      code: data.code || "HIGH_SEC",
    };
  }
  if (auth.kind === "bearer" && isLegacyFlt(auth.token)) {
    return { error: HIGH_SEC_UPGRADE, status: 401, code: "HIGH_SEC" };
  }
  if (auth.kind === "bearer" && auth.token.startsWith("flt_1.")) {
    return { error: HIGH_SEC_UPGRADE, status: 401, code: "HIGH_SEC" };
  }
  if (cookie(request, "fleet_session")) {
    const sess = await resolveSession(request, fleet);
    if (sess) {
      if (sess.banned) return { error: "banned", status: 403 };
      return { actor: sess };
    }
  }
  return { error: "unauthorized", status: 401 };
}

async function owns(fleet: DurableObjectStub, actor: Actor, deviceId: string): Promise<boolean> {
  if (actor.super) return true;
  const res = await fleet.fetch(
    new Request(`https://fleet/device?id=${encodeURIComponent(deviceId)}`),
  );
  const row = (await res.json()) as DeviceRow;
  return Boolean(row.id && row.userId === actor.id);
}

function reservePeerSession(
  fleet: DurableObjectStub,
  userId: string,
  sessionId: string,
): Promise<Response> {
  return fleet.fetch(
    new Request("https://fleet/peer-session-reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: sessionId }),
    }),
  );
}

type PeerProtocolSnapshot = {
  id: string;
  abi: "fleet.plugin.peer.v1";
  transport: "direct_ordered";
  approval: "both_once";
};

function peerEndpointSpec(
  value: unknown,
  protocolId: string,
  side: "source" | "target",
): { endpoint: Record<string, unknown>; protocol: PeerProtocolSnapshot } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const endpoint = value as Record<string, unknown>;
  const allowed = new Set(["kind", "id", "plugin_id", "plugin_version", "action", "role", "input"]);
  if (Object.keys(endpoint).some((key) => !allowed.has(key))) return null;
  const kind = String(endpoint.kind ?? "");
  const id = String(endpoint.id ?? "");
  if ((kind !== "tool" && kind !== "device") || !/^[a-zA-Z0-9._:@-]{1,128}$/.test(id)) {
    return null;
  }
  const pluginId = String(endpoint.plugin_id ?? "").trim();
  const pluginVersion = String(endpoint.plugin_version ?? "").trim();
  const action = String(endpoint.action ?? "").trim();
  const role = String(endpoint.role ?? "").trim();
  if (role !== side) return null;
  const plugin = officialPlugin(pluginId) as
    | (NonNullable<ReturnType<typeof officialPlugin>> & {
        runtime?: unknown;
        action_specs?: unknown;
        peer_protocols?: unknown;
      })
    | null;
  if (!plugin || plugin.version !== pluginVersion || plugin.runtime !== "peer") return null;
  const actionSpecs = plugin.action_specs;
  if (!actionSpecs || typeof actionSpecs !== "object" || Array.isArray(actionSpecs)) return null;
  const actionSpec = (actionSpecs as Record<string, unknown>)[action];
  if (!actionSpec || typeof actionSpec !== "object" || Array.isArray(actionSpec)) return null;
  const actionRow = actionSpec as Record<string, unknown>;
  if (actionRow.runtime !== "peer" || actionRow.role !== role) return null;
  if (!Array.isArray(plugin.peer_protocols)) return null;
  const peerProtocol = (plugin.peer_protocols as unknown[]).find((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    const roles = row.roles;
    return (
      row.id === protocolId &&
      row.abi === "fleet.plugin.peer.v1" &&
      row.transport === "direct_ordered" &&
      row.approval === "both_once" &&
      roles !== null &&
      typeof roles === "object" &&
      !Array.isArray(roles) &&
      (roles as Record<string, unknown>)[role] === action
    );
  }) as Record<string, unknown> | undefined;
  if (!peerProtocol) return null;
  return {
    endpoint: {
      kind,
      id,
      plugin_id: pluginId,
      plugin_version: pluginVersion,
      action,
      role,
      input: endpoint.input ?? null,
    },
    protocol: {
      id: protocolId,
      abi: "fleet.plugin.peer.v1",
      transport: "direct_ordered",
      approval: "both_once",
    },
  };
}

export function isTaskPluginAction(
  plugin: {
    runtime?: unknown;
    actions?: unknown;
    action_specs?: unknown;
  },
  action: string,
): boolean {
  if (!action || !Array.isArray(plugin.actions) || !plugin.actions.includes(action)) return false;
  const specs = plugin.action_specs;
  const spec =
    specs && typeof specs === "object" && !Array.isArray(specs)
      ? (specs as Record<string, unknown>)[action]
      : undefined;
  if (spec !== undefined) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
    return (spec as Record<string, unknown>).runtime === "task";
  }
  return plugin.runtime === undefined || plugin.runtime === "task";
}

function samePeerProtocol(left: PeerProtocolSnapshot, right: PeerProtocolSnapshot): boolean {
  return (
    left.id === right.id &&
    left.abi === right.abi &&
    left.transport === right.transport &&
    left.approval === right.approval
  );
}

function validPeerSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function withCookies(res: Response, setCookie?: string): Response {
  const headers = new Headers(res.headers);
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
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

async function pbkdf2(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deviceIdFrom(request: Request): string | null {
  const header = request.headers.get("x-device-id")?.trim();
  if (header) return header;
  const q = new URL(request.url).searchParams.get("id")?.trim();
  return q || null;
}

function rtcStunURLs(env: Env): string[] {
  return String(env.RTC_STUN_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("stun:") && value.length <= 512)
    .slice(0, 4);
}

function validRtcSid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function validRtcSdp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= RTC_SDP_MAX_BYTES &&
    value.includes("v=0")
  );
}

function rtcFingerprint(sdp: string): string {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$/im);
  return match ? match[1]!.replaceAll(":", "").toLowerCase() : "";
}

function validRtcFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function validRtcOperatorId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !hasAsciiControl(value);
}

function validRtcCorr(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !hasAsciiControl(value);
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function sameRtcOwner(row: RtcSignalRow, body: Record<string, unknown>): boolean {
  return (
    row.userId === String(body.user_id ?? "") &&
    row.kid === String(body.kid ?? "") &&
    row.operatorId === String(body.operator_id ?? "")
  );
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

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}
