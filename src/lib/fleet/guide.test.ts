import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function src(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

function mcpToolNames(toolSrc: string): string[] {
  const names: string[] = [];
  const start = toolSrc.indexOf("export function buildTools()");
  assert.ok(start >= 0, "expected fleet-tool operator buildTools() array");
  const end = toolSrc.indexOf("\nfunction hopStatus", start);
  const block = toolSrc.slice(start, end === -1 ? undefined : end);
  for (const m of block.matchAll(/name:\s*"([a-z_]+)"/g)) names.push(m[1]);
  return names;
}

test("guide advertises only the MCP tools shipped on main", () => {
  const shipped = mcpToolNames(src("packages/fleet-tool/operator.mjs"));
  assert.deepEqual(shipped, [
    "list_computers",
    "run",
    "get_result",
    "wait",
    "read_screen",
    "type",
    "set_computer",
    "get_current_computer",
  ]);

  const guide = src("src/components/guide-panel.tsx");
  for (const name of shipped) {
    assert.match(guide, new RegExp(`name: "${name}"`));
  }
});

test("guide documents real env, flags, and placeholder tokens", () => {
  const guide = src("src/components/guide-panel.tsx") + src("src/lib/i18n/messages.ts");
  assert.match(guide, /~\/\.fleet\/mcp\.env/);
  assert.match(guide, /FLEET_URL=/);
  assert.match(guide, /FLEET_TOKEN=flt_\.\.\./);
  assert.match(guide, /Fleet Agent\.app\/Contents\/MacOS\/FleetAgent/);
  assert.match(guide, /FleetAgent\.exe start --hub /);
  assert.match(guide, /\.\/fleet start --hub /);
  assert.match(guide, /%LOCALAPPDATA%/);
  assert.match(guide, /fleet install/);
  assert.match(guide, /--token flt_\.\.\./);
  assert.match(guide, /127\.0\.0\.1:17890/);
  assert.match(guide, /packages\/fleet-tool\/index\.mjs/);
  assert.match(guide, /claude_desktop_config\.json/);
  assert.match(guide, /tab: "agent"/);
  assert.doesNotMatch(guide, /flt_[0-9a-f]{16,}/i);
});

test("landing and console link to /help", () => {
  assert.match(src("src/components/login-landing.tsx"), /to="\/help"/);
  assert.match(src("src/components/fleet-console.tsx"), /to="\/help"/);
  assert.match(src("src/routes/help.tsx"), /createFileRoute\("\/help"\)/);
  assert.match(src("src/routes/guide.tsx"), /createFileRoute\("\/guide"\)/);
  assert.match(src("src/routes/guide.tsx"), /to="\/help"/);
});

test("console honors /?tab=agent for Settings", () => {
  assert.match(src("src/routes/index.tsx"), /validateSearch/);
  assert.match(src("src/components/fleet-console.tsx"), /initialTab/);
});
