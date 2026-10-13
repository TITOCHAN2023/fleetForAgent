// Fixed-build, guest-only Worker runtime. No development watcher/inspector.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

assert.equal(process.platform, 'linux');
assert.equal(hostname(), 'lima-linux-a');
assert.notEqual(process.getuid(), 0);
const state = '/var/lib/fleet-hub-lab';
const config = JSON.parse(await readFile(state + '/wrangler.json', 'utf8'));
const secrets = await readFile(state + '/.dev.vars', 'utf8');
const key = secrets.match(/^VM_SEED_KEY=([a-f0-9]{64})$/m)?.[1];
assert(key);
const { outputFiles } = await build({
  entryPoints: [config.main], bundle: true, write: false, format: 'esm',
  platform: 'browser', target: 'es2022', external: ['cloudflare:*'],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  name: config.name, modules: true, script: outputFiles[0].text,
  compatibilityDate: config.compatibility_date, host: '0.0.0.0', port: 8787,
  bindings: { ...config.vars, VM_SEED_KEY: key },
  durableObjects: Object.fromEntries(config.durable_objects.bindings.map(b =>
    [b.name, { className: b.class_name, useSQLite: true }])),
  resourcePersistencePath: state + '/state/v3',
}));
console.log('Isolated Worker ready:', String(await mf.ready));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await mf.dispose();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
