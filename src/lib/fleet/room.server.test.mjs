import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocket } from 'ws';
import nodeAdapter from 'crossws/adapters/node';
import { H3 } from 'h3';
import { mintTokenV1, highSecAuthorization } from '../../../packages/fleet-worker/src/tokenv1.mjs';
import { RoomConnection } from '../../../packages/fleet-room/client.mjs';
import { RoomRunner } from '../../../packages/fleet-room/runner.mjs';
import { roomControl } from '../../../packages/fleet-worker/src/room-control.mjs';

// Load the real App modules through Vite: db.ts uses import.meta.glob to apply
// the real migrations. No authentication, SQL, routing or relay mocks.
test('App Room HTTP and native/Nitro WS use real sessions, OAEP and account-scoped PGLite', { timeout: 45000 }, async (t) => {
  let app, productionUpgrade;
  const server = createServer(async (req, res) => {
    try {
      const init = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
      const response = await app.handleHubHttp(new Request(url + req.url, init));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (productionUpgrade) void productionUpgrade(req, socket, head);
    else void app.handleHubUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const savedEnv = { ...process.env };
  Object.assign(process.env, { DATABASE_URL: '', VITE_AUTH_ENABLED: 'true', BETTER_AUTH_URL: url,
    BETTER_AUTH_SECRET: 'app-room-test-secret-at-least-thirty-two-characters', FLEET_HUB_ORIGIN: url });
  const vite = await createViteServer({ configFile: false, root: resolve('.'), appType: 'custom',
    resolve: { alias: { '@': resolve('src') } }, server: { middlewareMode: true, watch: null, ws: false }, logLevel: 'error' });
  const directory = await mkdtemp(join(tmpdir(), 'fleet-app-room-'));
  let runner, storage;
  const clients = [];
  let db;
  t.after(async () => {
    for (const client of clients) client.close();
    for (const relay of globalThis.__fleetAppRooms__?.values() ?? []) relay.close();
    globalThis.__fleetAppRooms__?.clear();
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    await storage?.close(); await vite.close();
    if (db) await (await db.getPglite()).close();
    await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  app = await vite.ssrLoadModule('/src/lib/fleet/v1.server.ts');
  db = await vite.ssrLoadModule('/src/lib/db.ts');
  const sql = await db.getSql();
  const tokens = {}, cookies = {};
  for (const id of ['account-a', 'account-b']) {
    await sql`INSERT INTO "user" (id,name,email,"emailVerified") VALUES (${id},${id},${id+'@test.invalid'},true)`;
    const session = `session-${id}`;
    await sql`INSERT INTO "session" (id,token,"expiresAt","updatedAt","userId") VALUES (${session},${session},${new Date(Date.now()+3600000)},${new Date()},${id})`;
    const signature = createHmac('sha256', process.env.BETTER_AUTH_SECRET).update(session).digest('base64');
    cookies[id] = '__Host-grok-auth.session_token=' + encodeURIComponent(session + '.' + signature);
    const token = tokens[id] = await mintTokenV1({ aud: url });
    await sql`INSERT INTO hub_tokens (user_id,token_hash,token_prefix,kid,pub,priv,aud) VALUES (${id},${token.hash},${token.prefix},${token.kid},${token.pub},${token.priv},${url})`;
    await sql`INSERT INTO devices (id,user_id,slug,name,os,arch,location_tag) VALUES (${id+'-device'},${id},${id+'-device'},${id},'linux','x64','local')`;
  }
  const http = (path, { account = 'account-a', body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(url + path, {
    method, headers: { cookie: cookies[account], 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const control = (action, input, options = {}) => http('/v1/room-control', { ...options, body: { leaderId: 'leader', action, input } });
  await t.test('website cookies only enable Room and read-only computer listing', async () => {
    assert.equal((await fetch(url+'/v1/room-agents')).status, 401);
    assert.equal((await http('/v1/room-agents')).status, 200);
    const devices = await (await http('/v1/list_computers', { body: {} })).json();
    assert.deepEqual(devices.computers.map((d) => d.id), ['account-a-device']);
    for (const path of ['/v1/run', '/v1/type', '/v1/set_computer_alias']) assert.equal((await http(path, { body: {} })).status, 401);
    assert.equal((await http('/v1/room-agents', { headers: { origin: 'https://elsewhere.invalid' } })).status, 403);
    assert.equal((await http('/v1/room-agents', { headers: { authorization: 'Bearer invalid' } })).status, 401);
    const ws = new WebSocket(url.replace('http:', 'ws:')+'/v1/room-agent', { headers: { cookie: cookies['account-a'] } });
    const status = await new Promise((r) => { ws.on('unexpected-response', (_, res) => { res.resume(); r(res.statusCode); ws.terminate(); }); ws.on('error', () => {}); });
    assert.equal(status, 401);
  });
  const connect = async (account, id, leader = false, roomId) => {
    const client = new RoomConnection({ url, token: tokens[account].raw, id, mode: leader ? 'runtime' : 'mcp', leader, roomId,
      onRequest: (m) => runner.handleControl(m) });
    clients.push(client); await client.connect(); return client;
  };
  runner = new RoomRunner({ url, token: tokens['account-a'].raw, id: 'leader', leader: true, command: process.execPath, dataDir: directory });
  storage = runner.storage;
  await connect('account-a', 'leader', true);
  const other = await connect('account-b', 'other-leader', true);
  await t.test('native App WS relays real local Room state with canonical account devices', async () => {
    const created = await control('rooms.create', { id: 'room', leaderId: 'leader', defaultDeviceId: 'account-a-device' });
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await created.json()).room.defaultDeviceId, 'account-a-device');
    assert.equal((await control('rooms.device', { roomId: 'room', defaultDeviceId: 'account-b-device', expectedConfigVersion: 1 })).status, 403);
    const response = await control('messages.send', { roomId: 'room', discussionId: 'main', requestId: 'message', expectedContextRev: 0, text: 'leader-private-text' });
    assert.equal(response.status, 200, await response.clone().text());
    const read = await (await control('messages.read', { roomId: 'room', discussionId: 'main' })).json();
    assert.equal(read.messages[0].text, 'leader-private-text');
    const directory = await (await http('/v1/room-agents')).json();
    assert.deepEqual(directory.agents.map((a) => a.id), ['leader']);
    assert.equal((await control('rooms.list', {}, { account: 'account-b' })).status, 503);
    assert.equal((await sql`SELECT * FROM commands`).length, 0);
    assert.equal((await sql`SELECT * FROM protocol_events`).length, 0);
    assert.equal((await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'room%'`).length, 0);
  });
  await t.test('bounded bodies and forged authority are rejected before relay', async () => {
    assert.equal((await http('/v1/room-control', { body: 'x'.repeat(128*1024+1) })).status, 413);
    assert.equal((await http('/v1/room-control', { body: '{bad' })).status, 400);
    assert.equal((await http('/v1/room-control', { body: { leaderId: 'leader', action: 'rooms.list', input: {}, principal: { kind: 'user', id: 'account-b' } } })).status, 400);
  });
  await t.test('real Nitro H3 route upgrades via crossws and retains per-frame token checks', async () => {
    const route = await vite.ssrLoadModule('/server/routes/v1/room-agent.ts');
    const h3 = new H3().get('/v1/room-agent', route.default);
    const adapter = nodeAdapter({ resolve: async (request) => (await h3.fetch(request)).crossws });
    productionUpgrade = adapter.handleUpgrade;
    const client = await connect('account-a', 'nitro-member');
    assert.equal((await client.call('leader', 'rooms.list')).rooms.length, 0); // Non-member agent cannot enumerate rooms.
    await assert.rejects(client.call('leader', 'agents.configure', { agentId: 'nitro-member', canCreateRooms: true }), { code: 'forbidden' });
    const nitroOther = await connect('account-b', 'nitro-other');
    const closed = Promise.all([once(other.ws, 'close'), once(nitroOther.ws, 'close')]);
    await sql`UPDATE hub_tokens SET token_hash='revoked' WHERE user_id='account-b'`;
    other.send({ type: 'ping' }); nitroOther.send({ type: 'ping' });
    await closed;
    assert.equal((await http('/v1/room-agents', { account: 'account-b' })).status, 200); // Cookie is independently valid.
    productionUpgrade = undefined;
  });
  await t.test('OAEP credentials and sessions revoked during a slow body cannot forward mutations', async () => {
    async function slowRequest(headers, revoke) {
      let release;
      const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ leaderId: 'leader', action: 'rooms.pause', input: { roomId: 'room' } }))); controller.close(); }; } });
      // Start body consumption only after authentication has completed.
      const originalGetReader = body.getReader.bind(body);
      let consuming;
      const consumed = new Promise((r) => { consuming = r; });
      body.getReader = (...args) => { consuming(); return originalGetReader(...args); };
      const response = app.handleHubHttp(new Request(url+'/v1/room-control', { method: 'POST', headers, body, duplex: 'half' }));
      await consumed; await revoke(); release();
      assert.equal((await response).status, 401);
    }
    await slowRequest({ authorization: await highSecAuthorization(tokens['account-a'].raw, url) }, () => sql`UPDATE hub_tokens SET token_hash='revoked-a' WHERE user_id='account-a'`);
    await slowRequest({ cookie: cookies['account-a'] }, () => sql`DELETE FROM "session" WHERE "userId"='account-a'`);
    assert.equal((await roomControl(storage, { kind: 'user', id: 'account-a' }, 'rooms.get', { roomId: 'room' })).room.paused, false);
  });
});
