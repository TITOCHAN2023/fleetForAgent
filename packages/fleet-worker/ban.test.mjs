import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyBanFields, applyBannedState, isBanned, oauthCallbackFail, rejectIfBanned } from "./src/ban.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function read(path) {
  return readFileSync(join(here, path), "utf8");
}

test("public Worker does not grow admin, store, or operator APIs", () => {
  const worker = read("src/index.ts");
  const ban = read("src/ban.mjs");
  const wrangler = read("wrangler.toml");
  const readme = read("README.md");
  const vars = read(".dev.vars.example");
  const deployZh = read("../../docs/zh/deploy.md");
  const deployEn = read("../../docs/en/deploy.md");
  for (const [name, src] of [
    ["index.ts", worker],
    ["ban.mjs", ban],
    ["wrangler.toml", wrangler],
    ["README.md", readme],
    [".dev.vars.example", vars],
    ["docs/zh/deploy.md", deployZh],
    ["docs/en/deploy.md", deployEn],
  ]) {
    assert.equal(src.includes("ADMIN_TOKEN"), false, name);
    assert.equal(src.includes("/v1/admin"), false, name);
    assert.equal(src.includes("/store/accounts"), false, name);
    assert.equal(src.includes("/store/banned"), false, name);
    assert.equal(src.includes("fleetInternalFetch"), false, name);
    assert.equal(src.includes("handleAdmin"), false, name);
    assert.equal(src.includes("authorizeAdmin"), false, name);
    assert.equal(/admin console/i.test(src), false, name);
  }
  assert.match(worker, /rejectIfBanned/);
});

test("applyBanFields persists banned and bannedAt on the user row", () => {
  const user = { id: "user-alice", email: "alice@example.com" };
  applyBanFields(user, 1_700_000_000_000);
  assert.equal(user.banned, true);
  assert.equal(user.bannedAt, 1_700_000_000_000);
  applyBanFields(user, 1_800_000_000_000);
  assert.equal(user.bannedAt, 1_700_000_000_000);
});

function sliceFrom(src, marker, len = 900) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, marker);
  return src.slice(i, i + len);
}

test("login and authenticated reads return 403 when the row is banned", () => {
  const user = applyBanFields({ id: "user-alice", email: "alice@example.com" });
  assert.equal(isBanned(user), true);
  assert.deepEqual(rejectIfBanned(user), { error: "banned", status: 403 });

  const worker = read("src/index.ts");
  const oauth = read("src/oauth.ts");
  for (const marker of [
    "async challenge(",
    "async resolveWrap(",
    "async oauthUser(",
    "async login(",
    "async issueSession(",
    'url.pathname === "/token-meta"',
    'url.pathname === "/token-issue"',
  ]) {
    assert.match(sliceFrom(worker, marker), /rejectIfBanned/, marker);
  }
  const resolve = sliceFrom(worker, "async function resolveActor", 2200);
  assert.match(resolve, /sess\.banned/);
  assert.match(resolve, /data\.error === "banned"/);
  assert.match(resolve, /if \(cookie\(request, "fleet_session"\)\)/);
  assert.ok(
    resolve.indexOf('auth.kind === "oaep"') < resolve.indexOf('cookie(request, "fleet_session")'),
    "explicit OAEP auth must not pay for an empty cookie-session lookup",
  );
  const catchAll = worker.search(
    /^    const resolved = await resolveActor\(request, env, fleet\);\r?\n    if \(!resolved\.actor\) return deny\(resolved\);/m,
  );
  assert.notEqual(catchAll, -1);
  assert.ok(worker.indexOf('url.pathname === "/v1/run"') > catchAll);
  assert.ok(worker.indexOf('url.pathname === "/v1/type"') > catchAll);
  const finish = sliceFrom(oauth, "async function finishUser", 700);
  assert.match(finish, /oauthCallbackFail/);
  assert.match(finish, /return fail\(/);
});

test("banned OAuth callback is HTML fail, not raw JSON", () => {
  assert.deepEqual(oauthCallbackFail({ error: "banned" }), { message: "账号已停用", status: 403 });
  assert.deepEqual(oauthCallbackFail({ error: "email required" }), { message: "email required", status: 400 });
  assert.deepEqual(oauthCallbackFail({}), { message: "oauth failed", status: 400 });
  assert.deepEqual(oauthCallbackFail(null), { message: "oauth failed", status: 400 });
});

test("applyBannedState can clear the flag without touching machines", () => {
  const user = applyBannedState({ id: "user-ada", email: "ada@example.com" }, true, 1_700_000_000_000);
  assert.equal(user.banned, true);
  applyBannedState(user, false);
  assert.equal(user.banned, false);
  assert.equal(user.bannedAt, 1_700_000_000_000);
  assert.deepEqual(rejectIfBanned(user), null);
});

test("missing or unbanned rows are not rejected", () => {
  assert.equal(isBanned(null), false);
  assert.equal(isBanned(undefined), false);
  assert.equal(isBanned({}), false);
  assert.equal(isBanned({ banned: false }), false);
  assert.equal(rejectIfBanned(null), null);
  assert.equal(rejectIfBanned({ id: "user-bob" }), null);
});
