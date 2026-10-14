// Actual workerd/SQLite integration. No Cloudflare account, production token,
// device process or remote service is used. The WebSocket peer is a fixture.
// Bundle first with the locked Wrangler: deploy --dry-run --config wrangler.toml.
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare, convertV4MiniflareOptions } from "../../packages/fleet-worker/node_modules/miniflare/dist/src/index.js";
import { build } from "../../packages/fleet-worker/node_modules/esbuild/lib/main.js";
import { inspectTokenV1 } from "../../packages/fleet-worker/src/tokenv1.mjs";

const root = mkdtempSync(join(tmpdir(), "fleet-runtime-worker-"));
const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise((done) => socket.close(done));
const url = `http://127.0.0.1:${port}`;
const scriptPath = resolve(process.argv[2] || "/tmp/fleet-bounds-worker-bundle/worker.js");
const sseBundle = await build({
  stdin: { contents: `
    import { McpSseSession, MCP_SSE_QUEUE_BYTES } from "./packages/fleet-worker/src/mcp-sse.mjs";
    export default { async fetch() {
      const stalled = new McpSseSession({rpc: async () => ({})});
      const response = stalled.open("stalled");
      let frames = 0;
      while (!stalled.closed && frames < 100) {
        stalled.write({jsonrpc:"2.0",id:frames++,result:"x".repeat(256 * 1024)});
      }
      let failedRead = false;
      try { await response.body.getReader().read(); } catch { failedRead = true; }
      const flowing = new McpSseSession({rpc: async () => ({})});
      const reader = flowing.open("flowing").body.getReader();
      await reader.read();
      let bytes = 0;
      for (let i = 0; i < 64; i++) {
        flowing.write({jsonrpc:"2.0",id:i,result:"x".repeat(256 * 1024)});
        const frame = await reader.read();
        if (frame.done) throw new Error("normal reader disconnected");
        bytes += frame.value.byteLength;
      }
      const normalOpen = !flowing.closed;
      await reader.cancel();
      stalled.close();
      return Response.json({limit:MCP_SSE_QUEUE_BYTES,frames,closed:stalled.closed,
        timerCleared:stalled.timer === null,failedRead,normalOpen,bytes});
    }};`, resolveDir: process.cwd(), sourcefile: "sse-workerd-check.mjs" },
  bundle: true, format: "esm", platform: "browser", write: false,
});
const names = { FLEET: "FleetDO", DEVICE: "DeviceDO", MCP: "McpDO", PEER_SESSION: "PeerSessionDO", REVOCATION: "RevocationDO", ROOM_RELAY: "RoomRelayDO" };
const mf = new Miniflare(convertV4MiniflareOptions({ host: "127.0.0.1", port, durableObjectsPersist: join(root, "do"), workers: [
  { name: "fleet-runtime-test", modules: true, modulesRoot: dirname(scriptPath), scriptPath, compatibilityDate: "2026-04-07",
    bindings: { HUB_ORIGIN: url }, durableObjects: Object.fromEntries(Object.entries(names).map(([key, className]) => [key, { className, useSQLite: true }])) },
  { name: "sse-runtime-test", modules: true, script: sseBundle.outputFiles[0].text, compatibilityDate: "2026-04-07" },
] }));
let peer;
try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace("FLEET");
  const fleet = namespace.get(namespace.idFromName("fleet"));
  async function account(email) {
    const login = await fleet.fetch("https://fleet/oauth", { method: "POST", body: JSON.stringify({ email, provider: "local-test" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { id } = await login.json();
    const minted = await fetch(url + "/v1/hub_token", { method: "POST", headers: { cookie, origin: url } });
    assert.equal(minted.status, 200);
    return { id, cookie, ...(await minted.json()) };
  }
  const owner = await account("bounds@example.test");
  const other = await account("other@example.test");
  const kid = inspectTokenV1(owner.token).kid;
  const devices = await mf.getDurableObjectNamespace("DEVICE");
  const device = devices.get(devices.idFromName("bounds-device"));
  const connection = await device.fetch("https://device/ws", { headers: {
    Upgrade: "websocket", "x-device-id": "bounds-device", "x-fleet-user": owner.id, "x-fleet-kid": kid,
  } });
  assert.equal(connection.status, 101);
  peer = connection.webSocket;
  const received = [];
  peer.addEventListener("message", (event) => received.push(JSON.parse(event.data)));
  peer.accept();
  const headers = { "X-Fleet-Operator": "operator-a", "content-type": "application/json" };
  const run = await device.fetch("https://device/run", { method: "POST", headers, body: JSON.stringify({ command: "fixture only; not executed", wait_ms: 0 }) });
  assert.equal(run.status, 200);
  const { corr } = await run.json();
  const resultUrl = `https://device/result?corr=${encodeURIComponent(corr)}&wait_ms=5000`;
  const pending = Array.from({ length: 16 }, () => device.fetch(resultUrl, { headers }).then((res) => res.json()));
  await delay(100);
  const foreign = await device.fetch(resultUrl, { headers: { "X-Fleet-Operator": "operator-b" } });
  assert.deepEqual(await foreign.json(), { status: "pending" });
  peer.send(JSON.stringify({ v: 1, type: "result", id: "fixture-result", t: Date.now(), corr,
    body: { exit_code: 0, stdout: "owned-result", stderr: "", status: "done" } }));
  const results = await Promise.all(pending);
  for (const result of results) {
    assert.equal(result.stdout, "owned-result");
    assert.equal(result.status, "done");
    assert.equal(result.corr, corr);
  }
  assert.equal(received.filter((msg) => msg.type === "run").length, 1);
  const stored = await device.fetch(resultUrl, { headers });
  assert.equal((await stored.json()).stdout, "owned-result");

  async function setAlias(id, alias, userId = owner.id) {
    return fleet.fetch("https://fleet/set-alias", { method: "POST", body: JSON.stringify({ user_id: userId, device_id: id, alias }) });
  }
  const alias = await setAlias("bounds-device", "Lab 主机");
  assert.equal(alias.status, 200, await alias.text());
  const resolved = await fleet.fetch(`https://fleet/resolve-device?user=${owner.id}&ref=${encodeURIComponent("Lab 主机")}`);
  assert.equal((await resolved.json()).id, "bounds-device");
  assert.equal((await setAlias("bounds-device", "stolen", other.id)).status, 404);
  assert.equal((await fleet.fetch(`https://fleet/resolve-device?user=${other.id}&ref=${encodeURIComponent("Lab 主机")}`)).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await fleet.fetch(`https://fleet/resolve-device?user=${owner.id}&ref=missing`)).status, 404);
  await fleet.fetch("https://fleet/upsert", { method: "POST", body: JSON.stringify({ id: "bounds-device-2", userId: owner.id, online: false, lastSeen: Date.now() }) });
  const collision = await setAlias("bounds-device-2", "lab 主机");
  assert.equal(collision.status, 409, await collision.text());
  assert.equal((await setAlias("bounds-device", "Renamed")).status, 200);
  assert.equal((await fleet.fetch(`https://fleet/resolve-device?user=${owner.id}&ref=${encodeURIComponent("Lab 主机")}`)).status, 404);
  assert.equal((await fleet.fetch(`https://fleet/resolve-device?user=${owner.id}&ref=renamed`)).status, 200);
  console.log(JSON.stringify({ runtime: "workerd", storage: "SQLite Durable Objects", waiters: results.length, runEnvelopes: 1, isolation: "pass", aliasTransactions: "pass" }));
  const mcpNamespace = await mf.getDurableObjectNamespace("MCP");
  const mcp = mcpNamespace.get(mcpNamespace.idFromName("bounds-sse"));
  const opened = await mcp.fetch("https://mcp/open?sessionId=bounds-sse", { headers: {
    "x-fleet-actor": owner.id, "x-fleet-kid": kid,
  } });
  assert.equal(opened.status, 200);
  const mcpReader = opened.body.getReader();
  try {
    const endpoint = new TextDecoder().decode((await mcpReader.read()).value);
    assert.match(endpoint, /event: endpoint/);
    const initialize = await mcp.fetch("https://mcp/message", { method: "POST", body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-workerd-test", version: "1" },
      },
    }) });
    assert.equal(initialize.status, 202);
    const frame = new TextDecoder().decode((await mcpReader.read()).value);
    assert.match(frame, /event: message/);
    const response = JSON.parse(frame.match(/^data: (.+)$/m)[1]);
    assert.equal(response.id, 1);
    assert.ok(response.result.serverInfo);
    const ping = await mcp.fetch("https://mcp/message", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
    assert.equal(ping.status, 202);
    const pong = JSON.parse(new TextDecoder().decode((await mcpReader.read()).value).match(/^data: (.+)$/m)[1]);
    assert.deepEqual(pong, { jsonrpc: "2.0", id: 2, result: {} });
    console.log(JSON.stringify({ runtime: "workerd", mcpSseDO: "initialize and ping pass" }));
  } finally { await mcpReader.cancel(); }
  const sseWorker = await mf.getWorker("sse-runtime-test");
  const sse = await (await sseWorker.fetch("https://sse/check")).json();
  assert.equal(sse.limit, 8 * 1024 * 1024);
  assert.equal(sse.closed, true);
  assert.equal(sse.timerCleared, true);
  assert.equal(sse.failedRead, true);
  assert.ok(sse.frames <= 32);
  assert.equal(sse.normalOpen, true);
  assert.ok(sse.bytes > 16 * 1024 * 1024);
  console.log(JSON.stringify({ runtime: "workerd", sseComponent: sse }));
} finally {
  peer?.close();
  await mf.dispose();
  rmSync(root, { recursive: true, force: true });
}
