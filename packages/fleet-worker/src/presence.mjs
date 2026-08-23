/** Catalog row fields and keep-stored `agent_ver` (missing/blank leaves the stored version). */

export const HEARTBEAT_WAIT_DEFAULT_MS = 3_000;
export const HEARTBEAT_WAIT_MAX_MS = 10_000;
export const DESKTOP_WAIT_MS = 8_000;
export const COMPUTER_USE_CAP = "computer_use";

/** Non-empty agent_ver from a ping/heartbeat body. Missing/blank → undefined (keep stored). */
export function agentVerFromBody(body) {
  if (!body || typeof body !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "agent_ver")) return undefined;
  if (body.agent_ver == null) return undefined;
  const s = String(body.agent_ver).trim();
  return s === "" ? undefined : s;
}

export function normalizeCaps(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function normalizePermit(raw) {
  const s = String(raw ?? "").trim();
  if (s === "off" || s === "ask" || s === "allow") return s;
  return null;
}

export function joinCaps(caps) {
  return normalizeCaps(caps).join(",");
}

export function hasComputerUse(row) {
  return normalizeCaps(row && row.caps).includes(COMPUTER_USE_CAP);
}

export function unsupportedCapBody(row) {
  return {
    error: "unsupported",
    code: "UNSUPPORTED_CAP",
    missing: COMPUTER_USE_CAP,
    agentVer: row && row.agentVer != null ? row.agentVer : "",
    os: row && row.os != null ? row.os : "",
  };
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
    caps: normalizeCaps(row.caps),
    permit: normalizePermit(row.permit),
  };
}

export function clampHeartbeatWaitMs(value) {
  if (value == null || value === "") return HEARTBEAT_WAIT_DEFAULT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return HEARTBEAT_WAIT_DEFAULT_MS;
  return Math.min(HEARTBEAT_WAIT_MAX_MS, n);
}
