import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { packFleetTool } from "../../scripts/pack-fleet-tool.mjs";
import { FLEET_TOOL_TGZ_TYPE, isFleetToolTgzPath, serveFleetToolTgz } from "./src/tarball.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicTgz = join(here, "public/fleet-tool.tgz");
const html = readFileSync(join(here, "public/index.html"), "utf8");
const wrangler = readFileSync(join(here, "wrangler.toml"), "utf8");
const worker = readFileSync(join(here, "src/index.ts"), "utf8");

function tarballListing(tgz) {
  return execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function tarballFile(tgz, name) {
  return execFileSync("tar", ["-xOzf", tgz, name], { encoding: "utf8" });
}

function assertNpmTarball(tgz) {
  const buf = readFileSync(tgz);
  assert.equal(buf[0], 0x1f, `${tgz} is not gzip`);
  assert.equal(buf[1], 0x8b, `${tgz} is not gzip`);
  const head = buf.subarray(0, 256).toString("utf8");
  assert.doesNotMatch(head, /<!DOCTYPE html>/i);
  assert.doesNotMatch(head, /<html/i);
  const listing = tarballListing(tgz);
  for (const name of [
    "package/package.json",
    "package/index.mjs",
    "package/operator.mjs",
    "package/tokenv1.mjs",
  ]) {
    assert.ok(listing.includes(name), `missing ${name}`);
  }
  const manifest = JSON.parse(tarballFile(tgz, "package/package.json"));
  assert.equal(manifest.name, "fleet-tool");
  assert.equal(manifest.bin?.["fleet-tool"], "./index.mjs");
  assert.match(tarballFile(tgz, "package/index.mjs"), /from "\.\/tokenv1\.mjs"/);
  assert.doesNotMatch(tarballFile(tgz, "package/index.mjs"), /\.\.\/fleet-worker/);
}

test("public /fleet-tool.tgz is a gzip npm pack, not HTML", () => {
  assertNpmTarball(publicTgz);
});

test("packer output matches the committed tarball contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tool-pack-test-"));
  const fresh = join(dir, "fleet-tool.tgz");
  try {
    packFleetTool({ outFile: fresh });
    assertNpmTarball(fresh);
    for (const name of ["package/package.json", "package/index.mjs", "package/operator.mjs", "package/tokenv1.mjs"]) {
      assert.equal(tarballFile(publicTgz, name), tarballFile(fresh, name), name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packed fleet-tool starts and asks for FLEET_URL / FLEET_TOKEN", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tool-extract-"));
  try {
    execFileSync("tar", ["-xzf", publicTgz, "-C", dir]);
    execFileSync("node", ["--check", join(dir, "package/index.mjs")]);
    let err;
    try {
      execFileSync("node", [join(dir, "package/index.mjs"), "list"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected missing-env exit");
    assert.match(String(err.stderr || err.stdout || err), /FLEET_URL/);
    assert.match(String(err.stderr || err.stdout || err), /FLEET_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Help and Settings snippets use npx, not a repo clone", () => {
  assert.match(html, /npx -y https:\/\/fleet\.ginfo\.cc\/fleet-tool\.tgz/);
  assert.equal((html.match(/npx -y https:\/\/fleet\.ginfo\.cc\/fleet-tool\.tgz/g) || []).length, 3);
  assert.doesNotMatch(html, /node packages\/fleet-tool\/index\.mjs/);
  assert.doesNotMatch(html, /git clone/);
});

test("Worker refuses an HTML SPA fallback for /fleet-tool.tgz", async () => {
  assert.equal(isFleetToolTgzPath("/fleet-tool.tgz"), true);
  assert.equal(isFleetToolTgzPath("/help"), false);
  const htmlRes = serveFleetToolTgz(
    new Response("<!DOCTYPE html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  assert.equal(htmlRes.status, 404);
  const ok = serveFleetToolTgz(
    new Response(readFileSync(publicTgz), {
      status: 200,
      headers: { "content-type": "application/gzip" },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), FLEET_TOOL_TGZ_TYPE);
  const body = Buffer.from(await ok.arrayBuffer());
  assert.equal(body[0], 0x1f);
  assert.equal(body[1], 0x8b);
});

test("wrangler still SPA-falls-back other paths; no new DO migration or token vars", () => {
  assert.match(wrangler, /not_found_handling = "single-page-application"/);
  assert.match(wrangler, /run_worker_first = true/);
  assert.match(worker, /isFleetToolTgzPath/);
  assert.match(worker, /serveFleetToolTgz/);
  assert.equal((wrangler.match(/new_sqlite_classes/g) || []).length, 1);
  assert.match(wrangler, /new_sqlite_classes = \["DeviceDO", "FleetDO"\]/);
  const varsBlock = wrangler.slice(wrangler.indexOf("\n[vars]"));
  const varsEnd = varsBlock.search(/\n\[\[|\n\[assets\]/);
  const vars = varsBlock.slice(0, varsEnd === -1 ? undefined : varsEnd);
  assert.match(vars, /HUB_ORIGIN = "https:\/\/fleet\.ginfo\.cc"/);
  assert.doesNotMatch(vars, /HUB_TOKEN\s*=/);
  assert.doesNotMatch(vars, /ADMIN_EMAILS\s*=/);
  assert.doesNotMatch(vars, /flt_/);
});
