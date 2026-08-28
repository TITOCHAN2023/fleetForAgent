import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_STREAMABLE_PROTOCOL_VERSION,
  McpRpcSession,
  isInitializeMessage,
  isMcpActivity,
  negotiateStreamableProtocolVersion,
} from "./mcp-protocol.mjs";
import { wrapTransportRpc } from "./operator.mjs";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

test("Streamable HTTP negotiates the client's supported protocol version", async () => {
  assert.equal(isInitializeMessage(initialize), true);
  assert.equal(negotiateStreamableProtocolVersion(initialize), "2025-06-18");
  assert.equal(
    negotiateStreamableProtocolVersion({ ...initialize, params: { protocolVersion: "2099-01-01" } }),
    MCP_STREAMABLE_PROTOCOL_VERSION,
  );

  let authChecks = 0;
  const session = new McpRpcSession({
    rpc: async () => ({}),
    protocolVersion: negotiateStreamableProtocolVersion(initialize),
  });
  const response = await session.dispatch(initialize, async () => { authChecks += 1; });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(response.result.serverInfo.name, "fleet");
  assert.equal(authChecks, 1);
});

test("the shared protocol returns Fleet tools as direct JSON-RPC", async () => {
  const session = new McpRpcSession({ rpc: async () => ({ computers: [] }) });
  const response = await session.dispatch({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
  assert.equal(response.id, "tools");
  assert.equal(response.result.tools[0].name, "list_computers");
});

test("shared MCP protocol exposes per-result transport only in _meta", async () => {
  const session = new McpRpcSession({
    rpc: async (path) => {
      assert.equal(path, "/v1/run");
      return wrapTransportRpc({ corr: "c-rtc", status: "running" }, "rtc");
    },
  });
  const response = await session.dispatch({
    jsonrpc: "2.0",
    id: "run",
    method: "tools/call",
    params: {
      name: "run",
      arguments: { device_id: "box-a", command: "pwd", wait_ms: 0 },
    },
  });
  assert.deepEqual(response.result._meta, { fleet_transport: "rtc" });
  assert.equal(response.result.content[0].text, "still running");
});

test("Streamable HTTP can restore process-local device selection after DO eviction", async () => {
  const calls = [];
  const rpc = async (path, body) => {
    calls.push({ path, body: { ...body } });
    if (path === "/v1/run") return { corr: "job-a", status: "running" };
    if (path === "/v1/get_result") return { corr: body.corr, status: "pending" };
    return {};
  };
  const first = new McpRpcSession({ rpc });
  const selected = await first.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "set_computer", arguments: { device_id: "box-a" } },
  });
  assert.equal(JSON.parse(selected.result.content[0].text).device_id, "box-a");
  assert.equal(first.getState().lastUsed, "box-a");
  await first.dispatch({
    jsonrpc: "2.0",
    id: "run",
    method: "tools/call",
    params: { name: "run", arguments: { command: "sleep 1", wait_ms: 0 } },
  });
  assert.equal(first.getState().corrByDevice["box-a"], "job-a");

  const restored = new McpRpcSession({ rpc, state: first.getState() });
  const current = await restored.dispatch({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_current_computer", arguments: {} },
  });
  assert.equal(JSON.parse(current.result.content[0].text).device_id, "box-a");
  await restored.dispatch({
    jsonrpc: "2.0",
    id: "result",
    method: "tools/call",
    params: { name: "get_result", arguments: {} },
  });
  assert.equal(calls.at(-1).path, "/v1/get_result");
  assert.equal(calls.at(-1).body.corr, "job-a");
});

test("only meaningful MCP methods refresh idle activity", () => {
  assert.equal(isMcpActivity("tools/list"), true);
  assert.equal(isMcpActivity("ping"), false);
  assert.equal(isMcpActivity("notifications/initialized"), false);
});
