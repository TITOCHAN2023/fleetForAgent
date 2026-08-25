import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHttpHandler, type Operator } from "./mcp-http.server";

function fakeOperator(): Operator {
  let selected: string | null = null;
  return {
    tools: [{ name: "list_computers", inputSchema: { type: "object" } }],
    prompts: [],
    getPrompt: () => null,
    callTool: async (name, args) => {
      if (name === "set_computer") {
        selected = String(args.device_id || "");
        return { ok: true, device_id: selected };
      }
      if (name === "get_current_computer") return { device_id: selected };
      return { computers: [] };
    },
  };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

test("Streamable HTTP initializes inline and returns Mcp-Session-Id", async () => {
  let authorization = "";
  const handle = createMcpHttpHandler({
    authenticate: async (request) => {
      authorization = request.headers.get("authorization") || "";
      return fakeOperator();
    },
  });
  const response = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    headers: { authorization: "Bearer flt_1.secret", "content-type": "application/json" },
    body: JSON.stringify(initialize),
  }));
  assert.equal(response.status, 200);
  assert.equal(authorization, "Bearer flt_1.secret");
  assert.match(response.headers.get("mcp-session-id") || "", /^[0-9a-f-]{36}$/);
  const payload = await response.json() as {
    result: { protocolVersion: string; serverInfo: { name: string } };
  };
  assert.equal(payload.result.protocolVersion, "2025-06-18");
  assert.equal(payload.result.serverInfo.name, "fleet");
});

test("Streamable HTTP uses one endpoint for later JSON-RPC and DELETE", async () => {
  const handle = createMcpHttpHandler({ authenticate: async () => fakeOperator() });
  const opened = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    body: JSON.stringify(initialize),
  }));
  const sessionId = opened.headers.get("mcp-session-id") || "";
  const listed = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    headers: { "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }));
  assert.equal(listed.status, 200);
  const payload = await listed.json() as { result: { tools: Array<{ name: string }> } };
  assert.equal(payload.result.tools[0].name, "list_computers");

  const closed = await handle(new Request("https://fleet.example/mcp", {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  }));
  assert.equal(closed.status, 204);
  const missing = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    headers: { "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
  }));
  assert.equal(missing.status, 404);
});

test("Streamable HTTP rejects non-initialize starts and cross-origin browsers", async () => {
  let authenticated = false;
  const handle = createMcpHttpHandler({
    authenticate: async () => {
      authenticated = true;
      return fakeOperator();
    },
  });
  const wrongStart = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  assert.equal(wrongStart.status, 400);
  assert.equal(authenticated, false);

  const crossOrigin = await handle(new Request("https://fleet.example/mcp", {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: JSON.stringify(initialize),
  }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(authenticated, false);
});
