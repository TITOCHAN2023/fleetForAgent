import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(here, "src/index.ts"), "utf8");
const wrangler = readFileSync(join(here, "wrangler.toml"), "utf8");

test("Worker routes /mcp to Streamable HTTP before the asset fallback", () => {
  const http = worker.indexOf('if (path === "/mcp")');
  const assets = worker.indexOf("if (!hub)");
  assert.ok(http > 0 && http < assets);
  assert.match(wrangler, /run_worker_first = \[[^\]]*"\/mcp"/);
  assert.match(worker, /dispatchMcpHttp/);
  assert.match(worker, /Mcp-Session-Id/);
  assert.match(worker, /request\.headers\.get\("mcp-session-id"\)/);
});

test("Streamable HTTP reuses McpDO without a new migration and persists eviction-safe state", () => {
  assert.equal((wrangler.match(/new_sqlite_classes/g) || []).length, 2);
  assert.match(worker, /const MCP_HTTP_STORAGE_KEY = "http:session"/);
  assert.match(worker, /operatorState: McpOperatorState/);
  assert.match(worker, /this\.httpStored\.operatorState = this\.httpSession\.getState\(\)/);
  assert.match(worker, /isMcpSessionExpired/);
  assert.match(worker, /validate-mcp/);
  assert.match(worker, /wrapTransportRpc\(value, isDeviceTransportPath\(path\) \? "ws" : null\)/);
});

test("classic SSE remains a separate endpoint", () => {
  assert.match(worker, /if \(path === "\/mcp\/sse"\)/);
  assert.match(worker, /dispatchMcpSse/);
  assert.match(worker, /sessionId = url\.searchParams\.get\("sessionId"\)/);
});

test("RTC fallback keeps correlation ownership and token reset is fail-closed", () => {
  assert.match(worker, /parsed\.type === "rtc_claim"/);
  assert.match(worker, /this\.claimSession\(operatorId, parsed\.corr\)/);
  assert.match(worker, /rememberRtcDesktopResult/);
  assert.match(worker, /rtcDesktopResults = new Map/);
  assert.doesNotMatch(worker, /rtcres:\$\{parsed\.corr\}:desktop/);
  const reset = worker.slice(worker.indexOf("const revocation = await this.beginTokenRevocation"));
  assert.ok(reset.indexOf("kickUserDevices") < reset.indexOf("revokeToken"));
  assert.doesNotMatch(reset.slice(0, reset.indexOf("return json({ token:")), /Promise\.allSettled/);
});
