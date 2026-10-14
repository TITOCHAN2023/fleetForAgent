// Official release compatibility in a fresh disposable VM namespace.
// Run only after the two-device soak: this temporarily registers a third device.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createOperator, fleetHubHeaders, isFinishedResult } from '../../packages/fleet-tool/operator.mjs';
import { OFFICIAL_PLUGIN_CATALOG } from '../../packages/fleet-tool/official-plugins.generated.mjs';
import { highSecAuthorization } from '../../packages/fleet-worker/src/tokenv1.mjs';
import { remoteMcp } from './linux-remote-mcp.mjs';

assert.equal(process.platform, 'linux');
assert.equal(hostname(), 'lima-linux-b');
assert.notEqual(process.getuid(), 0);
const binary = '/opt/fleet-lab/hn-official-0.6.7/fleet-agent';
const expectedBinaryHash = '79ef0e6c067b2d979164214d22bfe7460c5411a692f5c5d7d2d3b087f6353f9d';
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expectedBinaryHash);
const base = '/var/lib/fleet-lab';
const hub = 'http://fleet-hub.test:8787';
const { token } = JSON.parse(await readFile(base + '/seed.json'));
const home = await mkdtemp(base + '/release-0.6.7-');
const device = randomUUID();
await writeFile(home + '/config.json', JSON.stringify({ enabled: true, permit: 'allow', hubInput: hub, hubToken: token, deviceId: device, autoUpdate: false }), { mode: 0o600 });
const plugin = OFFICIAL_PLUGIN_CATALOG.find(row => row.id === 'fleet.acp');
const artifact = plugin.artifacts.find(row => row.os === 'linux' && row.arch === 'arm64');
const installed = base + '/agent/plugins/fleet.acp';
assert.equal(createHash('sha256').update(await readFile(installed + '/' + artifact.entrypoint)).digest('hex'), artifact.sha256);
await cp(installed, home + '/plugins/fleet.acp', { recursive: true });

const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('FLEET_')) delete childEnv[key];
Object.assign(childEnv, { FLEET_HOME: home, FLEET_URL: hub, FLEET_TOKEN: token,
  FLEET_ENABLED: 'true', FLEET_SETTINGS_ADDR: '127.0.0.1:17891', FLEET_AUTO_UPDATE: 'false' });
// Supervise the no-args service path; --daemon intentionally double-forks.
const child = spawn(binary, [], { detached: true, stdio: 'ignore', env: childEnv });
let spawnError;
child.once('error', error => { spawnError = error; });
const exited = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { if (spawnError) throw spawnError; const value = await fn(); if (value) return value; await delay(100); } while (Date.now() < deadline);
  throw new Error('official release smoke timed out');
}
const remotes = [], checks = [];
function operator() {
  const fingerprint = randomUUID();
  const op = createOperator({ fingerprint, saveState() {}, rpc: async (path, body) => {
    const signal = AbortSignal.timeout(10000);
    const authorization = await highSecAuthorization(token, hub, (url, init) => fetch(url, { ...init, signal }));
    const response = await fetch(hub + path, { method: 'POST', signal, headers: fleetHubHeaders({ authorization, fingerprint }), body: JSON.stringify(body) });
    assert.equal(response.status, 200, path);
    return response.json();
  } });
  return { call: (name, args = {}) => op.callTool(name, args) };
}
async function finished(op) { return until(async () => { const value = await op.call('get_result', { device_id: device }); return isFinishedResult(value) && value; }); }
async function pluginDone(op, ticket) { return until(async () => { const value = await op.call('get_plugin_task', { device_id: device, corr: ticket.corr }); return ['done', 'failed', 'error', 'rejected'].includes(value.status) && value; }); }
try {
  const operators = Array.from({ length: 4 }, operator);
  const online = await until(async () => {
    const { computers } = await operators[0].call('list_computers');
    return computers.find(row => row.id === device && row.online);
  });
  assert.equal(online.agentVer, '0.6.7');
  assert(online.caps.includes('operation_recovery_v1'));
  if (process.argv.includes('--fail-after-online')) throw new Error('injected smoke failure after online');
  for (let round = 0; round < 5; round++) {
    const rows = await Promise.all(operators.map(async (op, i) => {
      const marker = `RELEASE_MARK_${round}_${i}`;
      await op.call('run', { device_id: device, command: `printf '${marker}\\n'`, wait_ms: 0 });
      const result = await finished(op);
      assert.equal(result.exit_code, 0); assert.equal(result.stdout.trim(), marker);
      return result.corr;
    }));
    assert.equal(new Set(rows).size, 4);
  }
  checks.push({ test: 'four operators remain isolated', operations: 20 });
  for (const transport of ['http', 'sse']) {
    const remote = await remoteMcp(hub, token, transport); remotes.push(remote);
    await remote.call('run', { device_id: device, command: `printf 'RELEASE_${transport}\\n'`, wait_ms: 0 });
    const result = await finished(remote);
    assert.equal(result.stdout.trim(), `RELEASE_${transport}`);
  }
  checks.push({ test: 'HTTP and SSE MCP authenticate, execute and deny session-only requests', transports: 2 });
  const op = operators[0], counter = home + '/executions';
  await op.call('run', { device_id: device, command: `printf 'once\\n' >> '${counter}'; sleep 2; printf 'RELEASE_RECOVERY\\n'`, wait_ms: 0 });
  const result = await finished(op);
  const recovered = await op.call('recover_session', { device_id: device });
  assert.equal(recovered.result.corr, result.corr);
  assert.equal(recovered.result.stdout.trim(), 'RELEASE_RECOVERY');
  assert.equal((await readFile(counter, 'utf8')).trim(), 'once');
  checks.push({ test: 'task result recovery retains original execution', executions: 1 });
  const configured = await op.call('configure_acp', { device_id: device, profile: 'release', command: '/usr/local/bin/node', args: ['/opt/fleet-lab/workspace/scripts/plugin-peer-vm/linux-plugin-acp.mjs'] });
  assert.equal((await pluginDone(op, configured)).ok, true);
  const tickets = await Promise.all(operators.map((o, i) => o.call('delegate_to_acp', { device_id: device, profile: 'release', cwd: home, prompt: `LABMARK_RELEASE_PLUGIN_${i} WAIT_1`, timeout_seconds: 20 })));
  for (const [i, ticket] of tickets.entries()) {
    const done = await pluginDone(operators[i], ticket);
    assert.equal(done.ok, true); assert(JSON.stringify(done).includes(`LABMARK_RELEASE_PLUGIN_${i}`));
    assert.equal((await operators[(i + 1) % operators.length].call('get_plugin_task', { device_id: device, corr: ticket.corr })).status, 'pending');
  }
  checks.push({ test: 'official ACP allow-mode configuration and per-operator task isolation', tasks: 4, artifact_version: plugin.version });
  await writeFile(home + '/evidence.json', JSON.stringify({ passed: true, version: online.agentVer, binary_sha256: expectedBinaryHash, checks }), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, version: online.agentVer, binary_sha256: expectedBinaryHash, checks }));
} catch (error) {
  await writeFile(home + '/evidence.json', JSON.stringify({ passed: false, binary_sha256: expectedBinaryHash, checks, error: String(error.stack || error) }), { mode: 0o600 });
  throw error;
} finally {
  for (const remote of remotes) await remote.close().catch(() => {});
  const stop = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  stop('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  stop('SIGKILL');
  await exited;
}
