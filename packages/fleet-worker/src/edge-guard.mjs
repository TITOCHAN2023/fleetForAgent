// HTTP control envelopes share the existing device WebSocket ceiling. Artifact
// downloads and peer/file streams have their own bounds and must not enter here.
export const CONTROL_BODY_MAX_BYTES = 16 << 20;

export class BodyLimitError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyLimitError";
    this.status = 413;
  }
}

export async function readBoundedBytes(request, maxBytes = CONTROL_BODY_MAX_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    if (request.body) void request.body.cancel().catch(() => {});
    throw new BodyLimitError();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyLimitError();
      }
      parts.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedText(request, maxBytes = CONTROL_BODY_MAX_BYTES) {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes));
}

export async function readBoundedJson(request, maxBytes = CONTROL_BODY_MAX_BYTES) {
  return JSON.parse(await readBoundedText(request, maxBytes));
}

function failure(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": "60",
    },
  });
}

// Only unauthenticated admission uses an IP bucket. Do not use caller-supplied
// token/kid/session IDs as keys: rotating them would bypass the guard. CF IP is
// trusted only with platform metadata; local fixtures share one fallback key.
async function rateLimit(request, binding, category) {
  if (!binding) return request.cf ? failure(503, "admission protection unavailable") : null;
  const ip = request.cf ? (request.headers.get("cf-connecting-ip") || "").trim() : "";
  // eslint-disable-next-line no-control-regex -- Reject whitespace and control bytes in the platform IP value.
  const source = ip && ip.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(ip) ? ip : "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const result = await binding.limit({ key: `fleet:${category}:${hash}` });
    return result.success ? null : failure(429, "too many authentication requests");
  } catch {
    return failure(503, "admission protection unavailable");
  }
}

export function edgeRequestGuard(request, env) {
  if (request.method === "OPTIONS") return null;
  const path = new URL(request.url).pathname;
  if (/^\/v1\/auth\/(google|x|callback\/(google|x))$/.test(path)) {
    return rateLimit(request, env.OAUTH_RATE_LIMITER, "oauth");
  }
  if (path === "/v1/challenge" && request.method === "GET") {
    return rateLimit(request, env.CHALLENGE_RATE_LIMITER, "challenge");
  }
  return null;
}

export const BROWSER_SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export function withBrowserSecurityHeaders(response) {
  // Reconstructing a 101 Response would discard its WebSocket handle.
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(BROWSER_SECURITY_HEADERS)) secured.headers.set(key, value);
  return secured;
}
