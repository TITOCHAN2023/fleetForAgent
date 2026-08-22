/**
 * Long-session ownership. Fingerprint is an MCP-process id from
 * X-Fleet-Operator — never a tool argument. Missing header = one
 * anonymous fingerprint so 0.2.7 clients keep working.
 */

export const FLEET_OPERATOR_HEADER = "X-Fleet-Operator";
export const ANON_FINGERPRINT = "";

export function normalizeFingerprint(value) {
  if (value == null) return ANON_FINGERPRINT;
  return String(value).trim();
}

export function fingerprintFromHeaders(headers) {
  if (!headers) return ANON_FINGERPRINT;
  const get =
    typeof headers.get === "function"
      ? (name) => headers.get(name)
      : (name) => {
          const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
          return Array.isArray(direct) ? direct[0] : direct;
        };
  return normalizeFingerprint(get(FLEET_OPERATOR_HEADER) ?? get("x-fleet-operator"));
}

/**
 * Decide which ticket a caller may see or drive.
 * owner === undefined means the ticket was never claimed (pre-upgrade / unknown):
 * treat as anonymous so old in-flight jobs still work for headerless clients.
 */
export function resolveTicket({ fingerprint, ticket, owner, live } = {}) {
  const fp = normalizeFingerprint(fingerprint);
  const corr = ticket == null ? "" : String(ticket).trim();
  if (corr) {
    const own = owner === undefined || owner === null ? ANON_FINGERPRINT : normalizeFingerprint(owner);
    if (own !== fp) return { drop: true, corr: "" };
    return { drop: false, corr };
  }
  const liveCorr = live == null ? "" : String(live).trim();
  return { drop: false, corr: liveCorr };
}

export function createSessionBook() {
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {Map<string, string>} */
  const live = new Map();
  /** @type {Map<string, Set<string>>} */
  const alive = new Map();

  function aliveSet(fp) {
    let set = alive.get(fp);
    if (!set) {
      set = new Set();
      alive.set(fp, set);
    }
    return set;
  }

  return {
    claim(fp, corr) {
      const f = normalizeFingerprint(fp);
      const c = String(corr || "").trim();
      if (!c) return;
      owner.set(c, f);
      live.set(f, c);
      aliveSet(f).add(c);
    },
    finish(corr) {
      const c = String(corr || "").trim();
      if (!owner.has(c)) return;
      aliveSet(owner.get(c)).delete(c);
    },
    ownerOf(corr) {
      const c = String(corr || "").trim();
      if (!c || !owner.has(c)) return undefined;
      return owner.get(c);
    },
    liveOf(fp) {
      return live.get(normalizeFingerprint(fp)) || "";
    },
    aliveOf(fp) {
      return [...(alive.get(normalizeFingerprint(fp)) ?? [])];
    },
    resolve(fp, ticket) {
      const f = normalizeFingerprint(fp);
      const corr = ticket == null ? "" : String(ticket).trim();
      return resolveTicket({
        fingerprint: f,
        ticket: corr,
        owner: corr ? this.ownerOf(corr) : undefined,
        live: live.get(f) || "",
      });
    },
  };
}
