import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BodyLimitError, BROWSER_SECURITY_HEADERS, edgeRequestGuard,
  readBoundedBytes, readBoundedJson, readBoundedText, withBrowserSecurityHeaders,
} from "../packages/fleet-worker/src/edge-guard.mjs";
import { compileBlog, publicSiteRouting } from "./pack-blog.mjs";

function streaming(chunks, headers = {}) {
  let cancelled = false;
  const request = new Request("https://hub.test/mcp", {
    method: "POST", headers, duplex: "half",
    body: new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      },
      cancel() { cancelled = true; },
    }),
  });
  return { request, cancelled: () => cancelled };
}

test("bounded JSON counts streamed bytes without trusting content-length", async () => {
  const encoder = new TextEncoder();
  for (const headers of [{}, { "content-length": "1" }]) {
    const fixture = streaming([encoder.encode('{"v":"'), encoder.encode("a".repeat(30)), encoder.encode('"}')], headers);
    await assert.rejects(readBoundedJson(fixture.request, 12), BodyLimitError);
    assert.equal(fixture.cancelled(), true);
  }
  const text = '{"v":"中文"}';
  const bytes = encoder.encode(text);
  const fixture = streaming([bytes.slice(0, 7), bytes.slice(7, 9), bytes.slice(9)]);
  assert.deepEqual(await readBoundedJson(fixture.request, bytes.length), { v: "中文" });
  await assert.rejects(readBoundedJson(new Request("https://hub.test", { method: "POST", body: "{" })), SyntaxError);
});

test("declared oversized body is rejected before reading; empty body stays empty", async () => {
  const fixture = streaming([new Uint8Array(1)], { "content-length": "1000" });
  await assert.rejects(readBoundedText(fixture.request, 100), { status: 413 });
  assert.equal(fixture.cancelled(), true);
  assert.equal(await readBoundedText(new Request("https://hub.test")), "");
});

test("bounded byte reads preserve raw bytes including invalid UTF-8", async () => {
  const raw = new Uint8Array([0xff, 0xfe, 0, 128, 123]);
  assert.deepEqual(await readBoundedBytes(streaming([raw.slice(0, 2), raw.slice(2)]).request), raw);
});

test("admission scopes do not throttle running tasks, plugins, panes, MCP or WSS", async () => {
  const keys = [];
  const binding = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const env = { OAUTH_RATE_LIMITER: binding, CHALLENGE_RATE_LIMITER: binding };
  for (const path of ["/v1/device", "/v1/run", "/v1/get_result", "/v1/ping", "/v1/plugin/call", "/mcp", "/mcp/sse"]) {
    assert.equal(await edgeRequestGuard(new Request(`https://hub.test${path}`), env), null);
  }
  assert.equal(keys.length, 0);
  for (const path of ["/v1/auth/google", "/v1/auth/callback/x", "/v1/challenge"]) {
    const response = await edgeRequestGuard(new Request(`https://hub.test${path}`), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
  }
  assert.equal(await edgeRequestGuard(new Request("https://hub.test/v1/auth/google", { method: "OPTIONS" }), env), null);
});

test("admission source cannot be bypassed by spoofed IP/kid and remains private", async () => {
  const keys = [];
  const env = { CHALLENGE_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } };
  for (const value of ["one", "two"]) {
    const request = new Request(`https://hub.test/v1/challenge?kid=${value}`, { headers: { "cf-connecting-ip": value } });
    assert.equal(await edgeRequestGuard(request, env), null);
  }
  assert.equal(keys[0], keys[1]);
  const request = new Request("https://hub.test/v1/challenge", { headers: { "cf-connecting-ip": "192.0.2.10" } });
  Object.defineProperty(request, "cf", { value: { colo: "SIN" } });
  await edgeRequestGuard(request, env);
  assert.notEqual(keys[0], keys[2]);
  assert.doesNotMatch(keys[2], /192\.0\.2\.10/);
  assert.equal((await edgeRequestGuard(request, {})).status, 503);
  assert.equal(await edgeRequestGuard(new Request(request.url), {}), null);
});

test("binding faults fail admission only; browser headers preserve cookies and websocket", async () => {
  const response = await edgeRequestGuard(new Request("https://hub.test/v1/challenge"), { CHALLENGE_RATE_LIMITER: { limit() { throw new Error("unavailable"); } } });
  assert.equal(response.status, 503);
  const upgrade = { status: 101, webSocket: {} };
  assert.equal(withBrowserSecurityHeaders(upgrade), upgrade);
  const secured = withBrowserSecurityHeaders(new Response("ok", { status: 201, headers: { "set-cookie": "x=y", "access-control-allow-origin": "*" } }));
  assert.equal(secured.status, 201);
  assert.equal(secured.headers.get("set-cookie"), "x=y");
  assert.equal(secured.headers.get("access-control-allow-origin"), "*");
  assert.equal(await secured.text(), "ok");
  const staticHeaders = readFileSync(new URL("../packages/fleet-worker/public/_headers", import.meta.url), "utf8").toLowerCase();
  for (const [key, value] of Object.entries(BROWSER_SECURITY_HEADERS)) {
    assert.equal(secured.headers.get(key), value);
    assert.ok(staticHeaders.includes(`${key}: ${value.toLowerCase()}`));
  }
});

test("static routing keeps known public SPA paths without catch-all 200", () => {
  const result = publicSiteRouting(compileBlog().posts);
  for (const [file, expected] of [["_redirects", result.redirects], ["sitemap.xml", result.sitemap]]) {
    assert.equal(readFileSync(new URL(`../packages/fleet-worker/public/${file}`, import.meta.url), "utf8"), expected);
  }
  assert.match(result.redirects, /\/help \/ 200/);
  for (const path of ["/help", "/plugins", "/docs", ...compileBlog().posts.map(({ slug }) => `/docs/${slug}`)]) {
    assert.ok(result.redirects.split("\n").includes(`${path}/ ${path} 301`));
    assert.ok(result.redirects.split("\n").includes(`${path} / 200`));
  }
  // Canonical root avoids HTML handling redirects; slash aliases redirect once.
  assert.doesNotMatch(result.redirects, /\/index\.html/);
  assert.doesNotMatch(result.redirects, /^\S+\/ \/ 200$/m);
  assert.doesNotMatch(result.redirects, /\*/);
  assert.match(result.sitemap, /\/demo\//);
  assert.match(result.sitemap, /\/privacy\//);
  assert.throws(() => publicSiteRouting([{ slug: "evil\n/*" }]));
  const config = readFileSync(new URL("../packages/fleet-worker/wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /not_found_handling = "404-page"/);
  assert.doesNotMatch(config, /run_worker_first = true/);
});

test("real local Workers assets preserve SPA deep links and return true 404", { skip: !process.env.FLEET_STATIC_TEST_URL }, async () => {
  const origin = new URL(process.env.FLEET_STATIC_TEST_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "this test must not target production");
  const paths = ["/help", "/plugins", "/docs", ...compileBlog().posts.map(({ slug }) => `/docs/${slug}`)];
  for (const path of paths) {
    const direct = await fetch(new URL(`${path}?lang=zh`, origin), { redirect: "manual" });
    assert.equal(direct.status, 200, `${path}: deep link must not redirect to the home page`);
    assert.equal(direct.headers.get("location"), null);
    assert.equal(direct.headers.get("x-frame-options"), "DENY");
    assert.equal(direct.headers.get("x-content-type-options"), "nosniff");
    assert.match(direct.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    await direct.body.cancel();
    const alias = await fetch(new URL(`${path}/?lang=zh`, origin), { redirect: "manual" });
    assert.equal(alias.status, 301);
    assert.equal(alias.headers.get("location"), `${path}?lang=zh`);
    await alias.body?.cancel();
    const followed = await fetch(new URL(`${path}/?lang=zh`, origin));
    assert.equal(followed.status, 200);
    assert.equal(new URL(followed.url).pathname, path);
    assert.equal(new URL(followed.url).search, "?lang=zh");
    await followed.body.cancel();
  }
  for (const path of ["/no-such-fleet-test-page", "/docs/no-such-fleet-test-post", "/docs/no-such-fleet-test-post/"]) {
    const missing = await fetch(new URL(path, origin), { redirect: "manual" });
    assert.equal(missing.status, 404, path);
    assert.equal(missing.headers.get("x-frame-options"), "DENY");
    assert.match(await missing.text(), /Page not found/);
  }
});
