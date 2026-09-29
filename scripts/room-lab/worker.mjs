// Local workerd integration, no Cloudflare account or production credentials.
// First bundle: cd packages/fleet-worker && wrangler deploy --dry-run --outdir /tmp/fleet-room-worker-bundle
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "../../packages/fleet-worker/node_modules/miniflare/dist/src/index.js";
import { RoomRunner } from "../../packages/fleet-room/runner.mjs";
import { highSecAuthorization } from "../../packages/fleet-worker/src/tokenv1.mjs";
import { RoomConnection } from "../../packages/fleet-room/client.mjs";

const sock = net.createServer(); sock.listen(0, "127.0.0.1"); await once(sock, "listening");
const port = sock.address().port; await new Promise((r) => sock.close(r));
const url = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "fleet-room-worker-"));
const names = { FLEET: "FleetDO", DEVICE: "DeviceDO", MCP: "McpDO", PEER_SESSION: "PeerSessionDO", REVOCATION: "RevocationDO", ROOM_RELAY: "RoomRelayDO" };
const scriptPath = resolve(process.argv[2] || "/tmp/fleet-room-worker-bundle/worker.js");
const mf = new Miniflare(convertV4MiniflareOptions({ host: "127.0.0.1", port, workers: [{ name: "fleet-room-test", modules: true, modulesRoot: dirname(scriptPath), scriptPath, compatibilityDate: "2026-04-07",
  bindings: { HUB_ORIGIN: url }, durableObjects: Object.fromEntries(Object.entries(names).map(([k, className]) => [k, { className, useSQLite: true }])),
}] }));
let runner, observer;
try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace("FLEET");
  const fleet = namespace.get(namespace.idFromName("fleet"));
  async function account(email) {
    const login = await fleet.fetch("https://fleet/oauth", { method: "POST", body: JSON.stringify({ email, provider: "local-test" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { id } = await login.json();
    const minted = await fetch(url + "/v1/hub_token", { method: "POST", headers: { cookie } });
    assert.equal(minted.status, 200);
    return { id, cookie, ...(await minted.json()) };
  }
  const owner = await account("room-local@example.test");
  const other = await account("room-other@example.test");
  await fleet.fetch("https://fleet/upsert", { method: "POST", body: JSON.stringify({ id: "device-a", userId: owner.id, name: "Lab device", online: true, os: "linux", lastSeen: Date.now() }) });
  runner = new RoomRunner({ url, token: owner.token, id: "leader", leader: true, dataDir: join(root, "leader"), fleetHome: join(root, "sandbox"), cwd: root, command: process.execPath,
    args: [resolve("packages/fleet-room/tests/fixtures/acp-agent.mjs")], pollMs: 100 });
  await runner.start();
  observer = new RoomConnection({ url, token: owner.token, id: "reader" }); await observer.connect();
  async function control(action, input, cookie = owner.cookie) {
    const res = await fetch(url + "/v1/room-control", { method: "POST", headers: { cookie, origin: url }, body: JSON.stringify({ leaderId: "leader", action, input }) });
    return { status: res.status, body: await res.json() };
  }
  const created = await control("rooms.create", { id: "worker-room", leaderId: "leader", defaultDeviceId: "device-a" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await control("rooms.list", {}, other.cookie)).status, 503);
  assert.deepEqual((await (await fetch(url + "/v1/room-agents", { headers: { cookie: other.cookie } })).json()).agents, []);
  const sent = await control("messages.send", { roomId: "worker-room", discussionId: "main", requestId: "hello", expectedContextRev: 0, text: "仅组长保存" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await control("messages.read", { roomId: "worker-room", discussionId: "main" })).body.messages[0].text, "仅组长保存");
  const authorization = await highSecAuthorization(owner.token, url);
  const oaepRead = await fetch(url + "/v1/room-control", { method: "POST", headers: { authorization }, body: JSON.stringify({ leaderId: "leader", action: "rooms.list", input: {} }) });
  assert.equal(oaepRead.status, 200, await oaepRead.text());
  const crossOrigin = await fetch(url + "/v1/room-control", { method: "POST", headers: { cookie: owner.cookie, origin: "https://attacker.example" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);
  // Actual token rotation invalidates an already-established Room WebSocket.
  const reset = await fetch(url + "/v1/hub_token", { method: "POST", headers: { cookie: owner.cookie } });
  assert.equal(reset.status, 200);
  await assert.rejects(observer.call("", "directory", {}), { code: "DISCONNECTED" });
  console.log("PASS: real workerd account isolation, cookie Room writes, OAEP websocket, leader-local messages and live token revocation");
} finally {
  observer?.close(); await runner?.stop(); await mf.dispose(); rmSync(root, { recursive: true, force: true });
}
