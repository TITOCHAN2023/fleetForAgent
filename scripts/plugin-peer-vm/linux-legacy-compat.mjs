// Run a main-branch Agent alongside the candidate in the disposable VM only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createOperator, fleetHubHeaders, isFinishedResult } from '../../packages/fleet-tool/operator.mjs';
import { highSecAuthorization } from '../../packages/fleet-worker/src/tokenv1.mjs';

assert.equal(process.platform, 'linux');
assert.equal(hostname(), 'lima-linux-b');
assert.notEqual(process.getuid(), 0);
const base = '/var/lib/fleet-lab';
const hub = 'http://fleet-hub.test:8787';
const { token } = JSON.parse(await readFile(base + '/seed.json'));
const home = await mkdtemp(base + '/legacy-compat-');
const device = '33333333-3333-4333-8333-333333333333';
await writeFile(home + '/config.json', JSON.stringify({ enabled: true, permit: 'allow', hubInput: hub, hubToken: token, deviceId: device, autoUpdate: false }), { mode: 0o600 });
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('FLEET_')) delete childEnv[key];
Object.assign(childEnv, { FLEET_HOME: home, FLEET_URL: hub, FLEET_TOKEN: token,
  FLEET_ENABLED: 'true', FLEET_SETTINGS_ADDR: '127.0.0.1:17891', FLEET_AUTO_UPDATE: 'false' });
// Supervise the no-args service path; --daemon intentionally double-forks.
const child = spawn('/opt/fleet-lab/fleet-agent-main-compat', [], {
  env: childEnv,
  // Own this disposable service and its children without daemon double-fork.
  detached: true,
  stdio: 'ignore',
});
let spawnError;
child.once('error', error => { spawnError = error; });
const exited = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = randomUUID();
const runs = [];
const op = createOperator({ fingerprint, saveState() {}, rpc: async (path, body) => {
  if (path === '/v1/run') runs.push(body);
  const signal = AbortSignal.timeout(10000);
  const authorization = await highSecAuthorization(token, hub, (url, init) => fetch(url, { ...init, signal }));
  const response = await fetch(hub + path, { method: 'POST', signal, headers: fleetHubHeaders({ authorization, fingerprint }), body: JSON.stringify(body) });
  assert.equal(response.status, 200, path);
  return response.json();
} });
try {
  let online;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    const { computers } = await op.callTool('list_computers');
    online = computers.find(row => row.id === device && row.online && row.caps?.includes('shell'));
    if (online) break;
    await delay(100);
  }
  assert(online, 'main-branch Agent did not connect');
  assert(!online.caps.includes('operation_recovery_v1'));
  await op.callTool('run', { device_id: device, command: `echo once >> '${home}/count'; printf 'LEGACY_OK\\n'`, wait_ms: 0 });
  let result;
  for (let i = 0; i < 100; i++) {
    result = await op.callTool('get_result', { device_id: device });
    if (isFinishedResult(result)) break;
    await delay(100);
  }
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.trim(), 'LEGACY_OK');
  assert.equal(runs.length, 1);
  assert(!Object.hasOwn(runs[0], 'request_id'));
  await assert.rejects(op.callTool('run', { device_id: device, command: 'echo forbidden-recovery', request_id: randomUUID() }), /update the Agent/);
  assert.equal(runs.length, 1);
  assert.equal((await readFile(home + '/count', 'utf8')).trim(), 'once');
  console.log(JSON.stringify({ test: 'main-branch Agent works with candidate Hub and Tool; unsupported recovery rejected before dispatch', passed: true, executions: 1, agent_version: online.agentVer }));
} finally {
  const stop = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  stop('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  // Reap any remaining children even when the service already exited.
  stop('SIGKILL');
  await exited;
}
