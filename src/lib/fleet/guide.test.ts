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
    "get_computer",
    "heartbeat",
    "run",
    "get_result",
    "wait",
    "read_screen",
    "type",
    "set_computer",
    "get_current_computer",
    "desktop_screenshot",
    "desktop_action",
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
  assert.match(guide, /npx -y https:\/\/fleet\.ginfo\.cc\/fleet-tool\.tgz/);
  assert.doesNotMatch(guide, /node packages\/fleet-tool\/index\.mjs/);
  assert.doesNotMatch(guide, /git clone/);
  assert.match(guide, /claude_desktop_config\.json/);
  assert.match(guide, /tab: "agent"/);
  assert.doesNotMatch(guide, /flt_[0-9a-f]{16,}/i);
});

test("landing header and console link to /help", () => {
  assert.match(src("src/components/login-landing.tsx"), /<SiteHeader \/>/);
  assert.match(src("src/components/site-header.tsx"), /to="\/help"/);
  assert.match(src("src/components/fleet-console.tsx"), /to="\/help"/);
  assert.match(src("src/routes/help.tsx"), /createFileRoute\("\/help"\)/);
  assert.match(src("src/routes/guide.tsx"), /createFileRoute\("\/guide"\)/);
  assert.match(src("src/routes/guide.tsx"), /to="\/help"/);
});

test("docs is a public blog that compiles docs/blog markdown", () => {
  assert.match(src("src/routes/docs.tsx"), /createFileRoute\("\/docs"\)/);
  assert.match(src("src/routes/docs/index.tsx"), /createFileRoute\("\/docs\/"\)/);
  assert.match(src("src/routes/docs/$slug.tsx"), /createFileRoute\("\/docs\/\$slug"\)/);
  assert.match(src("src/components/site-header.tsx"), /to="\/docs"/);
  assert.match(src("src/components/login-landing.tsx"), /<SiteHeader \/>/);
  assert.match(src("src/components/login-landing.tsx"), /font-hand/);
  assert.match(src("src/components/blog-index.tsx"), /font-hand/);
  assert.match(src("src/components/blog-article.tsx"), /font-hand/);
  assert.match(src("src/styles.css"), /Excalifont-Latin\.woff2/);
  assert.match(src("src/routes/__root.tsx"), /@chinese-fonts\/xiaolai@3\.0\.0/);
  assert.match(src("src/styles.css"), /font-family: "Xiaolai SC"/);
  assert.match(src("scripts/pack-blog.mjs"), /docs\/blog/);
  assert.match(src("docs/blog/why-fleet-is-safe.zh.md"), /^---/m);
  assert.match(src("docs/blog/why-fleet-is-safe.en.md"), /^---/m);
});

test("console honors /?tab=agent for Settings", () => {
  assert.match(src("src/routes/index.tsx"), /validateSearch/);
  assert.match(src("src/components/fleet-console.tsx"), /initialTab/);
});

test("Settings always shows peer MCP configs and device installers, adding token only when known", () => {
  const settings = src("src/components/hub-access.tsx") + src("src/lib/i18n/messages.ts");
  const server = src("src/lib/fleet/mcp-sse.server.ts");
  assert.match(settings, /command: "npx"/);
  assert.match(settings, /https:\/\/fleet\.ginfo\.cc\/fleet-tool\.tgz/);
  assert.match(settings, /const stdioEnv = \{ FLEET_URL: base \}/);
  assert.match(settings, /if \(token\) stdioEnv\.FLEET_TOKEN = token/);
  assert.match(settings, /type: "http"/);
  assert.match(settings, /url: `\$\{base\}\/mcp`/);
  assert.match(settings, /if \(token\) httpServer\.headers = \{ Authorization: `Bearer \$\{token\}` \}/);
  assert.match(settings, /type: "sse"/);
  assert.match(settings, /\/mcp\/sse/);
  assert.match(settings, /if \(token\) sseServer\.headers = \{ Authorization: `Bearer \$\{token\}` \}/);
  assert.match(settings, /curl -fsSL/);
  assert.match(settings, /install\.sh/);
  assert.match(settings, /scriptblock.*irm/);
  assert.match(settings, /install\.ps1/);
  assert.match(settings, /origin \? <ReadySetup/);
  assert.match(settings, /ReadySetup origin=\{origin\} token=\{secret\}/);
  assert.doesNotMatch(settings, /secret && origin/);
  assert.match(settings, /token \? ` --token/);
  assert.match(settings, /token \? ` -Token/);
  assert.match(settings, /href="\/releases"/);
  assert.ok(
    settings.indexOf('t("hub.mcpStdioConfig")') < settings.indexOf('t("hub.quickTitle")'),
    "AI-side MCP configs must render above device installers",
  );
  assert.ok(
    settings.indexOf('t("hub.mcpHttpConfig")') < settings.indexOf('t("hub.mcpSseConfig")'),
    "Streamable HTTP and classic SSE must be separate peer blocks",
  );
  assert.match(server, /highSecAuthorization/);
  assert.match(server, /handleHubHttp/);
  assert.match(server, /createSessionCorrTracker/);
  assert.match(server, /origin not allowed/);
  assert.doesNotMatch(server, /searchParams\.get\(["']token["']\)/i);
});
