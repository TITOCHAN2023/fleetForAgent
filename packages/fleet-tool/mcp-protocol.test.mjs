import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_STREAMABLE_PROTOCOL_VERSION,
  McpRpcSession,
  McpStdioCallManager,
  isInitializeMessage,
  isMcpActivity,
  negotiateStreamableProtocolVersion,
} from "./mcp-protocol.mjs";
import { createOperator, wrapTransportRpc } from "./operator.mjs";

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
    rpc: async (path, body) => {
      if (path === "/v1/get_computer") {
        return { id: body.device_id, alias: "", online: true };
      }
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
    if (path === "/v1/get_computer") {
      return { id: body.device_id, alias: "", online: true };
    }
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

test("stdio EOF closes the start gate, cancels and joins calls before manager shutdown", async () => {
  const order = [];
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = new McpStdioCallManager({
    shutdown: async () => { order.push("shutdown"); },
  });
  const running = calls.run(async (signal) => {
    order.push("call-started");
    await gate;
    assert.equal(signal.aborted, true);
    order.push("call-finished");
    return "late result";
  });
  const reply = running.then((value) => calls.write(() => writes.push(value)));

  const closing = calls.close();
  assert.equal(calls.closing, true);
  assert.equal(calls.controller.signal.aborted, true);
  assert.throws(() => calls.run(async () => {}), (error) => error?.code === "mcp_closing");
  assert.deepEqual(order, ["call-started"]);
  release();

  await closing;
  await reply;
  assert.deepEqual(order, ["call-started", "call-finished", "shutdown"]);
  assert.deepEqual(writes, [], "a completed background call wrote after stdin EOF");
  assert.equal(calls.pendingCalls.size, 0);
});

test("a call registered before EOF cannot fall outside the shutdown snapshot", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = new McpStdioCallManager({
    shutdown: async () => { order.push("shutdown"); },
  });
  const running = calls.run(async () => {
    await gate;
    order.push("late-start-section");
  });
  const closing = calls.close();
  release();
  await Promise.all([running, closing]);
  assert.deepEqual(order, ["late-start-section", "shutdown"]);
});

test("stdio EOF has a hard join boundary even when an RPC ignores cancellation forever", async () => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let rpcSignal;
  let shutdowns = 0;
  const operator = createOperator({
    rpc: async (_path, _body, options) => {
      rpcSignal = options?.signal;
      markStarted();
      return new Promise(() => {});
    },
  });
  const calls = new McpStdioCallManager({
    joinTimeoutMs: 0,
    shutdown: async () => { shutdowns += 1; },
  });
  void calls.run((signal) => operator.callTool("list_computers", {}, { signal })).catch(() => {});
  await started;

  await calls.close();

  assert.equal(rpcSignal.aborted, true);
  assert.equal(shutdowns, 1);
  assert.equal(calls.closing, true);
});

test("stdio request cancellation aborts only the matching Hub RPC", async () => {
  const signals = new Map();
  const started = [];
  const operator = createOperator({
    rpc: async (_path, body, options) => {
      const key = body.device_id;
      signals.set(key, options.signal);
      started.push(key);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason || new Error("cancelled")),
          { once: true },
        );
      });
    },
  });
  const calls = new McpStdioCallManager();
  const first = calls.run(
    (signal) => operator.callTool("get_computer", { device_id: "device-a" }, { signal }),
    { key: "request-a" },
  );
  const second = calls.run(
    (signal) => operator.callTool("get_computer", { device_id: "device-b" }, { signal }),
    { key: "request-b" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["device-a", "device-b"]);
  assert.equal(calls.cancel("request-a"), true);
  await assert.rejects(() => first, (error) => error?.code === "mcp_cancelled");
  assert.equal(signals.get("device-a").aborted, true);
  assert.equal(signals.get("device-b").aborted, false);
  assert.equal(calls.cancel("missing"), false);
  calls.cancel("request-b");
  await assert.rejects(() => second, (error) => error?.code === "mcp_cancelled");
  await calls.close();
});

test("stdio EOF also has a hard boundary around a shutdown hook that never settles", async () => {
  const calls = new McpStdioCallManager({
    joinTimeoutMs: 0,
    shutdownTimeoutMs: 0,
    shutdown: async () => new Promise(() => {}),
  });
  await calls.close();
  assert.equal(calls.closing, true);
});
