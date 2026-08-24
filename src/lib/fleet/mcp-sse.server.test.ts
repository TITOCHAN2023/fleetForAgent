import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpSseHandler, createSessionCorrTracker } from "./mcp-sse.server";

function fakeOperator() {
  return {
    tools: [{ name: "list_computers", inputSchema: { type: "object" } }],
    prompts: [{ name: "hub_token" }],
    getPrompt: (name: string) => (name === "hub_token" ? { description: "token" } : null),
    callTool: async (name: string) => {
      if (name !== "list_computers") throw new Error(`unknown tool ${name}`);
      return { computers: [] };
    },
  };
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  return new TextDecoder().decode(chunk.value);
}

function endpointFrom(event: string) {
  const match = event.match(/^event: endpoint\ndata: ([^\n]+)\n\n$/);
  assert.ok(match, event);
  return match[1];
}

test("MCP SSE announces a token-free message endpoint and handles initialize", async () => {
  let authorization = "";
  const handle = createMcpSseHandler({
    authenticate: async (request) => {
      authorization = request.headers.get("authorization") || "";
      return fakeOperator();
    },
  });
  const response = await handle(
    new Request("https://fleet.example/mcp/sse", {
      headers: { authorization: "Bearer flt_1.secret" },
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  assert.equal(authorization, "Bearer flt_1.secret");

  const reader = response.body!.getReader();
  const endpoint = endpointFrom(await readEvent(reader));
  assert.match(endpoint, /^\/mcp\/sse\?sessionId=[0-9a-f-]+$/);
  assert.doesNotMatch(endpoint, /flt_|token/i);

  const post = await handle(
    new Request(`https://fleet.example${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
    }),
  );
  assert.equal(post.status, 202);
  const initialized = await readEvent(reader);
  assert.match(initialized, /^event: message\n/);
  const payload = JSON.parse(initialized.match(/data: (.+)\n\n$/)![1]);
  assert.equal(payload.id, 1);
  assert.equal(payload.result.serverInfo.name, "fleet");
  assert.equal(payload.result.protocolVersion, "2024-11-05");
  await reader.cancel();
});

test("MCP SSE returns the shared Fleet tools over JSON-RPC", async () => {
  const handle = createMcpSseHandler({ authenticate: async () => fakeOperator() });
  const response = await handle(new Request("https://fleet.example/mcp/sse"));
  const reader = response.body!.getReader();
  const endpoint = endpointFrom(await readEvent(reader));

  const post = await handle(
    new Request(`https://fleet.example${endpoint}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    }),
  );
  assert.equal(post.status, 202);
  const event = await readEvent(reader);
  const payload = JSON.parse(event.match(/data: (.+)\n\n$/)![1]);
  assert.equal(payload.result.tools[0].name, "list_computers");
  await reader.cancel();
});

test("MCP SSE rejects cross-origin browser requests before authentication", async () => {
  let called = false;
  const handle = createMcpSseHandler({
    authenticate: async () => {
      called = true;
      return fakeOperator();
    },
  });
  const response = await handle(
    new Request("https://fleet.example/mcp/sse", {
      headers: { origin: "https://evil.example" },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("MCP SSE returns 401 when the Hub token cannot be authenticated", async () => {
  const handle = createMcpSseHandler({
    authenticate: async () => {
      throw new Error("bad token");
    },
  });
  const response = await handle(new Request("https://fleet.example/mcp/sse"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "bad token" });
});

test("each SSE session carries its own run corr into pane operations", () => {
  const first = createSessionCorrTracker();
  const second = createSessionCorrTracker();
  first.remember("/v1/run", { device_id: "box-a" }, { corr: "job-1" });

  assert.deepEqual(first.prepare("/v1/get_result", { device_id: "box-a" }), {
    device_id: "box-a",
    corr: "job-1",
  });
  assert.deepEqual(first.prepare("/v1/read_screen", { device_id: "box-a" }), {
    device_id: "box-a",
    corr: "job-1",
  });
  assert.deepEqual(first.prepare("/v1/type", { device_id: "box-a", keys: "x" }), {
    device_id: "box-a",
    keys: "x",
    corr: "job-1",
  });
  assert.deepEqual(second.prepare("/v1/get_result", { device_id: "box-a" }), {
    device_id: "box-a",
  });
});
