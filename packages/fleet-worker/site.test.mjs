import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public/index.html"),
  "utf8",
);
const pluginRegistry = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public/plugin-registry.json"), "utf8"),
);

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
  assert.match(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public/_headers"), "utf8"),
    /Content-Type: application\/octet-stream/,
  );
  assert.match(html, /FleetAgent-windows-arm64/);
  assert.match(html, /fleet-agent-linux-arm64/);
  assert.match(html, /FleetAgent-macos-arm64\.zip/);
  assert.match(html, /FleetAgent-macos-amd64\.zip/);
  assert.match(html, /checksums-0\.6\.4\.txt/);
  assert.match(html, /resetConfirm/);
  assert.match(html, /anatomyRsa/);
  assert.match(html, /Fleet-OAEP/);
  assert.match(html, /class="prompt/);
  assert.match(html, /\/v1\/set_computer_alias/);
  assert.match(html, /JSON\.stringify\(\{ device_id: deviceId, alias \}\)/);
  assert.match(html, /await loadComputers\(\)/);
  assert.match(html, /data-alias-device=/);
  assert.match(html, /maxlength="64"/);
  assert.match(html, /agentVer/);
  assert.match(html, /\.machine \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(html, /window\.prompt/);
  assert.match(html, /\/logo\.png/);
  assert.match(html, /ops-switch/);
  assert.match(html, /href="\/ops"/);
  assert.match(html, /href="\/plugins"/);
  assert.match(html, /plugin-registry\.json/);
  assert.match(html, /plugin-grid/);
  assert.match(html, /TITOCHAN2023\/fleet-plugins/);
  assert.match(html, /install_plugin/);
  assert.match(html, /user\.ops/);
  assert.match(html, /command: "npx"/);
  assert.match(html, /type: "http"/);
  assert.match(html, /base \+ "\/mcp"/);
  assert.match(html, /type: "sse"/);
  assert.match(html, /base \+ "\/mcp\/sse"/);
  assert.match(html, /Authorization: "Bearer " \+ token/);
  assert.match(html, /install\.sh/);
  assert.match(html, /install\.ps1/);
  assert.match(html, /data-copy=/);
  assert.match(html, /if \(token\) stdioEnv\.FLEET_TOKEN = token/);
  assert.match(html, /if \(token\) httpServer\.headers =/);
  assert.match(html, /if \(token\) sseServer\.headers =/);
  assert.match(html, /\.setup-copy-head \{/);
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(html, /white-space: pre; overflow-wrap: normal; word-break: normal/);
  assert.match(html, /class="setup-copy-head"/);
  assert.match(html, /readySetup\(origin, state\.secret\)/);
  assert.doesNotMatch(html, /state\.secret \? readySetup/);
  assert.ok(
    html.indexOf('t("mcpStdioConfig")') < html.indexOf('t("quickTitle")'),
    "AI-side MCP configs must render above device installers",
  );
});

test("machine cards show aliases, original identity, and Agent version without HTML injection", () => {
  const start = html.indexOf("function fleetView()");
  const end = html.indexOf("function aliasPromptView()", start);
  assert.ok(start > 0 && end > start);
  const fleetView = new Function(`
    const state = { computers: [
      { id: 'id<&"', name: 'host<&"', alias: 'SG <prod> & "fast"', os: 'linux<&"', agentVer: '0.6.1<&"', online: true },
      { id: 'plain-id', name: 'Builder', alias: '', os: 'windows', agentVer: '', online: false },
    ] };
    const copy = { fleet: 'Machines', empty: 'empty', online: 'online', offline: 'offline', agentVersion: 'Agent', setAlias: 'Set alias', editAlias: 'Edit alias' };
    function t(k) { return copy[k] || k; }
    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\"/g,"&quot;"); }
    ${html.slice(start, end)}
    return fleetView;
  `)();

  const out = fleetView();
  assert.match(out, /SG &lt;prod&gt; &amp; &quot;fast&quot;/);
  assert.match(out, /host&lt;&amp;&quot; · id&lt;&amp;&quot; · linux&lt;&amp;&quot; · Agent 0\.6\.1&lt;&amp;&quot;/);
  assert.match(out, /data-alias-device="id&lt;&amp;&quot;"/);
  assert.match(out, />Edit alias</);
  assert.match(out, />Builder</);
  assert.match(out, /plain-id · windows · Agent —/);
  assert.match(out, />Set alias</);
  assert.doesNotMatch(out, /SG <prod>/);
  assert.doesNotMatch(out, /host<&"/);
});

test("alias editor escapes catalog fields and supports save, clear, cancel, and inline errors", () => {
  const start = html.indexOf("function aliasPromptView()");
  const end = html.indexOf("function render()", start);
  assert.ok(start > 0 && end > start);
  const aliasPromptView = new Function(`
    const state = {
      computers: [{ id: 'id<&"', name: 'host<&"', alias: 'old<&"' }],
      aliasEditor: { deviceId: 'id<&"', value: 'new<&"', busy: false, error: 'bad<&"' },
    };
    const copy = { aliasTitle: 'Machine alias', originalName: 'Original name', deviceId: 'Device ID', aliasLabel: 'Alias', aliasPlaceholder: 'Alias here', aliasHint: 'hint', clearAlias: 'Clear', promptCancel: 'Cancel', savingAlias: 'Saving', saveAlias: 'Save' };
    function t(k) { return copy[k] || k; }
    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\"/g,"&quot;"); }
    ${html.slice(start, end)}
    return aliasPromptView;
  `)();

  const out = aliasPromptView();
  assert.match(out, /role="dialog"/);
  assert.match(out, /maxlength="64"/);
  assert.match(out, /value="new&lt;&amp;&quot;"/);
  assert.match(out, />host&lt;&amp;&quot;</);
  assert.match(out, />id&lt;&amp;&quot;</);
  assert.match(out, />bad&lt;&amp;&quot;</);
  assert.match(out, /data-alias-action="clear"/);
  assert.match(out, /data-alias-action="cancel"/);
  assert.match(out, /type="submit"/);
  assert.doesNotMatch(out, /host<&"|new<&"|bad<&"/);
});

test("alias save posts the stable contract and reloads the canonical machine list", async () => {
  const start = html.indexOf("async function loadComputers()");
  const end = html.indexOf("async function boot()", start);
  assert.ok(start > 0 && end > start);
  const runtime = new Function(`
    const calls = [];
    const state = {
      computers: [{ id: 'device-a', name: 'host-a', alias: '' }],
      aliasEditor: { deviceId: 'device-a', value: '', busy: false, error: '' },
    };
    async function api(path, options) {
      calls.push({ path, options });
      if (path === '/v1/set_computer_alias') return { ok: true, device_id: 'device-a', alias: 'SG box' };
      return { computers: [{ id: 'device-a', name: 'host-a', alias: 'SG box', agentVer: '0.6.1' }] };
    }
    function render() {}
    function t(k) { return k; }
    function $(selector) { return null; }
    function requestAnimationFrame(fn) { fn(); }
    ${html.slice(start, end)}
    return { calls, state, saveComputerAlias };
  `)();

  await runtime.saveComputerAlias("  SG box  ");
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0].path, "/v1/set_computer_alias");
  assert.deepEqual(JSON.parse(runtime.calls[0].options.body), {
    device_id: "device-a",
    alias: "SG box",
  });
  assert.equal(runtime.calls[1].path, "/v1/list_computers");
  assert.equal(runtime.state.computers[0].alias, "SG box");
  assert.equal(runtime.state.computers[0].agentVer, "0.6.1");
  assert.equal(runtime.state.aliasEditor, null);

  runtime.state.aliasEditor = { deviceId: "device-a", value: "SG box", busy: false, error: "" };
  await runtime.saveComputerAlias("");
  assert.deepEqual(JSON.parse(runtime.calls[2].options.body), {
    device_id: "device-a",
    alias: "",
  });
});

test("plugin page reads the pinned public registry without exposing artifact URLs", () => {
  assert.match(pluginRegistry.source.repository, /TITOCHAN2023\/fleet-plugins/);
  assert.match(pluginRegistry.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(pluginRegistry.plugins[0].id, "fleet.acp");
  assert.equal(pluginRegistry.plugins[0].artifacts, undefined);
  assert.ok(pluginRegistry.plugins[0].platforms.length > 0);
});

test("tokenless Settings configs stay copyable and omit every token field", () => {
  const start = html.indexOf("function copyBlock");
  const end = html.indexOf("function promptView", start);
  assert.ok(start > 0 && end > start);
  const setup = new Function(`
    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\"/g,"&quot;"); }
    function t(k) { return k; }
    ${html.slice(start, end)}
    return readySetup;
  `)();

  const tokenless = setup("https://fleet.ginfo.cc", "");
  assert.match(tokenless, /fleet-tool\.tgz/);
  assert.match(tokenless, /&quot;type&quot;: &quot;http&quot;/);
  assert.match(tokenless, /https:\/\/fleet\.ginfo\.cc\/mcp/);
  assert.match(tokenless, /\/mcp\/sse/);
  assert.match(tokenless, /install\.sh/);
  assert.match(tokenless, /install\.ps1/);
  assert.doesNotMatch(tokenless, /FLEET_TOKEN|Authorization|--token|-Token/);

  const complete = setup("https://fleet.ginfo.cc", "flt_1.demo");
  assert.match(complete, /FLEET_TOKEN/);
  assert.match(complete, /Authorization/);
  assert.match(complete, /mcpHttpConfig/);
  assert.match(complete, /--token/);
  assert.match(complete, /-Token/);
});

test("landing pairs Help with Google and Docs with X", () => {
  const homeView = html.slice(html.indexOf("function homeView()"), html.indexOf("function pickBlog"));
  assert.match(html, /class="login-actions"/);
  assert.match(html, /class="btn primary" href="\/v1\/auth\/google"/);
  assert.match(html, /class="btn" href="\/v1\/auth\/x"/);
  assert.match(html, /href="\/help" data-go="\/help">\$\{t\("help"\)\} <span aria-hidden="true">→<\/span>/);
  assert.match(html, /href="\/docs" data-go="\/docs">\$\{t\("docs"\)\} <span aria-hidden="true">→<\/span>/);
  assert.match(html, /hero: "One tool for every computer anywhere\."/);
  assert.match(html, /class="lead hand-copy">\$\{t\("body"\)\}/);
  assert.match(html, /Excalifont-Latin\.woff2/);
  assert.match(html, /@chinese-fonts\/xiaolai@3\.0\.0/);
  assert.match(html, /font-family: "Xiaolai SC"/);
  assert.doesNotMatch(homeView, /class="kicker"/);
  assert.doesNotMatch(html, /class="login-panel"/);
  assert.doesNotMatch(html, /provider-mark/);
});

test("blog Mermaid diagrams load lazily and fail closed", () => {
  assert.match(html, /\.blog-prose \.blog-mermaid/);
  assert.match(html, /querySelectorAll\("\.blog-mermaid"\)/);
  assert.match(html, /script\.src = "\/mermaid\.min\.js"/);
  assert.match(html, /securityLevel: "strict"/);
  assert.match(html, /suppressErrorRendering: true/);
  assert.match(html, /theme: "base"/);
  assert.match(html, /htmlLabels: true/);
  assert.match(html, /themeVariables:/);
  assert.match(html, /foreignObject > div/);
  assert.match(html, /class="blog-cta"/);
  assert.match(html, /class="subtle hand-copy"/);
  assert.match(html, /class="lead hand-copy"/);
  assert.match(html, /class="btn primary" href="\/" data-go="\/"/);
  assert.match(html, /docsTryAction: "Try Fleet"/);
  assert.match(html, /void renderBlogMermaid\(\)/);
  assert.match(html, /block\.innerHTML = fallback/);
  const runtime = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "public/mermaid.min.js"),
  );
  assert.ok(runtime.byteLength > 1_000_000);
  const handFont = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "public/fonts/Excalifont-Latin.woff2"),
  );
  assert.ok(handFont.byteLength > 20_000);
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(inlineScripts.at(-1)?.[1] || ""));
});
