/** Google / X OAuth for the public site. Not the Grok sandbox broker. */

import { oauthCallbackFail } from "./ban.mjs";
import { googleProfileEmail, xAccountEmail } from "./oauth-account.mjs";

export type OAuthEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  FLEET: DurableObjectNamespace;
};

type Pending = {
  provider: "google" | "x";
  verifier?: string;
  bindingHash: string;
  sourceHash: string;
  exp: number;
};

const OAUTH_COOKIE_PREFIX = "fleet_oauth_";
const OAUTH_COOKIE_PATH = "/v1/auth/callback";
const OAUTH_PENDING_SECONDS = 10 * 60;

function originOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rand(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256b64url(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return b64url(new Uint8Array(buf));
}

function hasUnsafeHeaderByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function oauthSourceHash(request: Request): Promise<string> {
  // CF-Connecting-IP is authoritative only when Cloudflare supplied the cf
  // metadata. In local/dev requests the header is client-controlled, so all
  // such requests deliberately share one conservative fallback bucket.
  const connectingIp = request.cf ? (request.headers.get("cf-connecting-ip") ?? "").trim() : "";
  const source =
    connectingIp.length > 0 &&
    connectingIp.length <= 128 &&
    !hasUnsafeHeaderByte(connectingIp)
      ? `cf-ip:${connectingIp}`
      : "non-cloudflare";
  return sha256b64url(source);
}

function fleet(env: OAuthEnv) {
  return env.FLEET.get(env.FLEET.idFromName("fleet"));
}

export async function handleOAuth(request: Request, env: OAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/v1/auth/google" && request.method === "GET") return startGoogle(request, env);
  if (path === "/v1/auth/x" && request.method === "GET") return startX(request, env);
  if (path === "/v1/auth/callback/google") {
    return clearBindingCookie(
      await finishGoogle(request, env),
      new URL(request.url).searchParams.get("state") ?? "",
    );
  }
  if (path === "/v1/auth/callback/x") {
    return clearBindingCookie(
      await finishX(request, env),
      new URL(request.url).searchParams.get("state") ?? "",
    );
  }
  return null;
}

async function startGoogle(request: Request, env: OAuthEnv): Promise<Response> {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  if (!id)
    return fail("Google 登录未配置：需要 wrangler secret GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  const state = rand();
  const binding = rand();
  if (
    !(await putPending(env, state, {
      provider: "google",
      bindingHash: await sha256b64url(binding),
      sourceHash: await oauthSourceHash(request),
      exp: Date.now() + OAUTH_PENDING_SECONDS * 1000,
    }))
  ) {
    return fail("OAuth 登录请求过多，请稍后重试", 503);
  }
  const redir = `${originOf(request)}/v1/auth/callback/google`;
  const q = new URLSearchParams({
    client_id: id,
    redirect_uri: redir,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return withBindingCookie(
    Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302),
    state,
    binding,
  );
}

async function startX(request: Request, env: OAuthEnv): Promise<Response> {
  const id = env.X_CLIENT_ID?.trim();
  if (!id) return fail("X 登录未配置：需要 wrangler secret X_CLIENT_ID / X_CLIENT_SECRET");
  const state = rand();
  const verifier = rand(48);
  const binding = rand();
  if (
    !(await putPending(env, state, {
      provider: "x",
      verifier,
      bindingHash: await sha256b64url(binding),
      sourceHash: await oauthSourceHash(request),
      exp: Date.now() + OAUTH_PENDING_SECONDS * 1000,
    }))
  ) {
    return fail("OAuth 登录请求过多，请稍后重试", 503);
  }
  const redir = `${originOf(request)}/v1/auth/callback/x`;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redir,
    scope: "users.read tweet.read offline.access",
    state,
    code_challenge: await sha256b64url(verifier),
    code_challenge_method: "S256",
  });
  return withBindingCookie(
    Response.redirect(`https://twitter.com/i/oauth2/authorize?${q}`, 302),
    state,
    binding,
  );
}

async function finishGoogle(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return fail(err);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const pending = await takePending(env, state, await bindingHash(request, state));
  if (!pending || pending.provider !== "google") return fail("bad oauth state");
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!id || !secret) return fail("Google 登录未配置");
  const redir = `${originOf(request)}/v1/auth/callback/google`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redir,
      grant_type: "authorization_code",
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) return fail(token.error || "google token");
  const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const me = (await meRes.json()) as { email?: string; verified_email?: boolean };
  const got = googleProfileEmail(me);
  if (!got.ok) return fail(got.error);
  return finishUser(env, got.email, "google");
}

async function finishX(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return fail(err);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const pending = await takePending(env, state, await bindingHash(request, state));
  if (!pending || pending.provider !== "x" || !pending.verifier) return fail("bad oauth state");
  const id = env.X_CLIENT_ID?.trim();
  const secret = env.X_CLIENT_SECRET?.trim();
  if (!id || !secret) return fail("X 登录未配置");
  const redir = `${originOf(request)}/v1/auth/callback/x`;
  const basic = btoa(`${id}:${secret}`);
  const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redir,
      code_verifier: pending.verifier,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) return fail(token.error || "x token");
  const meRes = await fetch("https://api.x.com/2/users/me?user.fields=username,name", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const me = (await meRes.json()) as { data?: { id?: string; username?: string } };
  const xid = me.data?.id;
  if (!xid) return fail("x 未返回用户");
  const email = xAccountEmail(xid);
  if (!email) return fail("x 未返回用户");
  return finishUser(env, email, "x");
}

async function finishUser(env: OAuthEnv, email: string, provider: string): Promise<Response> {
  const res = await fleet(env).fetch(
    new Request("https://fleet/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, provider }),
    }),
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    const failPage = oauthCallbackFail(payload);
    return fail(failPage.message, failPage.status);
  }
  const headers = new Headers(res.headers);
  headers.set("location", "/");
  return new Response(null, { status: 302, headers });
}

async function putPending(env: OAuthEnv, state: string, row: Pending): Promise<boolean> {
  const response = await fleet(env).fetch(
    new Request("https://fleet/oauth-pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state,
        provider: row.provider,
        verifier: row.verifier,
        exp: row.exp,
        binding_hash: row.bindingHash,
        source_hash: row.sourceHash,
      }),
    }),
  );
  return response.ok;
}

async function takePending(
  env: OAuthEnv,
  state: string,
  bindingHashValue: string,
): Promise<Pending | null> {
  if (!state || !bindingHashValue) return null;
  const query = new URLSearchParams({ state, binding_hash: bindingHashValue });
  const res = await fleet(env).fetch(new Request(`https://fleet/oauth-pending?${query}`));
  if (!res.ok) return null;
  const row = (await res.json()) as Pending & { error?: string };
  if (!row.provider || (row.exp && row.exp < Date.now())) return null;
  return row;
}

function bindingCookieName(state: string): string {
  return `${OAUTH_COOKIE_PREFIX}${state}`;
}

function requestCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function bindingHash(request: Request, state: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) return "";
  const binding = requestCookie(request, bindingCookieName(state));
  return /^[a-zA-Z0-9_-]{32,128}$/.test(binding) ? sha256b64url(binding) : "";
}

function withBindingCookie(response: Response, state: string, binding: string): Response {
  return withCookie(
    response,
    `${bindingCookieName(state)}=${binding}; Path=${OAUTH_COOKIE_PATH}; Max-Age=${OAUTH_PENDING_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearBindingCookie(response: Response, state: string): Response {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) return response;
  return withCookie(
    response,
    `${bindingCookieName(state)}=; Path=${OAUTH_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
}

function withCookie(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", value);
  return new Response(response.body, { status: response.status, headers });
}

function fail(msg: string, status = 400): Response {
  const html = `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(msg)}</pre><p><a href="/">返回</a></p>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}
