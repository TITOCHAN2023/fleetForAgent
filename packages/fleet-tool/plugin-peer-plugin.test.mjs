import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createPluginPeerLauncher,
  createPluginPeerResolver,
  launchPluginPeerProcess,
  pluginPeerPluginInternals,
  resolvePluginPeerArtifact,
} from "./plugin-peer-plugin.mjs";

function platformName() {
  return process.platform === "win32" ? "windows" : process.platform;
}

function archName() {
  return process.arch === "x64" ? "amd64" : process.arch;
}

function catalogFor(bytes, entrypoint = "example-peer") {
  return [{
    schema_version: 1,
    id: "example.peer",
    version: "1.2.3",
    installable: true,
    runtime: "task",
    actions: ["source", "target"],
    action_specs: {
      source: { runtime: "peer", role: "source" },
      target: { runtime: "peer", role: "target" },
    },
    peer_protocols: [{
      id: "example.bytes.v1",
      abi: "fleet.plugin.peer.v1",
      transport: "direct_ordered",
      approval: "both_once",
      roles: { source: "source", target: "target" },
    }],
    artifacts: [{
      os: platformName(),
      arch: archName(),
      url: "https://example.invalid/example-peer",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      entrypoint,
    }],
  }];
}

test("peer resolver uses only the pinned catalog and verified FLEET_PLUGIN_DIR layout", async () => {
  const bytes = Buffer.from("verified plugin\n");
  const catalog = catalogFor(bytes);
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "fleet-peer-plugin-")));
  const target = path.join(root, "example.peer", "1.2.3", "example-peer");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o700 });
  const resolve = createPluginPeerResolver({ catalog, pluginDir: root });
  const resolved = await resolve("example.peer", "example.bytes.v1", "source");
  assert.equal(resolved.path, target);
  assert.equal(resolved.dataDir, path.join(root, "example.peer", "data"));
  assert.equal(resolved.action, "source");

  await writeFile(target, Buffer.from("tampered\n"), { mode: 0o700 });
  await assert.rejects(() => resolve("example.peer", "example.bytes.v1", "source"), (error) => error?.code === "plugin_tampered");
  assert.throws(() => resolvePluginPeerArtifact(catalog, "example.peer", "unknown", "source"), /does not declare/i);
});

test("a verified cached plugin is independent of the network download deadline", async () => {
  const bytes = Buffer.from("cached plugin\n");
  const catalog = catalogFor(bytes);
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-cache-"));
  const target = path.join(root, "example.peer", "1.2.3", "example-peer");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o700 });
  let fetches = 0;
  const resolve = createPluginPeerResolver({
    catalog,
    cacheRoot: root,
    pluginDir: "",
    downloadTimeoutMs: 0,
    fetchImpl: async () => { fetches += 1; throw new Error("network must not run"); },
  });
  const resolved = await resolve("example.peer", "example.bytes.v1", "source");
  assert.equal(resolved.path, target);
  assert.equal(fetches, 0);
});

test("plugin mirror and origin retries share one hard download deadline", { timeout: 2000 }, async () => {
  const bytes = Buffer.from("downloaded plugin\n");
  const catalog = catalogFor(bytes);
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-deadline-"));
  const signals = [];
  const authorizationSignals = [];
  let calls = 0;
  let expire;
  let markSecondStarted;
  const secondStarted = new Promise((resolveStarted) => { markSecondStarted = resolveStarted; });
  let timers = 0;
  let cleared = 0;
  const resolve = createPluginPeerResolver({
    catalog,
    cacheRoot: root,
    pluginDir: "",
    hubOrigin: "https://hub.example",
    downloadTimeoutMs: 25,
    setTimeoutImpl(callback) {
      timers += 1;
      expire = callback;
      return "download-timer";
    },
    clearTimeoutImpl(timer) {
      assert.equal(timer, "download-timer");
      cleared += 1;
    },
    authorization({ signal }) {
      authorizationSignals.push(signal);
      return "Fleet-OAEP test";
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      signals.push(options.signal);
      if (calls === 1) throw new Error("mirror unavailable");
      markSecondStarted();
      return new Promise(() => {});
    },
  });
  const resolving = resolve("example.peer", "example.bytes.v1", "source");
  await secondStarted;
  expire();
  await assert.rejects(
    () => resolving,
    (error) => error?.code === "plugin_download_timeout",
  );
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1], "candidate retry received a fresh deadline signal");
  assert.deepEqual(authorizationSignals, signals, "authorization escaped the shared download deadline");
  assert.equal(signals[0].aborted, true);
  assert.equal(timers, 1, "candidate retry allocated another deadline");
  assert.equal(cleared, 1);
});

test("download abort interrupts a blocked response body and cancels its reader", async () => {
  const bytes = Buffer.from("downloaded plugin\n");
  const catalog = catalogFor(bytes);
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-body-abort-"));
  const controller = new AbortController();
  let readerCancelled = false;
  let fetchSignal;
  let markReadStarted;
  const readStarted = new Promise((resolveStarted) => { markReadStarted = resolveStarted; });
  const resolve = createPluginPeerResolver({
    catalog,
    cacheRoot: root,
    pluginDir: "",
    downloadTimeoutMs: 5000,
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              read: () => {
                markReadStarted();
                return new Promise(() => {});
              },
              cancel: async () => { readerCancelled = true; },
              releaseLock() {},
            };
          },
        },
      };
    },
  });
  const resolving = resolve("example.peer", "example.bytes.v1", "source", { signal: controller.signal });
  await readStarted;
  controller.abort();
  await assert.rejects(() => resolving, (error) => error?.code === "cancelled");
  assert.equal(fetchSignal.aborted, true);
  assert.equal(readerCancelled, true);
});

test("plugin stdin backpressure has a hard deadline and close or abort wakes every waiter", async () => {
  class BlockedStream extends EventEmitter {
    destroyed = false;
    writable = true;
    write() { return false; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.writable = false;
      this.emit("close");
    }
  }

  const timed = new BlockedStream();
  await assert.rejects(
    () => pluginPeerPluginInternals.writeStream(timed, Buffer.from("x"), { timeoutMs: 20 }),
    (error) => error?.code === "backpressure",
  );
  assert.equal(timed.destroyed, true);

  const closed = new BlockedStream();
  const closeWait = pluginPeerPluginInternals.writeStream(closed, Buffer.from("x"), { timeoutMs: 1000 });
  closed.destroy();
  await assert.rejects(() => closeWait, (error) => error?.code === "plugin_protocol");

  const aborted = new BlockedStream();
  const controller = new AbortController();
  const abortWait = pluginPeerPluginInternals.writeStream(aborted, Buffer.from("x"), {
    signal: controller.signal,
    timeoutMs: 1000,
  });
  controller.abort();
  await assert.rejects(() => abortWait, (error) => error?.code === "cancelled");
  assert.equal(aborted.destroyed, true);
});

test("malformed FLPP output kills the whole plugin process group", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-tree-"));
  const executable = path.join(root, "bad-peer.mjs");
  const pidFile = path.join(root, "descendant.pid");
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(process.env.FLEET_TEST_DESCENDANT, String(child.pid));
process.stdout.write(Buffer.alloc(12, 0x41));
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.FLEET_TEST_DESCENDANT;
  process.env.FLEET_TEST_DESCENDANT = pidFile;
  try {
    const peer = launchPluginPeerProcess({ path: executable, action: "source", input: {}, peer: {} });
    await assert.rejects(() => peer.next(), (error) => error?.code === "plugin_protocol");
    let pid = 0;
    const deadline = Date.now() + 2000;
    while (!pid && Date.now() < deadline) {
      try {
        pid = Number((await readFile(pidFile, "utf8")).trim());
      } catch {
        // The descendant has not written its pid yet.
      }
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, "descendant pid was not recorded");
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`plugin descendant ${pid} survived malformed-output abort`);
  } finally {
    if (previous == null) delete process.env.FLEET_TEST_DESCENDANT;
    else process.env.FLEET_TEST_DESCENDANT = previous;
  }
});

test("launcher preserves a plugin open error and aborts its process tree", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-open-"));
  const executable = path.join(root, "not-ready.mjs");
  const pidFile = path.join(root, "plugin.pid");
  const envFile = path.join(root, "plugin-env.json");
  const dataDir = path.join(root, "example.peer", "data");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status: "error", code: "invalid_request", error: "peer has unknown fields" }));
const header = Buffer.alloc(12);
header.write("FLPP", 0, "ascii");
header.writeUInt8(1, 4);
header.writeUInt8(1, 5);
header.writeUInt32BE(payload.length, 8);
writeFileSync(process.env.FLEET_TEST_PLUGIN_PID, String(process.pid));
writeFileSync(process.env.FLEET_TEST_PLUGIN_ENV, JSON.stringify({
  pluginId: process.env.FLEET_PLUGIN_ID,
  dataDir: process.env.FLEET_PLUGIN_DATA_DIR,
}));
process.stdout.write(Buffer.concat([header, payload]));
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.FLEET_TEST_PLUGIN_PID;
  const previousEnv = process.env.FLEET_TEST_PLUGIN_ENV;
  process.env.FLEET_TEST_PLUGIN_PID = pidFile;
  process.env.FLEET_TEST_PLUGIN_ENV = envFile;
  try {
    let resolverSignal;
    const launch = createPluginPeerLauncher({
      resolve: async (_pluginId, _protocol, _role, options) => {
        resolverSignal = options?.signal;
        return { path: executable, action: "source", dataDir };
      },
    });
    const controller = new AbortController();
    await assert.rejects(
      () => launch({
        pluginId: "example.peer",
        protocol: "example.bytes.v1",
        role: "source",
        input: {},
        peer: {},
        signal: controller.signal,
      }),
      (error) => error?.code === "invalid_request" && /unknown fields/.test(error.message),
    );
    assert.equal(resolverSignal, controller.signal);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0, "plugin pid was not recorded");
    assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {
      pluginId: "example.peer",
      dataDir,
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`plugin ${pid} survived failed open handshake`);
  } finally {
    if (previous == null) delete process.env.FLEET_TEST_PLUGIN_PID;
    else process.env.FLEET_TEST_PLUGIN_PID = previous;
    if (previousEnv == null) delete process.env.FLEET_TEST_PLUGIN_ENV;
    else process.env.FLEET_TEST_PLUGIN_ENV = previousEnv;
  }
});

test("cancel cannot hang behind plugin stdin backpressure and kills the process group", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-cancel-"));
  const executable = path.join(root, "blocked-peer.mjs");
  const pidFile = path.join(root, "descendant.pid");
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status: "ready" }));
const header = Buffer.alloc(12);
header.write("FLPP", 0, "ascii");
header.writeUInt8(1, 4);
header.writeUInt8(1, 5);
header.writeUInt32BE(payload.length, 8);
const child = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(process.env.FLEET_TEST_DESCENDANT, String(child.pid));
process.stdout.write(Buffer.concat([header, payload]));
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.FLEET_TEST_DESCENDANT;
  process.env.FLEET_TEST_DESCENDANT = pidFile;
  try {
    const peer = launchPluginPeerProcess({
      path: executable,
      pluginId: "example.peer",
      dataDir: path.join(root, "data"),
      action: "source",
      input: {},
      peer: {},
      writeTimeoutMs: 5000,
      cancelWriteTimeoutMs: 20,
    });
    await peer.open();
    let blocked;
    for (let index = 0; index < 128 && !blocked; index += 1) {
      const attempt = peer.writeData(Buffer.alloc(32 << 10));
      const outcome = await Promise.race([
        attempt.then(() => "drained", (error) => error),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 10)),
      ]);
      if (outcome === "blocked") blocked = attempt;
      else if (outcome instanceof Error) throw outcome;
    }
    assert.ok(blocked, "test could not fill the unread plugin stdin pipe");

    const started = Date.now();
    await peer.cancel();
    assert.ok(Date.now() - started < 1500, "cancel waited on plugin stdin backpressure");
    await assert.rejects(() => blocked, (error) => ["plugin_protocol", "cancelled"].includes(error?.code));

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0, "descendant pid was not recorded");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`plugin descendant ${pid} survived backpressured cancel`);
  } finally {
    if (previous == null) delete process.env.FLEET_TEST_DESCENDANT;
    else process.env.FLEET_TEST_DESCENDANT = previous;
  }
});
