import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_SESSION_IDLE_MS,
  McpSseSession,
  isJsonRpcMessage,
  isMcpSessionExpired,
} from "./src/mcp-sse.mjs";
import { wrapTransportRpc } from "../fleet-tool/operator.mjs";

async function readEvent(reader) {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  return new TextDecoder().decode(chunk.value);
}

test("Worker MCP SSE exposes a token-free endpoint and initializes", async () => {
  const calls = [];
  const session = new McpSseSession({
    rpc: async (path, body) => {
      calls.push([path, body]);
      return { computers: [] };
    },
  });
  const response = session.open("session-secret");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const reader = response.body.getReader();
  const endpoint = await readEvent(reader);
  assert.equal(endpoint, "event: endpoint\ndata: /mcp/sse?sessionId=session-secret\n\n");
  assert.doesNotMatch(endpoint, /flt_|token/i);

  await session.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const initialized = await readEvent(reader);
  const payload = JSON.parse(initialized.match(/data: (.+)\n\n$/)[1]);
  assert.equal(payload.result.protocolVersion, "2024-11-05");
  assert.equal(payload.result.serverInfo.name, "fleet");
  assert.deepEqual(calls, []);
  await reader.cancel();
});

test("Worker MCP SSE lists shared tools and checks session authorization", async () => {
  let authChecks = 0;
  const session = new McpSseSession({ rpc: async () => ({ computers: [] }) });
  const reader = session.open("tools").body.getReader();
  await readEvent(reader);
  await session.dispatch(
    { jsonrpc: "2.0", id: "tools", method: "tools/list" },
    async () => { authChecks += 1; },
  );
  const event = await readEvent(reader);
  const payload = JSON.parse(event.match(/data: (.+)\n\n$/)[1]);
  assert.equal(payload.result.tools[0].name, "list_computers");
  assert.equal(authChecks, 1);
  await reader.cancel();
});

test("Worker MCP SSE exposes WSS provenance in result metadata", async () => {
  const session = new McpSseSession({
    rpc: async (path) => {
      if (path === "/v1/get_computer") {
        return { id: "box-a", name: "box-a", os: "linux", online: true };
      }
      assert.equal(path, "/v1/run");
      return wrapTransportRpc({ corr: "c-ws", status: "running" }, "ws");
    },
  });
  const reader = session.open("transport").body.getReader();
  await readEvent(reader);
  await session.dispatch({
    jsonrpc: "2.0",
    id: "run",
    method: "tools/call",
    params: {
      name: "run",
      arguments: { device_id: "box-a", command: "pwd", wait_ms: 0 },
    },
  });
  const event = await readEvent(reader);
  const payload = JSON.parse(event.match(/data: (.+)\n\n$/)[1]);
  assert.deepEqual(payload.result._meta, { fleet_transport: "ws" });
  assert.equal(payload.result.content[0].text, "still running");
  await reader.cancel();
});

test("Worker MCP SSE reports revoked sessions as JSON-RPC errors", async () => {
  const session = new McpSseSession({ rpc: async () => ({ computers: [] }) });
  const reader = session.open("revoked").body.getReader();
  await readEvent(reader);
  await session.dispatch(
    { jsonrpc: "2.0", id: 7, method: "ping" },
    async () => { throw new Error("Hub token was reset"); },
  );
  const event = await readEvent(reader);
  const payload = JSON.parse(event.match(/data: (.+)\n\n$/)[1]);
  assert.equal(payload.id, 7);
  assert.equal(payload.error.code, -32000);
  assert.match(payload.error.message, /reset/);
  await reader.cancel();
});

test("Worker MCP SSE rejects non-object JSON-RPC payloads", () => {
  assert.equal(isJsonRpcMessage(null), false);
  assert.equal(isJsonRpcMessage([]), false);
  assert.equal(isJsonRpcMessage("ping"), false);
  assert.equal(isJsonRpcMessage({ method: "ping" }), true);
});

test("closed Worker MCP SSE sessions cannot dispatch more work", async () => {
  let authChecks = 0;
  const session = new McpSseSession({ rpc: async () => ({ computers: [] }) });
  const reader = session.open("closed").body.getReader();
  await readEvent(reader);
  await reader.cancel();
  await session.dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    async () => { authChecks += 1; },
  );
  assert.equal(session.closed, true);
  assert.equal(authChecks, 0);
});

test("Worker MCP SSE expires idle sessions without treating protocol pings as work", async () => {
  let now = 1_000;
  const session = new McpSseSession({
    rpc: async () => ({}),
    now: () => now,
    keepaliveMs: 60_000,
  });
  const reader = session.open("idle").body.getReader();
  await readEvent(reader);
  await session.dispatch({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(session.lastActivityAt, 1_000);
  now += MCP_SESSION_IDLE_MS;
  assert.equal(isMcpSessionExpired({
    now,
    expiresAt: session.expiresAt,
    lastActivityAt: session.lastActivityAt,
    idleMs: session.idleMs,
  }), true);
  await reader.cancel();
});

test("meaningful MCP work refreshes the idle deadline", async () => {
  let now = 1_000;
  const session = new McpSseSession({ rpc: async () => ({}), now: () => now });
  const reader = session.open("active").body.getReader();
  await readEvent(reader);
  now += 5_000;
  await session.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(session.lastActivityAt, now);
  await readEvent(reader);
  await reader.cancel();
});
