import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public/index.html"), "utf8");

test("hub site default locale is English", () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /fleet-locale"\) === "zh" \? "zh" : "en"/);
  assert.doesNotMatch(html, /fleet-locale"\) === "en" \? "en" : "zh"/);
});

test("hub site explains multi-os fleet and ships a Help page", () => {
  assert.match(html, /\/help/);
  assert.match(html, /\/docs/);
  assert.match(html, /fleet\.ginfo\.cc/);
  assert.match(html, /Windows/);
  assert.match(html, /Linux/);
  assert.match(html, /macOS/);
  assert.match(html, /WebSocket/);
  assert.match(html, /fleet-theme/);
  assert.match(html, /data-theme-set="system"/);
  assert.match(html, /FLEET_URL=/);
  assert.match(html, /npx -y https:\/\/fleet\.ginfo\.cc\/fleet-tool\.tgz/);
  assert.doesNotMatch(html, /node packages\/fleet-tool\/index\.mjs/);
  assert.match(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public/_headers"), "utf8"), /Content-Type: application\/octet-stream/);
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
