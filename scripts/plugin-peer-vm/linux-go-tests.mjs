// Run cross-compiled Go tests only inside disposable unprivileged Linux guests.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
assert.match(execFileSync('hostname', { encoding: 'utf8' }), /^lima-linux-[ab]\s*$/);
const out = '/var/lib/fleet-lab/go-tests';
await mkdir(out, { recursive: true, mode: 0o700 });
for (const name of ['agent', 'pane', 'backend', 'policy']) {
  const source = '/opt/fleet-lab/workspace/packages/fleet-agent';
  const subdir = { agent: '', pane: '/internal/pane', backend: '/internal/pane/backend', policy: '/internal/policy' }[name];
  const child = spawn('/opt/fleet-lab/' + name + '.test', ['-test.v', '-test.timeout=8m'], { cwd: source + subdir,
    env: { ...process.env, PATH: '/usr/local/go/bin:' + process.env.PATH, GOFLAGS: '-mod=vendor', GOCACHE: '/var/lib/fleet-lab/go-cache', GOMAXPROCS: '2', FLEET_OPERATION_LAB: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
  await appendFile(out + '/' + name + '-complete.log', log, { mode: 0o600 });
  console.log(JSON.stringify({ suite: name, exit_code: code, passed: (log.match(/^--- PASS:/gm) || []).length, skipped: (log.match(/^--- SKIP:/gm) || []).length }));
  if (code !== 0) { console.error(log.slice(-16000)); process.exitCode = 1; }
}
