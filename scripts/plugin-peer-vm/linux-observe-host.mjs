import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
const lab = process.argv[2];
assert.match(lab || '', /^\/private\/tmp\/flab-[a-zA-Z0-9]+$/);
const runId = process.argv[3] || 'health-final';
const samples = Number(process.argv[4] || 61);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 361);
assert.match(runId, /^[a-zA-Z0-9_-]+$/);
const env = { ...process.env, LIMA_HOME: lab + '/lima' };
async function snapshot(vm) {
  const child = spawn('limactl', ['shell', vm, '--', 'sudo', 'node', '/tmp/linux-health.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
  if (code) throw new Error(err); return JSON.parse(out);
}
for (let i = 0; i < samples; i++) {
  const rows = await Promise.all(['linux-a', 'linux-b'].map(snapshot));
  for (const row of rows) await appendFile(lab + '/' + runId + '.ndjson', JSON.stringify(row) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ sample: i, at: rows[0].at, machines: rows.map(r => ({ host: r.hostname, connection: r.agent.conn, units: r.units.map(u => ({ name: u.unit, pid: u.MainPID, restarts: u.NRestarts, memory_mib: Math.round(Number(u.MemoryCurrent) / 1048576), fd: u.fd })) })) }));
  if (i + 1 < samples) await new Promise(r => setTimeout(r, 30000));
}
