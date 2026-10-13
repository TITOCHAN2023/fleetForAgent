// Export explicit redacted evidence only. Never copy private config/state trees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const [lab, ...runs] = process.argv.slice(2);
assert.match(lab || '', /^\/private\/tmp\/flab-[a-zA-Z0-9]+$/);
assert(runs.length > 0 && runs.length <= 30);
const env = { ...process.env, LIMA_HOME: lab + '/lima' };
await mkdir(lab + '/evidence', { recursive: true, mode: 0o700 });
for (const run of runs) {
  assert.match(run, /^[a-zA-Z0-9_-]+$/);
  const text = execFileSync('limactl', ['shell', 'linux-a', '--', 'sudo', 'cat',
    `/var/lib/fleet-lab/${run}/evidence.ndjson`], { env, encoding: 'utf8', timeout: 30000 });
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  // Evidence schema deliberately excludes tokens, request headers and configs.
  assert(rows.every(row => typeof row.test === 'string' && typeof row.passed === 'boolean'));
  await writeFile(`${lab}/evidence/${run}.ndjson`, text, { mode: 0o600 });
  console.log(JSON.stringify({ run, checks: rows.length, passed: rows.filter(r => r.passed).length }));
}
