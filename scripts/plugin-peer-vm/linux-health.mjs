// Redacted health evidence; never exports token/config contents or task output.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
const hostname = execFileSync('hostname', { encoding: 'utf8' }).trim();
if (!/^lima-linux-[ab]$/.test(hostname)) throw new Error('disposable VM only');
const names = hostname.endsWith('-a') ? ['agent', 'hub', 'leader', 'peer-a'] : ['agent', 'peer-b'];
const units = [];
for (const name of names) {
  const unit = 'fleet-lab-' + name + '.service';
  const values = Object.fromEntries(execFileSync('systemctl', ['show', unit, '-p', 'MainPID', '-p', 'NRestarts', '-p', 'MemoryCurrent', '-p', 'ActiveState'], { encoding: 'utf8' }).trim().split('\n').map(s => s.split('=')));
  const pid = Number(values.MainPID);
  const fd = pid ? readdirSync(`/proc/${pid}/fd`).length : 0;
  const oom = readFileSync(`/sys/fs/cgroup/system.slice/${unit}/memory.events`, 'utf8').trim();
  const memory = Object.fromEntries(readFileSync(`/sys/fs/cgroup/system.slice/${unit}/memory.stat`, 'utf8').trim().split('\n').map(s => s.split(' ')));
  const rssKiB = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
  units.push({ unit, ...values, fd, oom, anonBytes: Number(memory.anon), rssKiB });
}
const r = JSON.parse(execFileSync('/opt/fleet-lab/fleet-agent', ['status', '--json'], { encoding: 'utf8', env: { ...process.env, FLEET_HOME: '/var/lib/fleet-lab/agent' } }));
const row = { at: new Date().toISOString(), hostname, units, agent: { conn: r.conn, enabled: r.enabled, permit: r.permit, version: r.agentVer, autoUpdate: r.autoUpdate } };
appendFileSync('/var/lib/fleet-lab/health.ndjson', JSON.stringify(row) + '\n', { mode: 0o600 });
console.log(JSON.stringify(row));
