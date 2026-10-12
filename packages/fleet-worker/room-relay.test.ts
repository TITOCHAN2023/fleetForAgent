import assert from "node:assert/strict";
import test from "node:test";
import worker from "./src/index.ts";
import { RoomRelayDO, readRoomBody } from "./src/room-relay.ts";

function environment(onRelay: (r: Request) => Promise<Response>, revoked = () => false) {
  const ids: string[] = [];
  let wraps = 0;
  const fleet = { fetch: async (r: Request) => {
    const path = new URL(r.url).pathname;
    if (path === "/resolve-wrap") return ++wraps > 1 || revoked() ? Response.json({ error: "revoked" }, { status: 401 }) : Response.json({ id: "account-a", kid: "kid-a" });
    if (path === "/list") return Response.json({ computers: [] });
    if (path === "/validate-mcp") return new Response(null, { status: revoked() ? 401 : 200 });
    return new Response(null, { status: 404 });
  } };
  const env = { FLEET: { idFromName: (n: string) => n, get: () => fleet },
    ROOM_RELAY: { idFromName: (n: string) => { ids.push(n); return n; }, get: () => ({ fetch: onRelay }) },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return { env, ids };
}
const auth = { authorization: "Fleet-OAEP kid-a.wrap-a" };

test("Room worker routes by authenticated account and overwrites forged trusted headers", async () => {
  const { env, ids } = environment(async (r) => {
    assert.equal(r.headers.get("x-fleet-user"), "account-a");
    assert.equal(r.headers.get("x-fleet-kid"), "kid-a");
    assert.deepEqual(await r.json(), { leaderId: "leader", action: "rooms.list", input: {} });
    return Response.json({ rooms: [] });
  });
  const r = await worker.fetch(new Request("https://fleet.test/v1/room-control", { method: "POST", headers: { ...auth, "x-fleet-user": "victim", "x-fleet-kid": "forged" }, body: JSON.stringify({ leaderId: "leader", action: "rooms.list", input: {} }) }), env);
  assert.equal(r.status, 200); assert.deepEqual(ids, ["account-a"]);
});

test("Room worker rejects cross-origin writes and unauthenticated directory", async () => {
  const { env, ids } = environment(async () => { throw new Error("must not route"); });
  assert.equal((await worker.fetch(new Request("https://fleet.test/v1/room-control", { method: "POST", headers: { ...auth, origin: "https://other.test" }, body: "{}" }), env)).status, 403);
  assert.equal((await worker.fetch(new Request("https://fleet.test/v1/room-agents"), env)).status, 401);
  assert.deepEqual(ids, []);
});

test("Room upload cannot cross an account token reset", async () => {
  let revoked = false;
  const { env, ids } = environment(async () => { throw new Error("must not route"); }, () => revoked);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; } });
  const pending = worker.fetch(new Request("https://fleet.test/v1/room-control", { method: "POST", headers: auth, body, duplex: "half" } as RequestInit), env);
  await new Promise((r) => setTimeout(r, 10)); revoked = true;
  stream.enqueue(new TextEncoder().encode("{}")); stream.close();
  assert.equal((await pending).status, 401); assert.deepEqual(ids, []);
});

test("Room request limit cancels chunked input before buffering its unbounded tail", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  await assert.rejects(readRoomBody(new Request("https://fleet.test", { method: "POST", body, duplex: "half" } as RequestInit)), { status: 413 });
  assert.equal(cancelled, true);
});

test("Cloudflare Room relay never accesses durable storage, including offline requests", async () => {
  const { env } = environment(async () => new Response());
  const ctx = new Proxy({}, { get() { throw new Error("Room relay must not touch persistent state"); } });
  const relay = new RoomRelayDO(ctx as DurableObjectState, env);
  const headers = { "x-fleet-user": "account-a" };
  assert.deepEqual(await (await relay.fetch(new Request("https://room/v1/room-agents", { headers }))).json(), { agents: [] });
  const r = await relay.fetch(new Request("https://room/v1/room-control", { method: "POST", headers, body: JSON.stringify({ leaderId: "offline", action: "rooms.list", input: {} }) }));
  assert.equal(r.status, 503);
  assert.equal((await r.json() as { code: string }).code, "LEADER_OFFLINE");
});
