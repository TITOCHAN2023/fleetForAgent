// Real VM integration tests. Run as fleet-test, never with production credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createOperator, fleetHubHeaders, wrapTransportRpc, isDeviceTransportPath, isFinishedResult, resultTransport, officialPlugin } from '../../packages/fleet-tool/operator.mjs';
import { highSecAuthorization, verifyTokenV1, verifyFleetStatement } from '../../packages/fleet-worker/src/tokenv1.mjs';
import { openRecovery } from '../../packages/fleet-tool/recovery.mjs';
import { createRtcManager } from '../../packages/fleet-tool/rtc.mjs';
import { remoteMcp } from './linux-remote-mcp.mjs';

assert.equal(process.platform, 'linux');
assert.match(hostname(), /^lima-linux-[ab]$/);
assert.notEqual(process.getuid(), 0);
const base = '/var/lib/fleet-lab';
const HUB = 'http://fleet-hub.test:8787';
export const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const delay = ms => new Promise(r => setTimeout(r, ms));
const put = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
async function until(fn, ms = 60000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await delay(150); }
  throw new Error(`condition timed out (${ms}ms): ${JSON.stringify(last)}`);
}
const mode = process.argv[2];
const runId = process.argv[3] || randomUUID();
assert.match(runId, /^[a-zA-Z0-9_-]+$/);
if (mode === 'seed') {
  const key = await readFile(base + '/seed-key', 'utf8');
  await until(async () => { try { return (await fetch(HUB + '/v1/challenge?kid=invalid')).status < 500; } catch { return false; } });
  const res = await fetch(HUB + '/__fleet_vm__/seed', { method: 'POST', headers: { 'x-fleet-vm-key': key } });
  assert.equal(res.status, 200, await res.clone().text());
  await put(base + '/seed.json', await res.json());
  console.log('Seeded private local flt_1 credential.');
  process.exit(0);
}
const { token } = JSON.parse(await readFile(base + '/seed.json'));
await mkdir(base + '/' + runId, { mode: 0o700 });
const evidence = base + '/' + runId + '/evidence.ndjson';
const clients = [];
async function record(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const row = { test: name, passed: true, ms: Date.now() - start, ...detail };
    await appendFile(evidence, JSON.stringify(row) + '\n', { mode: 0o600 }); console.log(JSON.stringify(row)); return detail;
  } catch (e) { await appendFile(evidence, JSON.stringify({ test: name, passed: false, error: e.stack }) + '\n'); throw e; }
}
async function client(name, rtcEnabled = false) {
  const recovery = openRecovery(`${base}/${runId}/${name}.json`, { url: HUB, token });
  async function post(endpoint, body, { signal } = {}) {
    const authorization = await highSecAuthorization(token, HUB, (url, init) => fetch(url, { ...init, signal }));
    const res = await fetch(HUB + endpoint, { method: body === undefined ? 'GET' : 'POST', signal, headers: fleetHubHeaders({ authorization, fingerprint: recovery.fingerprint }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const row = await res.json(); if (!res.ok) throw new Error(`${endpoint}: ${res.status}: ${JSON.stringify(row)}`); return row;
  }
  const rtc = createRtcManager({ hubPost: post, token, operatorId: recovery.fingerprint, verifyTokenV1, verifyFleetStatement, officialPlugin });
  const operator = createOperator({ fingerprint: recovery.fingerprint, state: recovery.state, saveState: recovery.save,
    rpc: async (endpoint, body, options) => {
      if (rtcEnabled) { const r = await rtc.tryRpc(endpoint, body, options); if (r.handled) return wrapTransportRpc(r.value, isDeviceTransportPath(endpoint) ? r.transport : null); }
      return wrapTransportRpc(await post(endpoint, body, options), isDeviceTransportPath(endpoint) ? 'ws' : null);
    } });
  const c = { call: (name, args = {}) => operator.callTool(name, args), post, rtc, recovery, close: async () => { await rtc.shutdown(); recovery.close(); } };
  clients.push(c); return c;
}
async function finished(c, device, ms = 60000) { return until(async () => { const r = await c.call('get_result', { device_id: device }); return isFinishedResult(r) ? r : false; }, ms); }
async function run(c, device, command) { await c.call('run', { device_id: device, command, wait_ms: 0 }); return finished(c, device); }
function markerResult(row, marker, device) {
  assert.equal(row.exit_code, 0, JSON.stringify(row));
  assert(row.stdout.includes(marker), JSON.stringify(row));
  assert(row.stdout.includes(device === A ? 'lima-linux-a' : 'lima-linux-b'), JSON.stringify(row));
  const found = row.stdout.match(/LABMARK_[a-zA-Z0-9_]+/g) || [];
  assert(found.every(m => m === marker), `cross-talk: ${JSON.stringify(row)}`);
}
async function mcp(name) {
  const child = spawn(process.execPath, ['/opt/fleet-lab/workspace/packages/fleet-tool/index.mjs'], { env: { ...process.env, FLEET_URL: HUB, FLEET_TOKEN: token, FLEET_SESSION_PATH: `${base}/${runId}/${name}.json`, FLEET_AGENT_ID: name }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0, stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  createInterface({ input: child.stdout }).on('line', line => {
    const row = JSON.parse(line), p = pending.get(row.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(row.id);
    if (row.error) p.reject(new Error(JSON.stringify(row.error)));
    else p.resolve(row.result);
  });
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited ${code}: ${stderr}`)); } pending.clear(); });
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method} ${stderr}`)); }, 60000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const c = { call: async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args }); assert(!r.isError, JSON.stringify(r));
    if (!['run', 'get_result', 'wait'].includes(name)) return JSON.parse(r.content[0].text);
    // Public MCP intentionally returns plain shell output, not JSON envelopes.
    if (r.content[0].text === 'still running') return { status: 'running' };
    // RTC completion can precede its Hub snapshot. Poll only the saved handle;
    // never repeat run to make the read-side assertion pass under load.
    const row = await until(async () => {
      const snapshot = await request('tools/call', { name: 'recover_session', arguments: { device_id: args.device_id } });
      assert(!snapshot.isError, JSON.stringify(snapshot));
      const result = JSON.parse(snapshot.content[0].text).result;
      return isFinishedResult(result) ? result : false;
    });
    assert.equal(typeof row.stdout, 'string', JSON.stringify(row));
    assert.equal(row.stdout.trim(), r.content[0].text.trim()); return row;
  }, close: async () => { child.stdin.end(); await Promise.race([new Promise(r => child.once('exit', r)), delay(5000).then(() => { if (child.exitCode === null) child.kill(); })]); } };
  clients.push(c);
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'linux-vm-test', version: '1' } });
  return c;
}
async function rounds(group, count, label) {
  for (let round = 0; round < count; round++) {
    const results = await Promise.all(group.map(async (c, i) => {
      const device = round % 2 === 0 ? A : i % 2 === 0 ? A : B;
      const marker = `LABMARK_${label}_${round}_${i}`;
      const row = await run(c, device, `hostname; sleep 0.15; printf '${marker}\\n'`);
      markerResult(row, marker, device); return row;
    }));
    assert.equal(new Set(results.map(r => r.corr)).size, group.length);
  }
  return { rounds: count, operations: count * group.length, clients: group.length };
}
try {
  const group = await Promise.all([0, 1, 2, 3].map(i => client('operator-' + i)));
  const one = group[0], two = group[1];
  await record('two isolated real Linux agents online', async () => {
    const rows = await until(async () => { const r = await one.call('list_computers'); const cs = r.computers; return cs?.length === 2 && cs.every(c => c.online) && cs; });
    assert.deepEqual(rows.map(r => r.id).sort(), [A, B]);
    for (const r of rows) { assert(!('ip' in r)); assert(r.caps.includes('operation_recovery_v1')); }
    return { devices: rows.map(r => ({ id: r.id, version: r.agentVer })) };
  });
  if (mode === 'auth') {
    await record('32 simultaneous operator handshakes retain valid one-use challenges', async () => {
      // Barrier: every challenge must exist before any of them is consumed.
      const headers = await Promise.all(Array.from({ length: 32 }, () => highSecAuthorization(token, HUB)));
      const results = await Promise.all(headers.map(authorization => fetch(HUB + '/v1/list_computers', { method: 'POST', headers: fleetHubHeaders({ authorization, fingerprint: randomUUID() }), body: '{}' })));
      const statuses = results.map(r => r.status);
      assert(statuses.every(s => s === 200), JSON.stringify({ statuses }));
      const replay = await fetch(HUB + '/v1/list_computers', { method: 'POST', headers: fleetHubHeaders({ authorization: headers[0], fingerprint: randomUUID() }), body: '{}' });
      assert.equal(replay.status, 401);
      return { concurrent: 32, successful: statuses.length, replay_status: replay.status };
    });
  } else if (mode === 'remote') {
    for (const transport of ['http', 'sse']) {
      await record('four remote MCP ' + transport + ' sessions stay isolated', async () => {
        const remote = await Promise.all(Array.from({ length: 4 }, () => remoteMcp(HUB, token, transport)));
        clients.push(...remote);
        return { ...await rounds(remote, 10, transport.toUpperCase()), transport: 'ws' };
      });
    }
  } else if (mode === 'retention') {
    const end = Date.now() + 20 * 60000;
    const long = await Promise.all([client('long-a'), client('long-b')]);
    await Promise.all(long.map((c, i) => c.call('run', { device_id: i ? B : A, command: "printf 'LONG_BEGIN\\n'; sleep 900; printf 'LONG_END\\n'", wait_ms: 0 })));
    const proof = await client('receipt-proof');
    const request_id = randomUUID();
    const counter = `${base}/${runId}-once`;
    const command = `echo once >> ${counter}; printf 'old-output\\n'; exit 7`;
    await proof.call('run', { device_id: A, command, request_id, wait_ms: 0 });
    assert.equal((await finished(proof, A)).exit_code, 7);
    for (let wave = 0; wave < 4; wave++) {
      await record('retention load wave ' + wave, async () => {
        for (let round = 0; round < 256; round++) {
          const rows = await Promise.all(group.map(async (c, i) => {
            const device = i % 2 ? B : A, marker = `LABMARK_RET_${wave}_${round}_${i}`;
            const row = await run(c, device, `hostname; printf '${marker}\\n'`);
            markerResult(row, marker, device); return row;
          }));
          assert.equal(new Set(rows.map(r => r.corr)).size, 4);
        }
        for (let i = 0; i < 2; i++) {
          const r = await long[i].call('get_result', { device_id: i ? B : A });
          assert.equal(r.status, 'running', JSON.stringify(r));
        }
        return { operations: 1024, per_machine: 512, active_tasks_preserved: 2, at: new Date().toISOString() };
      });
      await delay(60000); // observe the natural collector, never force GC/restart
    }
    while (Date.now() < end) {
      for (const device_id of [A, B]) assert((await one.call('heartbeat', { device_id })).online);
      await delay(10000);
    }
    await record('both running tasks survive repeated retention overflow', async () => {
      for (let i = 0; i < 2; i++) {
        const r = await finished(long[i], i ? B : A);
        assert.equal(r.exit_code, 0); assert(r.stdout.includes('LONG_END'));
      }
      return { tasks: 2 };
    });
    await record('evicted output keeps disk proof and cannot replay through the Hub', async () => {
      const key = await readFile(base + '/seed-key', 'utf8');
      const reset = await fetch(HUB + '/__fleet_vm__/recovery', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-vm-key': key }, body: JSON.stringify({ device_id: A, action: 'clear_cache' }) });
      assert.equal(reset.status, 200);
      const r = await until(async () => { const row = await proof.call('get_result', { device_id: A }); return isFinishedResult(row) && row; });
      assert.equal(r.exit_code, 7); assert.equal(r.output_unavailable, true);
      await proof.call('run', { device_id: A, command, request_id, wait_ms: 0 });
      assert.equal((await finished(proof, A)).output_unavailable, true);
      assert.equal((await run(one, A, `cat ${counter}`)).stdout.trim(), 'once');
      return { exit_code: 7, output_unavailable: true, executed: 1 };
    });
  } else if (mode === 'soak') {
    const end = Date.now() + 30 * 60000;
    // The task itself outlives normal request timeouts and many heartbeats.
    const long = await client('long-running');
    await long.call('run', { device_id: B, command: "printf 'SOAK_BEGIN\\n'; sleep 1740; printf 'SOAK_END\\n'", wait_ms: 0 });
    let cycle = 0;
    while (Date.now() < end) {
      await record('soak-' + cycle, async () => {
        const cs = (await one.call('list_computers')).computers;
        assert.equal(cs.filter(c => c.online).length, 2);
        const r = await rounds(group, 2, 'SOAK_' + cycle++);
        const state = await long.call('get_result', { device_id: B });
        assert(['running', 'pending', 'finished', 'done', 'completed'].includes(state.status), JSON.stringify(state));
        return { ...r, long_status: state.status };
      });
      await delay(15000);
    }
    await record('long task survived 30-minute soak', async () => { const r = await finished(long, B); assert.equal(r.exit_code, 0); assert(r.stdout.includes('SOAK_END')); return { corr: r.corr }; });
  } else if (mode === 'faults') {
    let sequence = 0;
    async function control(action, extra = {}) {
      const id = ++sequence; await put(base + '/' + runId + '/control.json', { id, action, ...extra });
      const result = await until(async () => { try { const r = JSON.parse(await readFile(base + '/' + runId + '/control-result.json')); return r.id === id && r; } catch { return false; } });
      if (result.error) throw new Error(result.error); return result.value;
    }
    async function online() {
      await until(async () => { try { return (await one.call('heartbeat', { device_id: B })).online; } catch { return false; } }, 90000);
    }
    async function clearResultCache() {
      const key = await readFile(base + '/seed-key', 'utf8');
      const res = await fetch(HUB + '/__fleet_vm__/recovery', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-vm-key': key }, body: JSON.stringify({ device_id: B, action: 'clear_cache' }) });
      assert.equal(res.status, 200);
    }
    const file = name => `${base}/${runId}-${name}`;
    await record('35-second network partition preserves job and reconnects without replay', async () => {
      await one.call('run', { device_id: B, command: `printf 'x\\n' >> ${file('partition')}; sleep 4; printf 'PARTITION_DONE\\n'; printf done > ${file('offline-done')}`, wait_ms: 0 });
      await delay(500); assert.equal(await control('read', { file: 'partition' }), 'x');
      await control('disconnect'); await delay(35000);
      assert.equal(await control('read', { file: 'offline-done' }), 'done');
      await control('connect'); await online();
      const r = await finished(one, B, 90000); assert.equal(r.exit_code, 0); assert(r.stdout.includes('PARTITION_DONE'));
      assert.equal(await control('read', { file: 'partition' }), 'x'); return { corr: r.corr, executed: 1 };
    });
    await record('Hub restart does not kill or replay machine task', async () => {
      await one.call('run', { device_id: B, command: `printf 'x\\n' >> ${file('hub')}; sleep 4; printf 'HUB_RESTART_DONE\\n'`, wait_ms: 0 });
      await delay(500); await control('hub-restart'); await online();
      const r = await finished(one, B, 90000); assert.equal(r.exit_code, 0); assert(r.stdout.includes('HUB_RESTART_DONE'));
      assert.equal(await control('read', { file: 'hub' }), 'x'); return { corr: r.corr, executed: 1 };
    });
    async function pluginResult(ticket) {
      return until(async () => {
        const r = await one.call('get_plugin_task', { device_id: B, corr: ticket.corr });
        assert.notEqual(r.ok, false, JSON.stringify(r));
        return r.status === 'done' && r;
      }, 90000);
    }
    await record('plugin finishes while offline and delivers result after reconnect', async () => {
      const t = await one.call('delegate_to_acp', { device_id: B, profile: 'normal', cwd: base, prompt: 'LABMARK_PLUGIN_OFFLINE WAIT_5', timeout_seconds: 30 });
      await control('disconnect'); await delay(35000);
      await control('connect'); await online();
      const r = await pluginResult(t);
      assert.equal(r.ok, true); assert(JSON.stringify(r).includes('LABMARK_PLUGIN_OFFLINE'));
      return { corr: t.corr };
    });
    await record('plugin completion follows new socket after Hub restart', async () => {
      const t = await one.call('delegate_to_acp', { device_id: B, profile: 'normal', cwd: base, prompt: 'LABMARK_PLUGIN_RESTART WAIT_5', timeout_seconds: 30 });
      await control('hub-restart'); await online();
      const r = await pluginResult(t);
      assert.equal(r.ok, true); assert(JSON.stringify(r).includes('LABMARK_PLUGIN_RESTART'));
      return { corr: t.corr };
    });
    await record('Agent restart retains completed receipt without claiming persisted output', async () => {
      const r = await run(one, B, `printf 'x\\n' >> ${file('completed')}; printf 'VOLATILE_OUTPUT\\n'`); assert.equal(r.exit_code, 0);
      await control('agent-restart'); await online();
      // Local DO storage survives Hub restart. Clear this disposable DeviceDO
      // to assert its device receipt, not a persisted Hub snapshot.
      await control('hub-restart'); await online();
      await clearResultCache();
      const after = await finished(one, B, 90000); assert.equal(after.exit_code, 0); assert.equal(after.output_unavailable, true); assert(!after.stdout);
      assert.equal(await control('read', { file: 'completed' }), 'x'); return { corr: after.corr, output_unavailable: true };
    });
    await record('hard Agent crash reports unknown and never repeats the interrupted command', async () => {
      await one.call('run', { device_id: B, command: `printf 'x\\n' >> ${file('crashed')}; sleep 60; printf 'NOT_ALLOWED\\n'`, wait_ms: 0 });
      await delay(500); assert.equal(await control('read', { file: 'crashed' }), 'x');
      await control('agent-crash'); await delay(4000); await online();
      await control('hub-restart'); await online();
      await clearResultCache();
      const r = await finished(one, B, 90000); assert.equal(r.status, 'unknown'); assert(!r.stdout);
      assert.equal(await control('read', { file: 'crashed' }), 'x');
      markerResult(await run(two, B, "hostname; printf 'LABMARK_AFTER_RESTART\\n'"), 'LABMARK_AFTER_RESTART', B);
      return { corr: r.corr, status: 'unknown', executed: 1 };
    });
  } else if (mode === 'sessions') {
    await record('same explicit tmux session name is isolated by operator; detach and reattach preserve state', async () => {
      const name = 'shared-' + runId;
      const active = group.slice(0, 2);
      for (const c of active) await c.call('run', { device_id: A, command: `/opt/fleet-lab/fleet-agent session ${name}`, wait_ms: 0 });
      await delay(1500);
      for (let i = 0; i < active.length; i++) await active[i].call('type', { device_id: A, keys: `export LAB_SESSION_OWNER=OWNER_${i}; cd ${base}; printf 'LABMARK_PERSIST_${i}\\n'\n` });
      for (let i = 0; i < active.length; i++) {
        const row = await until(async () => { const r = await active[i].call('read_screen', { device_id: A }); return JSON.stringify(r).includes(`LABMARK_PERSIST_${i}`) && r; });
        assert(!JSON.stringify(row).includes(`LABMARK_PERSIST_${1-i}`));
        await active[i].call('type', { device_id: A, keys: '\u001d' });
        const detached = await finished(active[i], A); assert.equal(detached.exit_code, 0);
      }
      for (let i = 0; i < active.length; i++) {
        await active[i].call('run', { device_id: A, command: `/opt/fleet-lab/fleet-agent session ${name}`, wait_ms: 0 });
        await delay(500);
        await active[i].call('type', { device_id: A, keys: "printf 'RESTORED_%s\\n' \"$LAB_SESSION_OWNER\"; pwd\n" });
        const r = await until(async () => { const row = await active[i].call('read_screen', { device_id: A }); return JSON.stringify(row).includes(`RESTORED_OWNER_${i}`) && row; });
        assert(!JSON.stringify(r).includes(`RESTORED_OWNER_${1-i}`));
        await active[i].call('type', { device_id: A, keys: '\u001d' }); await finished(active[i], A);
        const closed = await run(active[i], A, `/opt/fleet-lab/fleet-agent session close ${name}`); assert.equal(closed.exit_code, 0);
      }
      return { owners: 2, backend: 'tmux', shared_name: name, reattached: true };
    });
  } else if (mode === 'plugins') {
    async function pluginDone(c, device, ticket, ms = 60000) {
      return until(async () => { const r = await c.call('get_plugin_task', { device_id: device, corr: ticket.corr }); return ['done', 'failed', 'error', 'rejected'].includes(r.status) && r; }, ms);
    }
    await record('official ACP profiles configured without a second approval in allow mode', async () => {
      for (const device of [A, B]) {
        for (const profile of ['normal', 'crash']) {
          const t = await one.call('configure_acp', { device_id: device, profile, command: '/usr/local/bin/node', args: ['/opt/fleet-lab/workspace/scripts/plugin-peer-vm/linux-plugin-acp.mjs', ...(profile === 'crash' ? ['--crash'] : [])] });
          const done = await pluginDone(one, device, t); assert.equal(done.ok, true, JSON.stringify(done));
        }
      }
      return { artifact_version: '0.1.2', private_profiles: 4 };
    });
    await record('official ACP concurrent tasks isolated across operators and machines', async () => {
      for (let round = 0; round < 5; round++) {
        const rows = await Promise.all(group.map(async (c, i) => {
          const device = round % 2 === 0 ? A : i % 2 ? A : B;
          const marker = `LABMARK_PLUGIN_${round}_${i}`;
          const t = await c.call('delegate_to_acp', { device_id: device, profile: 'normal', cwd: base, prompt: `${marker} WAIT_1`, timeout_seconds: 20 });
          const r = await pluginDone(c, device, t); assert.equal(r.ok, true, JSON.stringify(r));
          const text = JSON.stringify(r); assert(text.includes(marker)); assert((text.match(/LABMARK_[a-zA-Z0-9_]+/g) || []).every(v => v === marker));
          return { ...r, corr: t.corr, device };
        }));
        assert.equal(new Set(rows.map(r => r.corr)).size, 4);
        const stolen = await two.call('get_plugin_task', { device_id: rows[0].device, corr: rows[0].corr });
        assert.equal(stolen.status, 'pending');
      }
      return { tasks: 20 };
    });
    await record('ACP crash and timeout cannot bring down Sandbox or other tasks', async () => {
      const normal = await two.call('delegate_to_acp', { device_id: A, profile: 'normal', cwd: base, prompt: 'LABMARK_SURVIVOR WAIT_3', timeout_seconds: 20 });
      const crash = await one.call('delegate_to_acp', { device_id: A, profile: 'crash', cwd: base, prompt: 'LABMARK_CRASH WAIT_1', timeout_seconds: 20 });
      const failed = await pluginDone(one, A, crash); assert.equal(failed.ok, false, JSON.stringify(failed));
      const timeout = await one.call('delegate_to_acp', { device_id: A, profile: 'normal', cwd: base, prompt: 'LABMARK_TIMEOUT WAIT_10', timeout_seconds: 1 });
      const expired = await pluginDone(one, A, timeout); assert.equal(expired.ok, false, JSON.stringify(expired));
      const survived = await pluginDone(two, A, normal); assert.equal(survived.ok, true); assert(JSON.stringify(survived).includes('LABMARK_SURVIVOR'));
      markerResult(await run(one, A, "hostname; printf 'LABMARK_AFTER_CRASH\\n'"), 'LABMARK_AFTER_CRASH', A);
      return { crash_failed: true, timeout_failed: true, other_task_completed: true };
    });
    await record('official ACP long task survives ten minutes', async () => {
      const t = await one.call('delegate_to_acp', { device_id: B, profile: 'normal', cwd: base, prompt: 'LABMARK_LONG_PLUGIN WAIT_600', timeout_seconds: 700 });
      let polls = 0;
      const done = await until(async () => {
        const r = await one.call('get_plugin_task', { device_id: B, corr: t.corr });
        assert.notEqual(r.status, 'waiting_approval'); assert.notEqual(r.ok, false, JSON.stringify(r));
        assert((await two.call('heartbeat', { device_id: B })).online);
        polls++; if (r.status === 'done') return r; await delay(5000); return false;
      }, 650000);
      assert.equal(done.ok, true); assert(JSON.stringify(done).includes('LABMARK_LONG_PLUGIN')); return { polls, corr: t.corr };
    });
  } else if (mode === 'test') {
    await record('repeated concurrent operators same and different machines', () => rounds(group, 20, 'RPC'));
    await record('oneshot cwd and environment cannot leak; default devices are isolated', async () => {
      const rowsInDir = await Promise.all(group.map((c, i) => run(c, A, `mkdir -p ${base}/cwd-${i}; cd ${base}/cwd-${i}; export FLEET_LAB_OWNER=owner-${i}; pwd; printf "$FLEET_LAB_OWNER\\n"`)));
      for (let i = 0; i < group.length; i++) {
        assert.equal(rowsInDir[i].stdout.trim(), `${base}/cwd-${i}\nowner-${i}`);
        const r = await run(group[i], A, 'pwd; printf "${FLEET_LAB_OWNER-unset}\\n"');
        assert.equal(r.stdout.trim(), '/home/fleet-test\nunset');
      }
      await one.call('set_computer', { device_id: A }); await two.call('set_computer', { device_id: B });
      const rows = await Promise.all([one, two].map(c => c.call('run', { command: 'hostname', wait_ms: 2000 })));
      assert(rows[0].stdout.includes('lima-linux-a')); assert(rows[1].stdout.includes('lima-linux-b'));
      return { cwd_sessions: 4, different_defaults: true };
    });
    await record('ctrl+c only cancels its owner on shared machine', async () => {
      await Promise.all([one.call('run', { device_id: A, command: "printf 'CANCEL_STARTED\\n'; sleep 60; printf 'BAD_FINISH\\n'", wait_ms: 0 }), two.call('run', { device_id: A, command: "sleep 3; printf 'OTHER_FINISHED\\n'", wait_ms: 0 })]);
      await delay(500); await one.call('type', { device_id: A, key: 'ctrl+c' });
      const [a, b] = await Promise.all([finished(one, A), finished(two, A)]);
      assert.notEqual(a.exit_code, 0); assert(!a.stdout.includes('BAD_FINISH')); assert.equal(b.exit_code, 0); assert(b.stdout.includes('OTHER_FINISHED'));
      return { cancelled: a.corr, unaffected: b.corr };
    });
    await record('same request UUID across operators does not merge jobs', async () => {
      const request_id = randomUUID();
      await Promise.all([one, two].map((c, i) => c.call('run', { device_id: A, command: `printf 'OWNER_${i}\\n'`, request_id, wait_ms: 0 })));
      const [a, b] = await Promise.all([finished(one, A), finished(two, A)]);
      assert.notEqual(a.corr, b.corr); assert(a.stdout.includes('OWNER_0')); assert(b.stdout.includes('OWNER_1'));
      const stolen = await two.post('/v1/get_result', { device_id: A, corr: a.corr });
      assert(!stolen.stdout && stolen.status === 'pending');
      return { a: a.corr, b: b.corr, other_operator_result_denied: true };
    });
    await record('four independent MCP stdio processes do not cross-talk', async () => {
      const mcps = await Promise.all([0, 1, 2, 3].map(i => mcp('mcp-' + i)));
      return rounds(mcps, 10, 'MCP');
    });
    await record('room agents with identical names route tasks by identity and device', async () => {
      await until(async () => (await one.post('/v1/room-agents')).agents.filter(a => a.callable).length === 3);
      const control = (action, input) => one.post('/v1/room-control', { leaderId: 'leader', action, input });
      const roomId = 'vm-' + runId;
      await control('rooms.create', { id: roomId, leaderId: 'leader', defaultDeviceId: A });
      for (const id of ['peer-a', 'peer-b']) await control('rooms.invite', { roomId, agentId: id });
      for (let round = 0; round < 5; round++) {
        const rows = await Promise.all([0, 1, 2, 3].map(async i => {
          const marker = `LABMARK_ROOM_${round}_${i}`, deviceId = round % 2 === 0 ? A : i % 2 ? B : A;
          const { task } = await control('tasks.delegate', { roomId, requestId: randomUUID(), assigneeId: i < 2 ? 'peer-a' : 'peer-b', sessionId: roomId, description: `Read hostname and emit ${marker}`, completionCriteria: 'Return own marker and hostname', deviceId });
          const done = await until(async () => { const { task: t } = await control('tasks.get', { roomId, taskId: task.id }); assert(!['failed', 'unknown'].includes(t.status), JSON.stringify(t)); return t.status === 'completed' && t; });
          const result = JSON.parse(done.result); markerResult(result, marker, deviceId); return done;
        }));
        assert.equal(new Set(rows.map(t => t.id)).size, 4);
      }
      assert.equal((await control('rooms.get', { roomId })).room.defaultDeviceId, A);
      return { tasks: 20, runners: 3, identical_display_names: true };
    });
    await record('real RTC falls back to WS without rerun', async () => {
      const c = await client('rtc', true);
      const r = await c.call('run', { device_id: B, command: "hostname; sleep 2; printf 'LABMARK_RTC\\n'", wait_ms: 0 });
      assert.equal(resultTransport(r), 'rtc'); await c.rtc.shutdown();
      const done = await finished(c, B); markerResult(done, 'LABMARK_RTC', B); assert.equal(resultTransport(done), 'ws'); assert.equal(done.corr, r.corr);
      return { start: 'rtc', finish: 'ws', corr: done.corr };
    });
  } else throw new Error('unknown mode');
} finally { for (const c of clients.reverse()) await c.close(); }
