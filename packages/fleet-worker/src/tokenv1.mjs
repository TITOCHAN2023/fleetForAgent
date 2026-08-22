/**
 * High-security hub token v1.
 *
 * Token the human pastes: flt_1.<payload>.<sig>
 * payload is JSON { v, aud, kid, pub, iat, sec } signed RSA-PSS-SHA256.
 * The same RSA-2048 PKCS8 is imported twice: OAEP wrap and PSS sign.
 *
 * aud is HUB_ORIGIN (configured), never the Host header.
 * Handshake: GET /v1/challenge (hub PSS-signs nonce) then
 * Authorization: Fleet-OAEP <kid>.<oaep({sec,nonce})>.
 */

export const TOKEN_V1_PREFIX = "flt_1.";
export const CHALLENGE_TTL_MS = 120_000;
export const CHALLENGE_MAX_LIVE = 8;
export const RSA_MODULUS = 2048;
export const PSS_SALT_LEN = 32;

export const HIGH_SEC_UPGRADE =
  "HIGH_SEC: this hub requires the high-security channel. Update the Fleet agent and MCP client, then issue a new hub token in Settings and paste it. Legacy Bearer tokens are not accepted.";

export const HIGH_SEC_KEY_MISMATCH =
  "HIGH_SEC: hub key does not match this token. Issue a new hub token in Settings and paste it. This computer will refuse to connect until the keys match.";

export const HIGH_SEC_HANDSHAKE =
  "HIGH_SEC: hub did not complete the high-security handshake. Update the Fleet agent and MCP client, then issue a new hub token in Settings.";

export function audMismatch(aud, origin) {
  return `HIGH_SEC: this token is bound to ${aud}, not ${origin}. Use the matching hub URL or issue a new token.`;
}

export function hubOrigin(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!s.includes("://")) s = "https://" + s;
  s = s.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

export function isTokenV1(raw) {
  const t = String(raw || "").trim();
  if (!t.startsWith(TOKEN_V1_PREFIX)) return false;
  const rest = t.slice(TOKEN_V1_PREFIX.length);
  const i = rest.indexOf(".");
  return i > 0 && i < rest.length - 1;
}

export function isLegacyFlt(raw) {
  const t = String(raw || "").trim();
  return t.startsWith("flt_") && !t.startsWith(TOKEN_V1_PREFIX);
}

export function bearerToken(header) {
  const h = String(header || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export function parseAuthorization(header) {
  const h = String(header || "").trim();
  if (!h) return { kind: "none" };
  const space = h.indexOf(" ");
  const scheme = (space === -1 ? h : h.slice(0, space)).toLowerCase();
  const value = space === -1 ? "" : h.slice(space + 1).trim();
  if (scheme === "fleet-oaep") {
    const dot = value.indexOf(".");
    if (dot < 1 || dot === value.length - 1) return { kind: "none" };
    return { kind: "oaep", kid: value.slice(0, dot), wrap: value.slice(dot + 1) };
  }
  if (scheme === "bearer") {
    return { kind: "bearer", token: value };
  }
  return { kind: "none" };
}

export function fleetOaepValue(kid, wrap) {
  return `Fleet-OAEP ${kid}.${wrap}`;
}

export function challengeMessage(aud, kid, nonce) {
  return `v1|${aud}|${kid}|${nonce}`;
}

/** Keep at most `max` unused nonces per kid so GET /v1/challenge cannot fill storage. */
export function nextChallengeList(prev, nonce, max = CHALLENGE_MAX_LIVE) {
  const list = Array.isArray(prev) ? prev.filter((n) => n && n !== nonce) : [];
  list.push(nonce);
  const dropped = [];
  while (list.length > max) dropped.push(list.shift());
  return { list, dropped };
}

export function dropChallengeNonce(prev, nonce) {
  if (!Array.isArray(prev)) return [];
  return prev.filter((n) => n && n !== nonce);
}

export function createChallengeBook({ max = CHALLENGE_MAX_LIVE } = {}) {
  const byNonce = new Map();
  const byKid = new Map();
  return {
    put(kid, nonce, extra) {
      const { list, dropped } = nextChallengeList(byKid.get(kid), nonce, max);
      for (const n of dropped) byNonce.delete(n);
      byKid.set(kid, list);
      byNonce.set(nonce, { kid, ...extra });
    },
    take(nonce) {
      const row = byNonce.get(nonce);
      if (!row) return undefined;
      byNonce.delete(nonce);
      const left = dropChallengeNonce(byKid.get(row.kid), nonce);
      if (left.length) byKid.set(row.kid, left);
      else byKid.delete(row.kid);
      return row;
    },
    clearKid(kid) {
      const list = byKid.get(kid) ?? [];
      for (const n of list) byNonce.delete(n);
      byKid.delete(kid);
    },
  };
}

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlDecode(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomHex(nBytes) {
  const bytes = crypto.getRandomValues(new Uint8Array(nBytes));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256hex(raw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(raw)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of the token secret (sec), not the full pasted string. */
export async function hashHubToken(sec) {
  return sha256hex(String(sec || "").trim());
}

function payloadBytes(obj) {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      aud: obj.aud,
      kid: obj.kid,
      pub: obj.pub,
      iat: obj.iat,
      sec: obj.sec,
    }),
  );
}

async function importPss(der, format, usages) {
  return crypto.subtle.importKey(format, der, { name: "RSA-PSS", hash: "SHA-256" }, false, usages);
}

async function importOaep(der, format, usages) {
  return crypto.subtle.importKey(format, der, { name: "RSA-OAEP", hash: "SHA-256" }, false, usages);
}

async function pssSign(pkcs8B64, data) {
  const key = await importPss(b64urlDecode(pkcs8B64), "pkcs8", ["sign"]);
  const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: PSS_SALT_LEN }, key, data);
  return new Uint8Array(sig);
}

async function pssVerify(spkiB64, data, sig) {
  const key = await importPss(b64urlDecode(spkiB64), "spki", ["verify"]);
  return crypto.subtle.verify({ name: "RSA-PSS", saltLength: PSS_SALT_LEN }, key, sig, data);
}

export async function generateUserKeypair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: RSA_MODULUS,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    kid: crypto.randomUUID(),
    publicSpkiB64: b64url(spki),
    privatePkcs8B64: b64url(pkcs8),
  };
}

export async function mintTokenV1({ aud, now } = {}) {
  const origin = hubOrigin(aud);
  if (!origin) throw new Error("HUB_ORIGIN required to mint a hub token");
  const pair = await generateUserKeypair();
  const sec = randomHex(32);
  const iat = typeof now === "function" ? Number(now()) : Date.now();
  const payload = {
    v: 1,
    aud: origin,
    kid: pair.kid,
    pub: pair.publicSpkiB64,
    iat,
    sec,
  };
  const bytes = payloadBytes(payload);
  const sig = await pssSign(pair.privatePkcs8B64, bytes);
  const raw = `${TOKEN_V1_PREFIX}${b64url(bytes)}.${b64url(sig)}`;
  return {
    raw,
    hash: await hashHubToken(sec),
    prefix: `${TOKEN_V1_PREFIX}${pair.kid.slice(0, 8)}`,
    kid: pair.kid,
    pub: pair.publicSpkiB64,
    priv: pair.privatePkcs8B64,
    sec,
    aud: origin,
    iat,
  };
}

export async function verifyTokenV1(raw) {
  const t = String(raw || "").trim();
  if (!isTokenV1(t)) throw new Error(HIGH_SEC_UPGRADE);
  const rest = t.slice(TOKEN_V1_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  const bytes = b64urlDecode(payloadB64);
  const sig = b64urlDecode(sigB64);
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(HIGH_SEC_UPGRADE);
  }
  if (obj?.v !== 1 || !obj.aud || !obj.kid || !obj.pub || !obj.sec) {
    throw new Error(HIGH_SEC_UPGRADE);
  }
  const canonical = payloadBytes({
    aud: obj.aud,
    kid: obj.kid,
    pub: obj.pub,
    iat: obj.iat,
    sec: obj.sec,
  });
  if (canonical.length !== bytes.length || !canonical.every((b, i) => b === bytes[i])) {
    throw new Error(HIGH_SEC_UPGRADE);
  }
  const ok = await pssVerify(obj.pub, bytes, sig);
  if (!ok) throw new Error(HIGH_SEC_UPGRADE);
  return {
    v: 1,
    aud: hubOrigin(obj.aud),
    kid: String(obj.kid),
    pub: String(obj.pub),
    iat: Number(obj.iat) || 0,
    sec: String(obj.sec),
  };
}

export async function signChallenge({ privatePkcs8B64, aud, kid, nonce }) {
  const msg = new TextEncoder().encode(challengeMessage(aud, kid, nonce));
  return b64url(await pssSign(privatePkcs8B64, msg));
}

export async function verifyChallenge({ publicSpkiB64, aud, kid, nonce, sig }) {
  if (!publicSpkiB64 || !aud || !kid || !nonce || !sig) return false;
  const msg = new TextEncoder().encode(challengeMessage(aud, kid, nonce));
  try {
    return await pssVerify(publicSpkiB64, msg, b64urlDecode(sig));
  } catch {
    return false;
  }
}

export async function wrapAuth({ publicSpkiB64, sec, nonce }) {
  const key = await importOaep(b64urlDecode(publicSpkiB64), "spki", ["encrypt"]);
  const pt = new TextEncoder().encode(JSON.stringify({ sec, nonce }));
  const ct = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, pt);
  return b64url(ct);
}

export async function unwrapAuth({ privatePkcs8B64, wrapB64 }) {
  const key = await importOaep(b64urlDecode(privatePkcs8B64), "pkcs8", ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, b64urlDecode(wrapB64));
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error(HIGH_SEC_KEY_MISMATCH);
  }
  const sec = obj?.sec == null ? "" : String(obj.sec);
  const nonce = obj?.nonce == null ? "" : String(obj.nonce);
  if (!sec || !nonce) throw new Error(HIGH_SEC_KEY_MISMATCH);
  return { sec, nonce };
}

export async function highSecAuthorization(token, originUrl, fetchImpl = fetch) {
  const tok = String(token || "").trim();
  if (!tok) throw new Error("Need FLEET_URL and FLEET_TOKEN (env or ~/.fleet/mcp.env)");
  if (isLegacyFlt(tok)) throw new Error(HIGH_SEC_UPGRADE);
  if (!isTokenV1(tok)) return `Bearer ${tok}`;
  const claims = await verifyTokenV1(tok);
  const origin = hubOrigin(originUrl);
  if (!origin || claims.aud !== origin) throw new Error(audMismatch(claims.aud, origin || originUrl));
  const res = await fetchImpl(`${origin}/v1/challenge?kid=${encodeURIComponent(claims.kid)}`);
  let chal = {};
  try {
    chal = await res.json();
  } catch {
    chal = {};
  }
  if (!res.ok) throw new Error(chal.error || HIGH_SEC_HANDSHAKE);
  if (chal.kid && chal.kid !== claims.kid) throw new Error(HIGH_SEC_KEY_MISMATCH);
  if (chal.aud && hubOrigin(chal.aud) !== claims.aud) throw new Error(HIGH_SEC_KEY_MISMATCH);
  const ok = await verifyChallenge({
    publicSpkiB64: claims.pub,
    aud: claims.aud,
    kid: claims.kid,
    nonce: chal.nonce,
    sig: chal.sig,
  });
  if (!ok) throw new Error(HIGH_SEC_KEY_MISMATCH);
  const wrap = await wrapAuth({ publicSpkiB64: claims.pub, sec: claims.sec, nonce: chal.nonce });
  return fleetOaepValue(claims.kid, wrap);
}
