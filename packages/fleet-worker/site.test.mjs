import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "public/index.html"), "utf8");
const wrangler = readFileSync(join(here, "wrangler.toml"), "utf8");
const worker = readFileSync(join(here, "src/index.ts"), "utf8");
const tgz = join(here, "public/fleet-tool.tgz");

test("hub site explains multi-os fleet and ships a Help page", () => {
  assert.match(html, /\/help/);
  assert.match(html, /fleet\.ginfo\.cc/);
  assert.match(html, /Windows/);
  assert.match(html, /Linux/);
  assert.match(html, /macOS/);
  assert.match(html, /WebSocket/);
  assert.match(html, /fleet-theme/);
  assert.match(html, /data-theme-set="system"/);
  assert.match(html, /FLEET_URL=/);
  assert.match(html, /FleetAgent-windows-arm64/);
  assert.match(html, /fleet-agent-linux-arm64/);
  assert.match(html, /FleetAgent-macos-arm64\.zip/);
  assert.match(html, /FleetAgent-macos-amd64\.zip/);
  assert.match(html, /checksums-0\.2\.10\.txt/);
  assert.match(html, /resetConfirm/);
  assert.match(html, /anatomyRsa/);
  assert.match(html, /Fleet-OAEP/);
  assert.match(html, /class="prompt"/);
  assert.match(html, /\/logo\.png/);
  assert.match(html, /ops-switch/);
  assert.match(html, /href="\/ops"/);
  assert.match(html, /user\.ops/);
});

test("import-the-tool snippet is npx tarball from page origin", () => {
  assert.match(html, /function importToolSnippet\(/);
  const calls = html.match(/\$\{importToolSnippet\(\)\}/g) || [];
  assert.equal(calls.length, 3);
  assert.match(html, /npx -y \$\{origin\}\/fleet-tool\.tgz/);
  assert.doesNotMatch(html, /node packages\/fleet-tool\/index\.mjs/);
  assert.doesNotMatch(html, /index\.mjs list/);
});

test("worker public assets serve /fleet-tool.tgz", () => {
  assert.match(wrangler, /directory = "\.\/public"/);
  assert.match(wrangler, /binding = "ASSETS"/);
  assert.match(worker, /if \(!hub\)/);
  assert.match(worker, /env\.ASSETS\.fetch\(request\)/);
  assert.ok(existsSync(tgz), "expected packages/fleet-worker/public/fleet-tool.tgz");
  const buf = readFileSync(tgz);
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
});
