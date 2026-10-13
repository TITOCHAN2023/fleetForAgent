// Guest-only provisioning for disposable Lima VMs. Never run on the host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { OFFICIAL_PLUGIN_CATALOG } from '../../packages/fleet-tool/official-plugins.generated.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
assert.match(execFileSync('hostname', { encoding: 'utf8' }), /^lima-linux-[ab]\s*$/);
const base = '/opt/fleet-lab';
const root = base + '/workspace';
const state = '/var/lib/fleet-lab';
const hubState = '/var/lib/fleet-hub-lab';
const hub = 'http://fleet-hub.test:8787';
const put = (file, value) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
function unit(name, user, command, env, extra = '') {
  put(`/etc/systemd/system/${name}.service`, `[Unit]\nDescription=Disposable Fleet lab ${name}\nAfter=network.target\n[Service]\nUser=${user}\nWorkingDirectory=${root}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\n${env.map(v => `Environment=${v}`).join('\n')}\nExecStart=${command}\nRestart=on-failure\nRestartSec=2\nMemoryMax=${name === 'fleet-lab-hub' ? '2G' : '1G'}\nTasksMax=256\nKillMode=control-group\n${extra}\n[Install]\nWantedBy=multi-user.target\n`);
}
const mode = process.argv[2];
if (mode === 'hosts') {
  const hosts = readFileSync('/etc/hosts', 'utf8');
  if (!hosts.includes('fleet-hub.test')) put('/etc/hosts', hosts + '\n192.168.117.1 fleet-hub.test\n192.168.117.3 fleet-b.test\n');
  run('chmod', '644', '/etc/hosts');
} else if (mode === 'stun') {
  unit('fleet-lab-stun', 'fleet-test', base + '/stun', []);
  run('systemctl', 'daemon-reload'); run('systemctl', 'start', 'fleet-lab-stun');
} else if (mode === 'hub') {
  mkdirSync(base + '/runtime', { recursive: true });
  put(base + '/runtime/package.json', { private: true, dependencies: { wrangler: '4.125.0', miniflare: '5.20260820.0-alpha', esbuild: '0.28.1', werift: '0.24.4', ws: '8.18.3' } });
  run('npm', 'install', '--prefix', base + '/runtime', '--ignore-scripts', '--no-audit', '--no-fund');
  run('chmod', '644', base + '/runtime/package.json');
  mkdirSync(base + '/runtime/node_modules/.mf', { recursive: true });
  run('chown', 'fleet-hub:fleet-hub', base + '/runtime/node_modules/.mf');
  if (!existsSync(root + '/node_modules')) run('ln', '-s', base + '/runtime/node_modules', root + '/node_modules');
  const classes = { DEVICE: 'DeviceDO', FLEET: 'FleetDO', MCP: 'McpDO', PEER_SESSION: 'PeerSessionDO', REVOCATION: 'RevocationDO', ROOM_RELAY: 'RoomRelayDO' };
  put(hubState + '/wrangler.json', { name: 'fleet-linux-vm-lab', main: root + '/scripts/plugin-peer-vm/recovery-worker.ts', compatibility_date: '2026-04-07', workers_dev: false, vars: { HUB_ORIGIN: hub, RTC_STUN_URLS: 'stun:fleet-hub.test:3478' }, durable_objects: { bindings: Object.entries(classes).map(([name, class_name]) => ({ name, class_name })) }, migrations: [{ tag: 'v1', new_sqlite_classes: Object.values(classes) }] });
  const key = randomBytes(32).toString('hex');
  put(hubState + '/.dev.vars', `VM_SEED_KEY=${key}\n`);
  put(state + '/seed-key', key);
  run('chown', '-R', 'fleet-hub:fleet-hub', hubState);
  run('chown', 'fleet-test:fleet-test', state + '/seed-key');
  unit('fleet-lab-hub', 'fleet-hub', `/usr/local/bin/node ${root}/scripts/plugin-peer-vm/linux-hub.mjs`, ['WRANGLER_SEND_METRICS=false', 'CI=true']);
  run('systemctl', 'daemon-reload');
  run('systemctl', 'start', 'fleet-lab-hub');
} else if (mode === 'agent') {
  const label = process.argv[3];
  assert(['a', 'b'].includes(label));
  const { token } = JSON.parse(readFileSync(state + '/seed.json'));
  mkdirSync(state + '/agent', { recursive: true, mode: 0o700 });
  put(state + '/agent/config.json', { enabled: true, permit: 'allow', hubInput: hub, hubToken: token, deviceId: label === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', autoUpdate: false });
  run('chown', '-R', 'fleet-test:fleet-test', state);
  unit('fleet-lab-agent', 'fleet-test', base + '/fleet-agent', [`FLEET_HOME=${state}/agent`, 'FLEET_SETTINGS_ADDR=127.0.0.1:17890', `FLEET_NAME=linux-${label}`, 'FLEET_AUTO_UPDATE=false']);
  run('systemctl', 'daemon-reload');
  run('systemctl', 'start', 'fleet-lab-agent');
} else if (mode === 'plugin') {
  // Offline provisioning of the exact official release, not a permissive fake
  // manifest. Download/install transport is not covered by this lab step.
  const plugin = OFFICIAL_PLUGIN_CATALOG.find(p => p.id === 'fleet.acp');
  const artifact = plugin.artifacts.find(a => a.os === 'linux' && a.arch === 'arm64');
  const binary = readFileSync('/tmp/fleet-acp-plugin');
  assert.equal(createHash('sha256').update(binary).digest('hex'), artifact.sha256);
  const dir = state + '/agent/plugins/fleet.acp';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(dir + '/' + artifact.entrypoint, binary, { mode: 0o700 });
  put(dir + '/metadata.json', { id: plugin.id, name: plugin.name, version: plugin.version, publisher: plugin.publisher, license: plugin.license, repository: plugin.repository, artifact_url: artifact.url, sha256: artifact.sha256, entrypoint: artifact.entrypoint, actions: plugin.actions, approval_actions: plugin.approval_actions, runtime: plugin.runtime, action_specs: plugin.action_specs, peer_protocols: plugin.peer_protocols, installed_at: Date.now() });
  run('chown', '-R', 'fleet-test:fleet-test', state + '/agent/plugins');
} else if (mode === 'room') {
  const ids = process.argv.slice(3);
  const { token } = JSON.parse(readFileSync(state + '/seed.json'));
  put(state + '/room.env', `FLEET_TOKEN=${token}\n`);
  for (const id of ids) {
    assert(['leader', 'peer-a', 'peer-b'].includes(id));
    const cliStateDir = '/dev/shm/fleet-' + id;
    mkdirSync(cliStateDir, { recursive: true, mode: 0o700 });
    run('chown', 'fleet-test:fleet-test', cliStateDir);
    put(state + `/${id}.json`, { url: hub, id, name: 'same-display-name', leader: id === 'leader', capacity: 2, dataDir: state + '/room-' + id, fleetHome: state + '/agent', cliStateDir, cwd: state, command: '/usr/local/bin/node', args: [root + '/scripts/plugin-peer-vm/linux-acp.mjs'], pollMs: 250 });
    run('chown', 'fleet-test:fleet-test', state + `/${id}.json`);
    unit('fleet-lab-' + id, 'fleet-test', `/usr/local/bin/node ${root}/packages/fleet-room/cli.mjs ${state}/${id}.json`, [], `EnvironmentFile=${state}/room.env`);
  }
  run('systemctl', 'daemon-reload');
  for (const id of ids) run('systemctl', 'start', 'fleet-lab-' + id);
} else if (mode === 'isolate') {
  // INPUT allows SSH management and lab traffic only. OUTPUT disallows DNS,
  // internet and access to the Lima host gateway. Never install on a real host.
  const peers = process.argv.slice(3);
  assert.equal(peers.length, 2);
  for (const ip of peers) assert.match(ip, /^192\.168\.117\.\d+$/);
  const rules = `table inet fleet_lab {\nchain input { type filter hook input priority 0; policy drop; iifname lo accept; ct state established,related accept; tcp dport 22 accept; ip saddr { ${peers.join(', ')} } accept; }\nchain output { type filter hook output priority 0; policy drop; oifname lo accept; ct state established,related accept; ip daddr { ${peers.join(', ')} } accept; }\n}\n`;
  put(state + '/isolation.nft', rules);
  run('nft', '-f', state + '/isolation.nft');
} else throw new Error('unknown mode');
