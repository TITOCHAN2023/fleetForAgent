import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyBannedState, rejectIfBanned } from "./src/ban.mjs";
import {
  BAN_COPY_EN,
  BAN_COPY_ZH,
  banTargetError,
  buildOverview,
  handleOpsRoute,
  isOpsAdmin,
  matchOpsSearch,
  opsPageHtml,
  parseAdminEmails,
  sortByLastSeen,
  stripSensitive,
} from "./src/ops.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(here, "src/index.ts"), "utf8");
const wrangler = readFileSync(join(here, "wrangler.toml"), "utf8");
const readme = readFileSync(join(here, "README.md"), "utf8");
const varsExample = readFileSync(join(here, ".dev.vars.example"), "utf8");

const OPS = { id: "user-ops", email: "ops@example.com" };
const USER = { id: "user-ada", email: "ada@example.com" };

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

test("empty ADMIN_EMAILS means no admins", () => {
  assert.deepEqual(parseAdminEmails(""), []);
  assert.deepEqual(parseAdminEmails("  , \n "), []);
  assert.deepEqual(parseAdminEmails(undefined), []);
  assert.equal(isOpsAdmin(OPS, ""), false);
  assert.equal(isOpsAdmin(OPS, undefined), false);
});

test("empty ADMIN_EMAILS → 404 for the page and APIs", async () => {
  for (const path of ["/ops", "/v1/ops/overview", "/v1/ops/banned"]) {
    const res = await handleOpsRoute({
      path,
      method: path.endsWith("banned") ? "POST" : "GET",
      actor: OPS,
      adminEmails: "",
      body: { id: USER.id, banned: true },
    });
    assert.equal(res.status, 404, path);
  }
});

test("non-matching session → 404", async () => {
  const res = await handleOpsRoute({
    path: "/v1/ops/overview",
    method: "GET",
    actor: USER,
    adminEmails: "ops@example.com",
  });
  assert.equal(res.status, 404);
  const page = await handleOpsRoute({
    path: "/ops",
    method: "GET",
    actor: USER,
    adminEmails: "ops@example.com",
  });
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Not Found/);
});

test("HUB_TOKEN super is not an ops admin", async () => {
  const res = await handleOpsRoute({
    path: "/v1/ops/overview",
    method: "GET",
    actor: { id: "*", super: true },
    adminEmails: "ops@example.com",
  });
  assert.equal(res.status, 404);
  assert.equal(
    isOpsAdmin({ id: "*", super: true, email: "ops@example.com" }, "ops@example.com"),
    false,
  );
});

test("id looking like an admin email is not an ops admin", () => {
  assert.equal(isOpsAdmin({ id: "ops@example.com" }, "ops@example.com"), false);
  assert.equal(
    isOpsAdmin({ id: "ops@example.com", email: "ada@example.com" }, "ops@example.com"),
    false,
  );
  assert.equal(isOpsAdmin({ id: "user-ops", email: "ops@example.com" }, "ops@example.com"), true);
  assert.equal(isOpsAdmin({ ...OPS, banned: true }, "ops@example.com"), false);
});

test("matching email → overview", async () => {
  const now = Date.now();
  const res = await handleOpsRoute({
    path: "/v1/ops/overview",
    method: "GET",
    actor: { id: "user-ops", email: "Ops@Example.com" },
    adminEmails: "ada@example.com, ops@example.com",
    users: [
      { id: "user-ada", email: "ada@example.com", kid: "kid-1", banned: false },
      { id: "user-bob", email: "bob@example.com", banned: true },
    ],
    devices: [
      {
        id: "dev-1",
        name: "SECRET-HOSTNAME",
        hostname: "SECRET-HOSTNAME",
        ip: "10.1.2.3",
        os: "darwin",
        arch: "arm64",
        agentVer: "0.2.10",
        online: true,
        lastSeen: now - 10_000,
        userId: "user-ada",
      },
      {
        id: "dev-2",
        name: "office-pc",
        os: "windows",
        arch: "amd64",
        agentVer: "0.2.10",
        online: false,
        lastSeen: now - 3 * 24 * 60 * 60 * 1000,
        userId: "user-ada",
      },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.users, 2);
  assert.equal(body.tokens, 1);
  assert.deepEqual(body.devices, { total: 2, online: 1, offline: 1 });
  assert.equal(body.os.mac, 1);
  assert.equal(body.os.windows, 1);
  assert.equal(body.arch.arm64, 1);
  assert.equal(body.arch.amd64, 1);
  assert.equal(body.agentVer["0.2.10"], 2);
  assert.equal(body.freshness.recent, 1);
  assert.equal(body.freshness.stale, 1);
  assert.match(body.freshnessNote, /last-seen freshness/i);
  assert.equal(body.accounts[0].token, true);
  assert.equal(body.accounts[0].devices, 2);
  assert.equal(body.accounts[0].email, "ada@example.com");
  assert.equal(body.accounts[0].lastSeen, now - 10_000);
  assert.equal(body.accounts[0].online, true);
  assert.deepEqual(body.accounts[0].deviceIds, ["dev-1", "dev-2"]);
  assert.equal(body.accounts[1].banned, true);
  assert.equal(body.accounts[1].lastSeen, 0);
  assert.equal(body.deviceRows[0].id, "dev-1");
  assert.equal(body.me, "user-ops");
});

test("ops search matches email/id/device and sort is recently active first", () => {
  const rows = [
    { id: "b", email: "bob@example.com", lastSeen: 1 },
    { id: "a", email: "ada@example.com", lastSeen: 9, deviceIds: ["dev-9"] },
  ];
  assert.deepEqual(
    sortByLastSeen(rows).map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(matchOpsSearch(rows[1], "ADA"), true);
  assert.equal(matchOpsSearch(rows[1], "dev-9"), true);
  assert.equal(matchOpsSearch(rows[0], "dev-9"), false);
  assert.equal(matchOpsSearch(rows[0], ""), true);
});

test("overview JSON never includes name / hostname / ip fields", () => {
  const body = buildOverview({
    users: [{ id: "user-ada", email: "ada@example.com" }],
    devices: [
      {
        id: "dev-1",
        name: "SECRET-HOSTNAME",
        hostname: "SECRET-HOSTNAME",
        ip: "203.0.113.9",
        os: "linux",
        arch: "x86_64",
        online: true,
        lastSeen: Date.now(),
        userId: "user-ada",
      },
    ],
  });
  const keys = collectKeys(body);
  assert.equal(keys.has("name"), false);
  assert.equal(keys.has("hostname"), false);
  assert.equal(keys.has("ip"), false);
  const raw = JSON.stringify(body);
  assert.equal(raw.includes("SECRET-HOSTNAME"), false);
  assert.equal(raw.includes("203.0.113.9"), false);
  assert.deepEqual(stripSensitive({ name: "x", hostname: "y", ip: "1", id: "dev-1" }), {
    id: "dev-1",
  });
});

test("banned 403 still works on login/invoke after ops sets the flag", () => {
  const user = applyBannedState({ id: "user-ada", email: "ada@example.com" }, true);
  assert.deepEqual(rejectIfBanned(user), { error: "banned", status: 403 });
  applyBannedState(user, false);
  assert.equal(rejectIfBanned(user), null);
  assert.equal(user.banned, false);
});

test("cannot ban yourself or another ADMIN_EMAILS row", async () => {
  const calls = [];
  const setBanned = async (id, banned) => {
    calls.push({ id, banned });
    return { id, banned };
  };
  const users = [
    { id: OPS.id, email: OPS.email },
    { id: USER.id, email: USER.email },
  ];

  const selfBan = await handleOpsRoute({
    path: "/v1/ops/banned",
    method: "POST",
    actor: OPS,
    adminEmails: "ops@example.com, ada@example.com",
    users,
    body: { id: OPS.id, banned: true },
    setBanned,
  });
  assert.equal(selfBan.status, 400);
  assert.deepEqual(await selfBan.json(), { error: "cannot ban yourself" });

  const selfUnban = await handleOpsRoute({
    path: "/v1/ops/banned",
    method: "POST",
    actor: OPS,
    adminEmails: "ops@example.com",
    users,
    body: { id: OPS.id, banned: false },
    setBanned,
  });
  assert.equal(selfUnban.status, 400);

  const otherAdmin = await handleOpsRoute({
    path: "/v1/ops/banned",
    method: "POST",
    actor: OPS,
    adminEmails: "ops@example.com, ada@example.com",
    users,
    body: { id: USER.id, banned: true },
    setBanned,
  });
  assert.equal(otherAdmin.status, 400);
  assert.deepEqual(await otherAdmin.json(), { error: "cannot ban an admin" });

  const unbanAdmin = await handleOpsRoute({
    path: "/v1/ops/banned",
    method: "POST",
    actor: OPS,
    adminEmails: "ops@example.com, ada@example.com",
    users,
    body: { id: USER.id, banned: false },
    setBanned,
  });
  assert.equal(unbanAdmin.status, 200);
  assert.deepEqual(calls, [{ id: USER.id, banned: false }]);

  assert.equal(banTargetError(OPS, OPS.id, true, "ops@example.com", users), "cannot ban yourself");
  assert.equal(banTargetError(OPS, USER.id, true, "ops@example.com", users), "");
});

test("ops banned sets the flag and does not run, type, or kick", async () => {
  const calls = [];
  const res = await handleOpsRoute({
    path: "/v1/ops/banned",
    method: "POST",
    actor: OPS,
    adminEmails: "ops@example.com",
    body: { id: "user-ada", banned: true },
    setBanned: async (id, banned) => {
      calls.push({ id, banned });
      return { id, banned };
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: "user-ada", banned: true });
  assert.deepEqual(calls, [{ id: "user-ada", banned: true }]);

  const bannedFn = worker.slice(
    worker.indexOf("async setUserBanned"),
    worker.indexOf("async register"),
  );
  assert.equal(bannedFn.includes("kickUserDevices"), false);
  assert.equal(bannedFn.includes("/run"), false);
  assert.equal(bannedFn.includes("/type"), false);
  assert.equal(bannedFn.includes("kick"), false);
});

test("ops page copy is Ban, not Delete/Restore, and matches public wording", () => {
  const html = opsPageHtml();
  assert.match(html, new RegExp(BAN_COPY_ZH));
  assert.match(html, new RegExp(BAN_COPY_EN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(/delete/i.test(html), false);
  assert.equal(/restore/i.test(html), false);
  assert.match(html, /data-theme-set="system"/);
  assert.match(html, /state\.data\.me/);
  assert.match(html, /t\("you"\)/);
  assert.match(html, /id="ops-q"/);
  assert.match(html, /byRecent/);
  assert.match(html, /ops-switch/);
  assert.match(html, /href="\/ops"/);
  assert.match(html, /href="\/"/);
});

test("ops page body script parses", () => {
  const html = opsPageHtml();
  const bodyStart = html.search(/<body[\s>]/i);
  assert.ok(bodyStart !== -1, "expected <body>");
  const scripts = [...html.slice(bodyStart).matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "expected a <script> in <body>");
  const script = scripts[scripts.length - 1][1];
  assert.doesNotThrow(() => {
    new Function(script);
  });
});

test("opsPageHtml first paint has visible title chrome and no Google Fonts", () => {
  const html = opsPageHtml();
  const bodyStart = html.indexOf("<body>");
  assert.notEqual(bodyStart, -1);
  const scriptInBody = html.indexOf("<script>", bodyStart);
  const initial = html.slice(bodyStart, scriptInBody);
  assert.match(initial, /用量与健康/);
  assert.match(initial, /加载中/);
  assert.match(initial, /fleet\.ginfo\.cc/);
  assert.match(initial, /<header class="top">/);
  assert.equal(html.includes("fonts.googleapis.com"), false);
  assert.equal(html.includes("fonts.gstatic.com"), false);
  assert.match(html, /ui-sans-serif/);
  assert.match(html, /system-ui/);
  const loadStart = html.indexOf("async function load()");
  const load = html.slice(loadStart, html.indexOf("load();", loadStart));
  assert.ok(load.includes("render()"));
  assert.ok(load.indexOf("render()") < load.indexOf("/v1/ops/overview"));
});

test("worker gates /ops before assets and /v1/ops before the catch-all actor", () => {
  const ops = worker.indexOf('path === "/ops"');
  const assets = worker.indexOf("env.ASSETS.fetch");
  const overview = worker.indexOf('url.pathname === "/v1/ops/overview"');
  const catchAll = worker.search(
    /^\s{4}const resolved = await resolveActor\(request, env, fleet\);\r?\n\s{4}if \(!resolved\.actor\) return deny\(resolved\);/m,
  );
  assert.ok(ops !== -1 && ops < assets);
  assert.ok(overview !== -1 && overview < catchAll);
  assert.match(worker, /handleOpsRoute/);
  assert.match(worker, /archFromBody/);
  assert.match(worker, /ADMIN_EMAILS/);
  assert.match(worker, /ops: isOpsAdmin\(resolved\.actor, env\.ADMIN_EMAILS\)/);
  const me = worker.slice(
    worker.indexOf('url.pathname === "/v1/me"'),
    worker.indexOf('url.pathname === "/v1/hub_token"'),
  );
  assert.equal(
    (me.match(/resolveSession/g) || []).length,
    0,
    "/v1/me must reuse its resolved actor",
  );
});

test("dispatchOps uses the cookie session and ignores Authorization", () => {
  const start = worker.indexOf("async function dispatchOps");
  const end = worker.indexOf("function configuredOrigin");
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const fn = worker.slice(start, end);
  assert.match(fn, /resolveSession/);
  assert.equal(fn.includes("resolveActor"), false);
  assert.equal(fn.includes("parseAuthorization"), false);
  assert.equal(fn.includes("resolve-wrap"), false);
  assert.equal(fn.includes("HUB_TOKEN"), false);
  assert.match(worker, /async function resolveSession/);
  assert.match(readme, /cookie/i);
});

test("committed config does not list admin emails or put ADMIN_EMAILS in vars", () => {
  const start = wrangler.search(/^\[vars\]/m);
  assert.notEqual(start, -1);
  const rest = wrangler.slice(start);
  const next = rest.slice(1).search(/^\[/m);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  assert.equal(block.includes("ADMIN_EMAILS"), false);
  assert.match(wrangler, /npx wrangler secret put ADMIN_EMAILS/);
  assert.equal(/[a-z0-9._%+-]+@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(readme), false);
  assert.equal(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(varsExample), false);
  assert.match(readme, /npx wrangler secret put ADMIN_EMAILS/);
  assert.match(readme, /empty/i);
});
