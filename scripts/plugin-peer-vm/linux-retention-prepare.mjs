// Fresh disposable workload namespace; the previous lab's receipts stay intact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
const host = execFileSync('hostname', { encoding: 'utf8' }).trim();
assert.match(host, /^lima-linux-[ab]$/);
const original = '/var/lib/fleet-lab/agent';
const name = process.argv[2] || 'retention-agent';
assert.match(name, /^(retention|integration)-[a-z0-9-]+$/);
const target = '/var/lib/fleet-lab/' + name;
assert(!existsSync(target), 'never overwrite an existing test namespace');
const receipts = readdirSync(original + '/operations').length;
cpSync(original, target, { recursive: true, filter: p => p !== original + '/operations' });
execFileSync('chown', ['-R', 'fleet-test:fleet-test', target]);
const override = '/etc/systemd/system/fleet-lab-agent.service.d';
mkdirSync(override, { recursive: true });
writeFileSync(override + '/retention.conf', '[Service]\nEnvironment=FLEET_HOME=' + target + '\n');
for (const name of host.endsWith('-a') ? ['leader', 'peer-a'] : ['peer-b']) {
  execFileSync('install', ['-d', '-o', 'fleet-test', '-g', 'fleet-test', '-m700', '/dev/shm/fleet-' + name]);
}
execFileSync('systemctl', ['daemon-reload']);
assert.equal(readdirSync(original + '/operations').length, receipts);
console.log(JSON.stringify({ host, original_receipts_preserved: receipts, fresh_state: target }));
