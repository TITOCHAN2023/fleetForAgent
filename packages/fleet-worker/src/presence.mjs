/** Catalog row fields and keep-stored `agent_ver` (missing/blank leaves the stored version). */

export const DEFAULT_UPDATE_BASE =
  "https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download";

/** Same SHA-256 lines GitHub / the public download page ship as checksums*.txt. */
export function parseChecksums(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 2) continue;
    const sum = String(fields[0]).toLowerCase();
    if (sum.length !== 64 || /[^0-9a-f]/.test(sum)) continue;
    let name = String(fields[1]).replace(/^\*/, "");
    const slash = name.lastIndexOf("/");
    if (slash >= 0) name = name.slice(slash + 1);
    if (name) out[name] = sum;
  }
  return out;
}

export function checksumsURL(base, ver) {
  const root = String(base ?? "").replace(/\/+$/, "");
  const v = String(ver ?? "").trim().replace(/^[vV]/, "");
  if (!root || !v) return "";
  return `${root}/checksums-${v}.txt`;
}

/**
 * Additive hello_ok / pong / ask_heartbeat / health fields. Empty version → {}.
 * Enough for a client to fetch its OS/arch asset: version + channel URL +
 * checksums URL (and optional inline sums). No Durable Object change.
 */
export function advertisedUpdate({ latestAgentVer, updateBase, checksumsUrl, checksumsText } = {}) {
  const ver = String(latestAgentVer ?? "").trim();
  if (!ver) return {};
  const base = String(updateBase ?? "").trim() || DEFAULT_UPDATE_BASE;
  const out = { latest_agent_ver: ver, update_base: base };
  const sumsUrl = String(checksumsUrl ?? "").trim() || checksumsURL(base, ver);
  if (sumsUrl) out.update_checksums = sumsUrl;
  const sums = parseChecksums(checksumsText);
  if (Object.keys(sums).length) out.update_sums = sums;
  return out;
}


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

/** Non-empty arch (GOARCH) from hello / heartbeat. Missing/blank → undefined (keep stored). */
export function archFromBody(body) {
  if (!body || typeof body !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "arch")) return undefined;
  if (body.arch == null) return undefined;
  const s = String(body.arch).trim();
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
