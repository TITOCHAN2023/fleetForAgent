// Host-side fault controller. Only the named, disposable Lima lab is writable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const lab = process.argv[2], runId = process.argv[3];
assert.match(lab || '', /^\/private\/tmp\/flab-[a-zA-Z0-9]+$/);
assert.match(runId || '', /^[a-zA-Z0-9_-]+$/);
const env = { ...process.env, LIMA_HOME: lab + '/lima' };
const command = (...args) => new Promise((resolve, reject) => {
  const p = spawn('limactl', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
  p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
  p.once('error', reject); p.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)));
});
const shell = (vm, ...args) => command('shell', vm, '--', 'sudo', ...args);
for (const vm of ['linux-a', 'linux-b']) {
  const hostname = await shell(vm, 'hostname'); assert.equal(hostname, 'lima-' + vm);
}
const base = `/var/lib/fleet-lab/${runId}`;
const child = spawn('limactl', ['shell', 'linux-a', '--', 'sudo', '-u', 'fleet-test', 'node', '/opt/fleet-lab/workspace/scripts/plugin-peer-vm/linux-suite.mjs', 'faults', runId], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let exited = false, transcript = '', last = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { transcript += b; process.stdout.write(b); });
const completion = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
const deadline = Date.now() + 10 * 60000;
try {
  while (!exited && Date.now() < deadline) {
    let request;
    try { request = JSON.parse(await shell('linux-a', 'cat', base + '/control.json')); } catch { /* not requested yet */ }
    if (request && request.id > last) {
      last = request.id; let value, error;
      try {
        if (request.action === 'disconnect') {
          await shell('linux-b', 'nft', 'add', 'table', 'inet', 'fleet_fault');
          await shell('linux-b', 'nft', 'add', 'chain', 'inet', 'fleet_fault', 'output', '{ type filter hook output priority -10; policy accept; }');
          value = await shell('linux-b', 'nft', 'add', 'rule', 'inet', 'fleet_fault', 'output', 'ip', 'daddr', '192.168.117.1', 'tcp', 'dport', '8787', 'drop');
        } else if (request.action === 'connect') value = await shell('linux-b', 'nft', 'delete', 'table', 'inet', 'fleet_fault');
        else if (request.action === 'hub-restart') value = await shell('linux-a', 'systemctl', 'restart', 'fleet-lab-hub');
        else if (request.action === 'agent-restart') value = await shell('linux-b', 'systemctl', 'restart', 'fleet-lab-agent');
        else if (request.action === 'agent-crash') value = await shell('linux-b', 'systemctl', 'kill', '--kill-whom=all', '--signal=SIGKILL', 'fleet-lab-agent');
        else if (request.action === 'read') {
          assert.match(request.file || '', /^[a-z0-9-]+$/);
          value = await shell('linux-b', 'cat', `/var/lib/fleet-lab/${runId}-${request.file}`);
        } else throw new Error('unknown fault action');
      } catch (e) { error = e.message; }
      await writeFile(lab + '/control-result.json', JSON.stringify({ id: last, value, error }), { mode: 0o600 });
      await command('copy', lab + '/control-result.json', 'linux-a:/tmp/control-result.json');
      await shell('linux-a', 'install', '-o', 'fleet-test', '-g', 'fleet-test', '-m600', '/tmp/control-result.json', base + '/control-result.json');
    }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!exited) { child.kill(); throw new Error('VM fault suite exceeded ten minutes'); }
  assert.equal(await completion, 0);
} finally {
  await shell('linux-b', 'nft', 'delete', 'table', 'inet', 'fleet_fault').catch(() => {});
  await writeFile(lab + '/' + runId + '.log', transcript, { mode: 0o600 });
}
