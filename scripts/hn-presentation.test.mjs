import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const publicRoot = "packages/fleet-worker/public/";

test("demo is a bilingual static walkthrough with no control or credential entry points", () => {
  const html = read(publicRoot + "demo/index.html");
  const script = read(publicRoot + "info.js");
  assert.match(html, /fictional data/);
  assert.match(html, /虚构数据/);
  assert.match(html, /data-language="en"/);
  assert.match(html, /data-language="zh" hidden/);
  assert.match(html, /demo-linux/);
  assert.match(html, /demo-task-001/);
  assert.doesNotMatch(html, /<form|<input|\/v1\/|\/mcp|data-go=/);
  assert.doesNotMatch(script, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie/);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /fleet-locale/);
  assert.match(script, /fleet-theme/);
  for (const path of [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1])) {
    if (path === "/" || path === "/help" || path === "/plugins" || path === "/trust") continue;
    assert.ok(existsSync(new URL("../" + publicRoot + path.slice(1) + (path.endsWith("/") ? "index.html" : ""), import.meta.url)), path);
  }
});

test("privacy distinguishes short result TTLs from permanent account data and leader history", () => {
  const html = read(publicRoot + "privacy/index.html");
  for (const phrase of ["15 minutes", "5 minutes", "24 hours", "Separate persistent records", "Leader machine only", "15 分钟", "5 分钟", "24 小时"]) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /physical deletion/);
  assert.match(html, /SECURITY\.md/);
  assert.match(html, /does not mean a container/);
});

test("product naming does not rename compatibility binary paths or Room AI participants", () => {
  const html = read(publicRoot + "index.html");
  const messages = read("src/lib/i18n/messages.ts");
  const room = read("src/components/room-console.tsx");
  for (const text of [html, messages]) {
    assert.match(text, /Fleet Sandbox 插件/);
    assert.match(text, /Fleet Sandbox plugin/);
    assert.doesNotMatch(text, /fleet-Sandbox|FleetSandbox-windows|Local is a CLI|本地只是命令行/);
  }
  assert.match(html, /FleetAgent-windows-amd64\.exe/);
  assert.match(messages, /~\/\.fleet-agent\/config\.json/);
  assert.match(room, /Fleet Agent · AI/);
  assert.match(read("README.md"), /Session ID is not a credential/);
});

test("demo typography and controls reuse the Hub visual contract", () => {
  const css = read(publicRoot + "info.css");
  assert.doesNotMatch(css, /https?:/);
  const home = read(publicRoot + "index.html");
  for (const page of ["demo/index.html", "privacy/index.html"]) {
    const html = read(publicRoot + page);
    assert.match(html, /href="\/hub-ui\.css"/);
    assert.match(html, /class="fleet-top"/);
    assert.match(html, /data-theme-set="system"/);
    assert.ok(html.indexOf('aria-label="Theme"') < html.indexOf('aria-label="Language"'));
    const fontSheet = html.match(/href="(https:\/\/cdn\.jsdelivr\.net[^"]+)"/)?.[1];
    assert.ok(fontSheet && home.includes(fontSheet), "same Chinese font provider as the existing Hub");
  }
  assert.match(css, /Xiaolai SC/);
  for (const match of css.matchAll(/url\('([^']+)'\)/g)) {
    assert.ok(existsSync(new URL("../" + publicRoot + match[1].slice(1), import.meta.url)), match[1]);
  }
});
