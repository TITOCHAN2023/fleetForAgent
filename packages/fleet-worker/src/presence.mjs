/** Catalog row fields and keep-stored `agent_ver` (missing/blank leaves the stored version). */

export const HEARTBEAT_WAIT_DEFAULT_MS = 3_000;
export const HEARTBEAT_WAIT_MAX_MS = 10_000;

/** Non-empty agent_ver from a ping/heartbeat body. Missing/blank → undefined (keep stored). */
export function agentVerFromBody(body) {
  if (!body || typeof body !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "agent_ver")) return undefined;
  if (body.agent_ver == null) return undefined;
  const s = String(body.agent_ver).trim();
  return s === "" ? undefined : s;
}

/** Non-empty arch (GOARCH) from hello / heartbeat. Missing/blank → undefined (keep stored). */
export function archFromBody(body) {
  if (!body || typeof body !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "arch")) return undefined;
  if (body.arch == null) return undefined;
  const s = String(body.arch).trim();
  return s === "" ? undefined : s;
}

/** Same fields list_computers already returns. Strips userId and anything else. */
export function computerPublic(row) {
  if (!row || typeof row !== "object" || !row.id) return null;
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    online: Boolean(row.online),
    lastSeen: row.lastSeen,
    agentVer: row.agentVer,
  };
}

export function clampHeartbeatWaitMs(value) {
  if (value == null || value === "") return HEARTBEAT_WAIT_DEFAULT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return HEARTBEAT_WAIT_DEFAULT_MS;
  return Math.min(HEARTBEAT_WAIT_MAX_MS, n);
}
