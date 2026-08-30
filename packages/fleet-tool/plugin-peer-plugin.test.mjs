import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

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

function statusRecord(status) {
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status }));
  const header = Buffer.alloc(12);
  header.write("FLPP", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function fakeReceiptChild({ lateStatusMs = 20 } = {}) {
  const child = new EventEmitter();
  child.pid = 0;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let input = Buffer.alloc(0);
  child.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 12) {
      const length = input.readUInt32BE(8);
      if (input.length < 12 + length) return;
      const control = JSON.parse(input.subarray(12, 12 + length).toString("utf8"));
      input = input.subarray(12 + length);
      if (control.type === "open") child.stdout.write(statusRecord("ready"));
      if (control.type === "cancel") {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
          setTimeout(() => {
            child.stdout.once("end", () => child.emit("close", 0, null));
            child.stdout.end(statusRecord("canceled"));
          }, lateStatusMs);
        });
      }
    }
  });
  return child;
}

test("pre-aborted production process launch never calls spawn", () => {
  const controller = new AbortController();
  controller.abort();
  let spawns = 0;
  assert.throws(
    () => launchPluginPeerProcess({
      path: "/never/spawn",
      pluginId: "example.peer",
      dataDir: "/never/data",
      action: "source",
      input: {},
      peer: {},
      signal: controller.signal,
      spawnImpl: () => { spawns += 1; throw new Error("spawn must not run"); },
    }),
    (error) => error?.code === "cancelled",
  );
  assert.equal(spawns, 0);
});

test("Windows plugin spawn uses the packaged Job host instead of taskkill or a detached leader", () => {
  const spec = pluginPeerPluginInternals.pluginSpawnSpec("C:\\plugins\\peer.exe", {
    platform: "win32",
    arch: "x64",
    env: { FLEET_WINDOWS_JOB_HOST: "C:\\fleet\\job-host.exe" },
    parentPID: 42,
  });
  assert.equal(spec.command, path.resolve("C:\\fleet\\job-host.exe"));
  assert.deepEqual(spec.args, ["--parent-pid", "42", "--", "C:\\plugins\\peer.exe"]);
  assert.equal(spec.detached, false);
  assert.throws(
    () => pluginPeerPluginInternals.pluginSpawnSpec("C:\\plugins\\peer.exe", {
      platform: "win32",
      arch: "ia32",
      env: {},
    }),
    (error) => error?.code === "plugin_unavailable" && /no Windows process host/.test(error.message),
  );
});

test("cancel receipt waits for late stdout status and durable process-tree cleanup", async () => {
  const child = fakeReceiptChild();
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const peer = launchPluginPeerProcess({
    path: "/fake/plugin",
    pluginId: "example.peer",
    dataDir: "/fake/data",
    action: "source",
    input: {},
    peer: {},
    spawnImpl: () => child,
    processTreeFactory: () => ({
      leaderExited: () => cleanup,
      terminate: async () => {},
    }),
  });
  await peer.open();
  let settled = false;
  const cancelling = peer.cancel();
  void cancelling.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false, "cancel returned before the process-tree cleanup receipt");
  releaseCleanup();
  await cancelling;
});

test("clean leader exit cannot hide a failed process-tree cleanup", async () => {
  const child = fakeReceiptChild({ lateStatusMs: 0 });
  const peer = launchPluginPeerProcess({
    path: "/fake/plugin",
    pluginId: "example.peer",
    dataDir: "/fake/data",
    action: "source",
    input: {},
    peer: {},
    spawnImpl: () => child,
    processTreeFactory: () => ({
      leaderExited: async () => { throw new Error("tree still active"); },
      terminate: async () => {},
    }),
  });
  await peer.open();
  await assert.rejects(
    () => peer.cancel(),
    (error) => error?.code === "cancel_unapplied" && /tree still active/.test(error.message),
  );
});

test("forced abort fails closed when the process host never exits", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const peer = launchPluginPeerProcess({
    path: "/fake/plugin",
    pluginId: "example.peer",
    dataDir: "/fake/data",
    action: "source",
    input: {},
    peer: {},
    spawnImpl: () => child,
    processTreeFactory: () => ({
      leaderExited: async () => {},
      terminate: async () => {},
    }),
  });
  await assert.rejects(
    () => peer.abort(),
    (error) => error?.code === "plugin_cleanup" && /did not stop/.test(error.message),
  );
});

test("Windows Job host drains descendants for clean and forced cancellation", { skip: process.platform !== "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-tool-windows-job-"));
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-job-host");
  const host = path.join(root, "fleet-tool-windows-job-host.exe");
  const plugin = path.join(root, "fleet-tool-windows-test-plugin.exe");
  const pidFile = path.join(root, "descendant.pid");
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const buildEnv = {
    ...process.env,
    CGO_ENABLED: "0",
    GOOS: "windows",
    GOARCH: goarch,
    GOCACHE: path.join(root, "go-cache"),
  };
  execFileSync("go", ["build", "-buildvcs=false", "-trimpath", "-o", host, "."], { cwd: source, env: buildEnv });
  execFileSync("go", ["build", "-buildvcs=false", "-trimpath", "-o", plugin, "./testplugin"], { cwd: source, env: buildEnv });

  const previousHost = process.env.FLEET_WINDOWS_JOB_HOST;
  const previousPID = process.env.FLEET_TEST_WINDOWS_DESCENDANT_PID;
  const previousIgnoreCancel = process.env.FLEET_TEST_WINDOWS_IGNORE_CANCEL;
  process.env.FLEET_WINDOWS_JOB_HOST = host;
  process.env.FLEET_TEST_WINDOWS_DESCENDANT_PID = pidFile;
  let peer;
  let descendantPID = 0;
  let forcedDescendantPID = 0;
  try {
    peer = launchPluginPeerProcess({
      path: plugin,
      pluginId: "example.peer",
      dataDir: path.join(root, "data"),
      action: "source",
      input: {},
      peer: {},
    });
    await peer.open();
    await peer.cancel();
    descendantPID = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(descendantPID > 0, "test plugin did not record its descendant");
    assert.throws(
      () => process.kill(descendantPID, 0),
      (error) => error?.code === "ESRCH",
      `plugin descendant ${descendantPID} survived an accepted cancel receipt`,
    );

    const forcedPIDFile = path.join(root, "forced-descendant.pid");
    process.env.FLEET_TEST_WINDOWS_DESCENDANT_PID = forcedPIDFile;
    process.env.FLEET_TEST_WINDOWS_IGNORE_CANCEL = "1";
    peer = launchPluginPeerProcess({
      path: plugin,
      pluginId: "example.peer",
      dataDir: path.join(root, "forced-data"),
      action: "source",
      input: {},
      peer: {},
    });
    await peer.open();
    forcedDescendantPID = Number((await readFile(forcedPIDFile, "utf8")).trim());
    assert.ok(forcedDescendantPID > 0, "uncooperative test plugin did not record its descendant");
    await assert.rejects(
      () => peer.cancel(),
      (error) => error?.code === "cancel_unapplied",
    );
    assert.throws(
      () => process.kill(forcedDescendantPID, 0),
      (error) => error?.code === "ESRCH",
      `plugin descendant ${forcedDescendantPID} survived forced cancellation cleanup`,
    );
  } finally {
    await peer?.abort?.().catch(() => {});
    if (descendantPID > 0) {
      try { process.kill(descendantPID); } catch { /* already terminated by the Job */ }
    }
    if (forcedDescendantPID > 0) {
      try { process.kill(forcedDescendantPID); } catch { /* already terminated by the Job */ }
    }
    if (previousHost == null) delete process.env.FLEET_WINDOWS_JOB_HOST;
    else process.env.FLEET_WINDOWS_JOB_HOST = previousHost;
    if (previousPID == null) delete process.env.FLEET_TEST_WINDOWS_DESCENDANT_PID;
    else process.env.FLEET_TEST_WINDOWS_DESCENDANT_PID = previousPID;
    if (previousIgnoreCancel == null) delete process.env.FLEET_TEST_WINDOWS_IGNORE_CANCEL;
    else process.env.FLEET_TEST_WINDOWS_IGNORE_CANCEL = previousIgnoreCancel;
  }
});

test("launcher rechecks cancellation after a resolver returns", async () => {
  const controller = new AbortController();
  let spawns = 0;
  const launch = createPluginPeerLauncher({
    resolve: async () => {
      controller.abort();
      return { path: "/never/spawn", action: "source", dataDir: "/never/data" };
    },
    spawnImpl: () => { spawns += 1; throw new Error("spawn must not run"); },
  });
  await assert.rejects(
    () => launch({
      pluginId: "example.peer",
      protocol: "example.bytes.v1",
      role: "source",
      input: {},
      peer: {},
      signal: controller.signal,
    }),
    (error) => error?.code === "cancelled",
  );
  assert.equal(spawns, 0);
});

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

test("production launcher transfers the same process after open is written and before ready", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-ownership-"));
  const executable = path.join(root, "gated-ready.mjs");
  const openFile = path.join(root, "open.json");
  const readyFile = path.join(root, "allow-ready");
  const dataDir = path.join(root, "example.peer", "data");
  const script = `#!/usr/bin/env node
import { accessSync, writeFileSync } from "node:fs";
let input = Buffer.alloc(0);
let opened = false;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (opened || input.length < 12) return;
  const length = input.readUInt32BE(8);
  if (input.length < 12 + length) return;
  const control = JSON.parse(input.subarray(12, 12 + length).toString("utf8"));
  writeFileSync(process.env.FLEET_TEST_OPEN_FILE, JSON.stringify(control));
  opened = true;
});
const timer = setInterval(() => {
  if (!opened) return;
  try { accessSync(process.env.FLEET_TEST_READY_FILE); } catch { return; }
  clearInterval(timer);
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status: "ready" }));
  const header = Buffer.alloc(12);
  header.write("FLPP", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt32BE(payload.length, 8);
  process.stdout.write(Buffer.concat([header, payload]));
}, 5);
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousOpen = process.env.FLEET_TEST_OPEN_FILE;
  const previousReady = process.env.FLEET_TEST_READY_FILE;
  process.env.FLEET_TEST_OPEN_FILE = openFile;
  process.env.FLEET_TEST_READY_FILE = readyFile;
  let exposed;
  let releaseOwnership;
  const ownershipGate = new Promise((resolve) => { releaseOwnership = resolve; });
  let markOwnership;
  const ownershipSeen = new Promise((resolve) => { markOwnership = resolve; });
  let returned;
  try {
    const launch = createPluginPeerLauncher({
      resolve: async () => ({ path: executable, action: "source", dataDir }),
    });
    let settled = false;
    const launching = launch({
      pluginId: "example.peer",
      protocol: "example.bytes.v1",
      role: "source",
      input: { path: "/tmp/a" },
      peer: { kind: "device", id: "device-1" },
      onProcess: async (process) => {
        exposed = process;
        const deadline = Date.now() + 2000;
        let control;
        while (!control && Date.now() < deadline) {
          try { control = JSON.parse(await readFile(openFile, "utf8")); } catch { /* open has not reached the child yet */ }
          if (!control) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(control?.type, "open", "ownership transferred before FLPP open was written");
        markOwnership();
        await ownershipGate;
      },
    });
    void launching.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await ownershipSeen;
    assert.equal(settled, false, "launcher returned before the plugin ready handshake");
    await writeFile(readyFile, "ready\n");
    releaseOwnership();
    returned = await launching;
    assert.equal(returned, exposed, "launcher changed process identity after ownership transfer");
  } finally {
    releaseOwnership?.();
    await (returned || exposed)?.abort?.().catch(() => {});
    if (previousOpen == null) delete process.env.FLEET_TEST_OPEN_FILE;
    else process.env.FLEET_TEST_OPEN_FILE = previousOpen;
    if (previousReady == null) delete process.env.FLEET_TEST_READY_FILE;
    else process.env.FLEET_TEST_READY_FILE = previousReady;
  }
});

test("production plugin cancel succeeds only after status=canceled confirmation", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-cancel-confirmed-"));
  const executable = path.join(root, "confirm-cancel.mjs");
  const pidFile = path.join(root, "plugin.pid");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FLEET_TEST_PLUGIN_PID, String(process.pid));
let input = Buffer.alloc(0);
function send(status) {
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status }));
  const header = Buffer.alloc(12);
  header.write("FLPP", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt32BE(payload.length, 8);
  process.stdout.write(Buffer.concat([header, payload]), () => {
    if (status === "canceled") process.exit(0);
  });
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 12) {
    const length = input.readUInt32BE(8);
    if (input.length < 12 + length) return;
    const control = JSON.parse(input.subarray(12, 12 + length).toString("utf8"));
    input = input.subarray(12 + length);
    if (control.type === "open") send("ready");
    if (control.type === "cancel") send("canceled");
  }
});
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.FLEET_TEST_PLUGIN_PID;
  process.env.FLEET_TEST_PLUGIN_PID = pidFile;
  try {
    const peer = launchPluginPeerProcess({
      path: executable,
      pluginId: "example.peer",
      dataDir: path.join(root, "data"),
      action: "source",
      input: {},
      peer: {},
    });
    await peer.open();
    await peer.cancel();
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0);
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
    assert.fail(`confirmed plugin ${pid} survived cancellation`);
  } finally {
    if (previous == null) delete process.env.FLEET_TEST_PLUGIN_PID;
    else process.env.FLEET_TEST_PLUGIN_PID = previous;
  }
});

async function assertConfirmedButUncleanCancelIsRejected(mode) {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), `fleet-peer-cancel-${mode}-`));
  const executable = path.join(root, "unclean-cancel.mjs");
  const pidFile = path.join(root, "plugin.pid");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FLEET_TEST_PLUGIN_PID, String(process.pid));
const mode = process.env.FLEET_TEST_CANCEL_MODE;
let input = Buffer.alloc(0);
function send(status, done) {
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status }));
  const header = Buffer.alloc(12);
  header.write("FLPP", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt32BE(payload.length, 8);
  process.stdout.write(Buffer.concat([header, payload]), done);
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 12) {
    const length = input.readUInt32BE(8);
    if (input.length < 12 + length) return;
    const control = JSON.parse(input.subarray(12, 12 + length).toString("utf8"));
    input = input.subarray(12 + length);
    if (control.type === "open") send("ready");
    if (control.type === "cancel") send("canceled", () => {
      if (mode === "nonzero") process.exit(7);
    });
  }
});
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPID = process.env.FLEET_TEST_PLUGIN_PID;
  const previousMode = process.env.FLEET_TEST_CANCEL_MODE;
  process.env.FLEET_TEST_PLUGIN_PID = pidFile;
  process.env.FLEET_TEST_CANCEL_MODE = mode;
  let peer;
  try {
    peer = launchPluginPeerProcess({
      path: executable,
      pluginId: "example.peer",
      dataDir: path.join(root, "data"),
      action: "source",
      input: {},
      peer: {},
    });
    await peer.open();
    await assert.rejects(() => peer.cancel(), (error) => error?.code === "cancel_unapplied");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0);
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
    assert.fail(`uncleanly cancelled plugin ${pid} survived cleanup`);
  } finally {
    await peer?.abort?.().catch(() => {});
    if (previousPID == null) delete process.env.FLEET_TEST_PLUGIN_PID;
    else process.env.FLEET_TEST_PLUGIN_PID = previousPID;
    if (previousMode == null) delete process.env.FLEET_TEST_CANCEL_MODE;
    else process.env.FLEET_TEST_CANCEL_MODE = previousMode;
  }
}

test("production plugin canceled status followed by a hang is not a receipt", { skip: process.platform === "win32" }, async () => {
  await assertConfirmedButUncleanCancelIsRejected("hang");
});

test("production plugin canceled status followed by a non-zero exit is not a receipt", { skip: process.platform === "win32" }, async () => {
  await assertConfirmedButUncleanCancelIsRejected("nonzero");
});

test("production plugin that ignores cancel is killed and reports cancel_unapplied", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-cancel-ignored-"));
  const executable = path.join(root, "ignore-cancel.mjs");
  const pidFile = path.join(root, "plugin.pid");
  const cancelFile = path.join(root, "cancel-seen");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FLEET_TEST_PLUGIN_PID, String(process.pid));
let input = Buffer.alloc(0);
function ready() {
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "status", status: "ready" }));
  const header = Buffer.alloc(12);
  header.write("FLPP", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt32BE(payload.length, 8);
  process.stdout.write(Buffer.concat([header, payload]));
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 12) {
    const length = input.readUInt32BE(8);
    if (input.length < 12 + length) return;
    const control = JSON.parse(input.subarray(12, 12 + length).toString("utf8"));
    input = input.subarray(12 + length);
    if (control.type === "open") ready();
    if (control.type === "cancel") writeFileSync(process.env.FLEET_TEST_CANCEL_FILE, "seen");
  }
});
setInterval(() => {}, 1000);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPID = process.env.FLEET_TEST_PLUGIN_PID;
  const previousCancel = process.env.FLEET_TEST_CANCEL_FILE;
  process.env.FLEET_TEST_PLUGIN_PID = pidFile;
  process.env.FLEET_TEST_CANCEL_FILE = cancelFile;
  try {
    const peer = launchPluginPeerProcess({
      path: executable,
      pluginId: "example.peer",
      dataDir: path.join(root, "data"),
      action: "source",
      input: {},
      peer: {},
    });
    await peer.open();
    await assert.rejects(() => peer.cancel(), (error) => error?.code === "cancel_unapplied");
    assert.equal((await readFile(cancelFile, "utf8")).trim(), "seen", "plugin never received the written cancel frame");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0);
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
    assert.fail(`uncooperative plugin ${pid} survived forced cancellation cleanup`);
  } finally {
    if (previousPID == null) delete process.env.FLEET_TEST_PLUGIN_PID;
    else process.env.FLEET_TEST_PLUGIN_PID = previousPID;
    if (previousCancel == null) delete process.env.FLEET_TEST_CANCEL_FILE;
    else process.env.FLEET_TEST_CANCEL_FILE = previousCancel;
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
    await assert.rejects(() => peer.cancel(), (error) => error?.code === "cancel_unapplied");
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
