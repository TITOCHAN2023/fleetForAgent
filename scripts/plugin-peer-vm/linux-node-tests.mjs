import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readdir, writeFile } from 'node:fs/promises';
assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
assert.match(hostname(), /^lima-linux-[ab]$/);
const root = '/opt/fleet-lab/workspace';
const tests = [];
for (const dir of ['packages/fleet-tool', 'packages/fleet-room']) {
  for (const file of await readdir(root + '/' + dir)) if (!file.startsWith('.') && file.endsWith('.test.mjs')) tests.push(dir + '/' + file);
}
tests.push('packages/fleet-worker/tokenv1.test.mjs');
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { log += b; });
const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
await writeFile('/var/lib/fleet-lab/node-tests.log', log, { mode: 0o600 });
console.log(log.slice(log.lastIndexOf('\n1..')));
if (code) for (const m of log.matchAll(/^not ok[^]*?(?=^# Subtest:|^1\.\.)/gm)) console.error(m[0]);
process.exitCode = code;
