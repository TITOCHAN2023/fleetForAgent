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
});

test("classic SSE remains a separate endpoint", () => {
  assert.match(worker, /if \(path === "\/mcp\/sse"\)/);
  assert.match(worker, /dispatchMcpSse/);
  assert.match(worker, /sessionId = url\.searchParams\.get\("sessionId"\)/);
});
