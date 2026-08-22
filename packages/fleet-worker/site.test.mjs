import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public/index.html"), "utf8");

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
  assert.match(html, /checksums-0\.2\.8\.txt/);
  assert.match(html, /\/logo\.png/);
});
