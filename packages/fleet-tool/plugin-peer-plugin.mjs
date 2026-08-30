import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLPP_MAGIC = Buffer.from("FLPP");
const FLPP_HEADER_BYTES = 12;
const FLPP_CONTROL = 1;
const FLPP_DATA = 2;
const FLPP_CONTROL_MAX = 64 << 10;
const FLPP_DATA_MAX = 32 << 10;
const PLUGIN_DOWNLOAD_MAX = 100 << 20;
const PLUGIN_DOWNLOAD_TIMEOUT_MS = 30_000;
const PLUGIN_WRITE_TIMEOUT_MS = 10_000;
const PLUGIN_CANCEL_WRITE_TIMEOUT_MS = 250;
const PLUGIN_STDOUT_DRAIN_TIMEOUT_MS = 500;

function peerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason?.code === "plugin_download_timeout") return reason;
  return peerError("cancelled", "plugin download cancelled");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function downloadDeadline(parent, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout) {
  const controller = new AbortController();
  const cancel = () => controller.abort(peerError("cancelled", "plugin download cancelled"));
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : PLUGIN_DOWNLOAD_TIMEOUT_MS;
  const timer = setTimer(
    () => controller.abort(peerError("plugin_download_timeout", "plugin download timed out")),
    ms,
  );
  return {
    signal: controller.signal,
    close() {
      clearTimer(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}

function platformName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  return process.platform;
}

function archName() {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function actionDeclaration(plugin, protocolId, role) {
  const protocol = plugin?.peer_protocols?.find((value) => value?.id === protocolId);
  if (
    !protocol ||
    protocol.abi !== "fleet.plugin.peer.v1" ||
    protocol.transport !== "direct_ordered" ||
    protocol.approval !== "both_once"
  ) {
    throw peerError("unsupported_plugin", `plugin does not declare peer protocol ${protocolId}`);
  }
  const action = protocol.roles?.[role];
  const spec = action && plugin.action_specs?.[action];
  if (!action || spec?.runtime !== "peer" || spec?.role !== role) {
    throw peerError("unsupported_plugin", `plugin does not declare ${role} peer action`);
  }
  return { protocol, action };
}

export function resolvePluginPeerArtifact(catalog, pluginId, protocolId, role) {
  const plugin = catalog?.find((value) => value?.id === pluginId && value?.installable !== false);
  if (!plugin) throw peerError("plugin_unavailable", `official plugin ${pluginId} is unavailable`);
  const { protocol, action } = actionDeclaration(plugin, protocolId, role);
  const os = platformName();
  const arch = archName();
  const artifact = plugin.artifacts?.find((value) => value?.os === os && value?.arch === arch);
  if (!artifact || !/^[0-9a-f]{64}$/.test(String(artifact.sha256 || "")) || !artifact.entrypoint) {
    throw peerError("plugin_unavailable", `plugin ${pluginId} has no verified ${os}/${arch} artifact`);
  }
  return { plugin, protocol, action, artifact, os, arch };
}

async function sha256File(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw peerError("plugin_unavailable", "plugin entrypoint is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function verifiedEntrypoint(filePath, expected) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw peerError("plugin_unavailable", "plugin entrypoint must be a regular non-symlink file");
  }
  const actual = await sha256File(filePath);
  if (actual !== expected) throw peerError("plugin_tampered", `plugin SHA-256 mismatch: got ${actual}`);
  return filePath;
}

async function readBoundedResponse(response, { signal } = {}) {
  throwIfAborted(signal);
  if (!response.ok) throw peerError("plugin_download", `plugin download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > PLUGIN_DOWNLOAD_MAX) throw peerError("plugin_download", "plugin artifact exceeds 100 MiB");
  const reader = response.body?.getReader();
  if (!reader) throw peerError("plugin_download", "plugin artifact response has no body");
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > PLUGIN_DOWNLOAD_MAX) {
        void reader.cancel().catch(() => {});
        throw peerError("plugin_download", "plugin artifact exceeds 100 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw abortError(signal);
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted synthetic reader may still have a pending read. Fetch owns
      // cancellation; retaining its lock is safer than extending the deadline.
    }
  }
  return Buffer.concat(chunks, total);
}

export function createPluginPeerResolver({
  catalog,
  hubOrigin = "",
  authorization = "",
  fetchImpl = globalThis.fetch,
  cacheRoot = path.join(homedir(), ".fleet", "plugins"),
  pluginDir = process.env.FLEET_PLUGIN_DIR || "",
  downloadTimeoutMs = PLUGIN_DOWNLOAD_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  return async function resolve(pluginId, protocolId, role, { signal } = {}) {
    throwIfAborted(signal);
    const declaration = resolvePluginPeerArtifact(catalog, pluginId, protocolId, role);
    const { plugin, artifact, os, arch } = declaration;
    const root = path.resolve(pluginDir || cacheRoot);
    const pluginRoot = path.join(root, plugin.id);
    const dataDir = path.join(pluginRoot, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dataDir, 0o700);
    throwIfAborted(signal);
    if (pluginDir) {
      const local = path.join(pluginRoot, plugin.version, artifact.entrypoint);
      const executable = await verifiedEntrypoint(local, artifact.sha256);
      throwIfAborted(signal);
      return { ...declaration, dataDir, path: executable };
    }
    const dir = path.join(pluginRoot, plugin.version);
    const target = path.join(dir, artifact.entrypoint);
    try {
      const executable = await verifiedEntrypoint(target, artifact.sha256);
      throwIfAborted(signal);
      return { ...declaration, dataDir, path: executable };
    } catch (error) {
      if (error?.code === "plugin_tampered" || error?.code === "cancelled") throw error;
    }
    if (typeof fetchImpl !== "function") throw peerError("plugin_download", "fetch is unavailable");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mirror = hubOrigin
      ? `${String(hubOrigin).replace(/\/$/, "")}/v1/plugin-artifact/${encodeURIComponent(plugin.id)}/${encodeURIComponent(plugin.version)}/${os}/${arch}`
      : "";
    const candidates = [mirror, artifact.url].filter(Boolean);
    const deadline = downloadDeadline(signal, downloadTimeoutMs, setTimeoutImpl, clearTimeoutImpl);
    try {
      let bytes;
      let lastError;
      for (const url of candidates) {
        try {
          throwIfAborted(deadline.signal);
          const auth = typeof authorization === "function"
            ? await abortable(authorization({ signal: deadline.signal }), deadline.signal)
            : authorization;
          throwIfAborted(deadline.signal);
          const headers = mirror && url === mirror && auth ? { authorization: auth } : undefined;
          const response = await abortable(fetchImpl(url, {
            headers,
            redirect: url === mirror ? "manual" : "follow",
            signal: deadline.signal,
          }), deadline.signal);
          bytes = await readBoundedResponse(response, { signal: deadline.signal });
          break;
        } catch (error) {
          if (deadline.signal.aborted) throw abortError(deadline.signal);
          lastError = error;
        }
      }
      if (!bytes) throw lastError || peerError("plugin_download", "plugin download failed");
      throwIfAborted(deadline.signal);
      const actual = createHash("sha256").update(bytes).digest("hex");
      throwIfAborted(deadline.signal);
      if (actual !== artifact.sha256) throw peerError("plugin_tampered", `plugin SHA-256 mismatch: got ${actual}`);
      const temporary = path.join(dir, `.${artifact.entrypoint}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o700, flag: "wx", signal: deadline.signal });
        throwIfAborted(deadline.signal);
        if (process.platform !== "win32") await chmod(temporary, 0o700);
        throwIfAborted(deadline.signal);
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      const executable = await verifiedEntrypoint(target, artifact.sha256);
      throwIfAborted(deadline.signal);
      return { ...declaration, dataDir, path: executable };
    } catch (error) {
      if (deadline.signal.aborted) throw abortError(deadline.signal);
      throw error;
    } finally {
      deadline.close();
    }
  };
}

class RecordQueue {
  #values = [];
  #waiters = [];
  #error = null;
  #bytes = 0;

  push(value, bytes) {
    if (this.#values.length >= 128 || this.#bytes + bytes > 2 << 20) {
      this.fail(peerError("backpressure", "plugin output queue exceeded its hard limit"), true);
      return false;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(value);
    else {
      this.#values.push({ value, bytes });
      this.#bytes += bytes;
    }
    return true;
  }

  fail(error, discard = false) {
    if (this.#error) return;
    if (discard) {
      this.#values.length = 0;
      this.#bytes = 0;
    }
    this.#error = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error);
  }

  next(signal) {
    if (this.#values.length) {
      const item = this.#values.shift();
      this.#bytes -= item.bytes;
      return Promise.resolve(item.value);
    }
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const aborted = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(peerError("cancelled", "plugin peer cancelled"));
      };
      waiter.resolve = (value) => {
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      waiter.reject = (error) => {
        signal?.removeEventListener("abort", aborted);
        reject(error);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
}

function encodeRecord(kind, payload) {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const limit = kind === FLPP_CONTROL ? FLPP_CONTROL_MAX : kind === FLPP_DATA ? FLPP_DATA_MAX : -1;
  if (limit < 0 || value.length > limit) throw peerError("plugin_protocol", "invalid FLPP record");
  const header = Buffer.alloc(FLPP_HEADER_BYTES);
  FLPP_MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(kind, 5);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(value.length, 8);
  return Buffer.concat([header, value]);
}

async function writeStream(stream, payload, { signal, timeoutMs = PLUGIN_WRITE_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw peerError("cancelled", "plugin peer cancelled");
  if (stream.destroyed || !stream.writable) throw peerError("plugin_protocol", "plugin stdin is closed");
  let accepted;
  try {
    accepted = stream.write(payload);
  } catch (error) {
    throw peerError("plugin_protocol", `plugin stdin write failed: ${error?.message || error}`);
  }
  if (accepted) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("drain", drained);
      stream.removeListener("error", failed);
      stream.removeListener("close", closed);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && !stream.destroyed) stream.destroy();
      if (error) reject(error);
      else resolve();
    };
    const drained = () => finish();
    const failed = (error) => finish(peerError("plugin_protocol", `plugin stdin write failed: ${error?.message || error}`));
    const closed = () => finish(peerError("plugin_protocol", "plugin stdin closed during write"));
    const aborted = () => finish(peerError("cancelled", "plugin peer cancelled"), true);
    const timer = setTimeout(
      () => finish(peerError("backpressure", "plugin stdin write timed out"), true),
      timeoutMs,
    );
    stream.once("drain", drained);
    stream.once("error", failed);
    stream.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (stream.destroyed || !stream.writable) closed();
  });
}

function waitMilliseconds(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowsJobHostPath({ arch = process.arch, env = process.env, moduleUrl = import.meta.url } = {}) {
  const override = String(env.FLEET_WINDOWS_JOB_HOST || "").trim();
  if (override) return path.resolve(override);
  const normalizedArch = arch === "x64" ? "amd64" : arch;
  if (normalizedArch !== "amd64" && normalizedArch !== "arm64") {
    throw peerError("plugin_unavailable", `Fleet Tool has no Windows process host for ${arch}`);
  }
  return fileURLToPath(new URL(`./bin/fleet-tool-windows-job-host-${normalizedArch}.exe`, moduleUrl));
}

function pluginSpawnSpec(executable, {
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  moduleUrl = import.meta.url,
  parentPID = process.pid,
} = {}) {
  if (platform === "win32") {
    return {
      command: windowsJobHostPath({ arch, env, moduleUrl }),
      args: ["--parent-pid", String(parentPID), "--", executable],
      detached: false,
    };
  }
  return { command: executable, args: [], detached: true };
}

async function signalUnixProcessTree(child, signal) {
  const pid = Number(child?.pid || 0);
  if (!pid) {
    if (child?.exitCode != null || child?.signalCode != null) return;
    if (!child?.kill?.(signal)) throw peerError("plugin_cleanup", "plugin process has no killable PID");
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (groupError) {
    if (child?.exitCode != null || child?.signalCode != null) return;
    try {
      if (child.kill?.(signal)) return;
    } catch (leaderError) {
      throw peerError(
        "plugin_cleanup",
        `plugin process-group signal failed: ${leaderError?.message || groupError?.message || leaderError || groupError}`,
      );
    }
    throw peerError(
      "plugin_cleanup",
      `plugin process-group signal failed: ${groupError?.message || groupError}`,
    );
  }
}

function createProcessTreeController(child, { platform = process.platform } = {}) {
  return {
    async leaderExited() {
      // On Windows the observed child is the Job Object host. A natural host
      // exit follows its ActiveProcesses==0 check; a forced host exit instead
      // triggers KILL_ON_JOB_CLOSE and is never accepted as a clean receipt.
      // POSIX still needs a final group sweep because the observed child is the
      // plugin group leader itself.
      if (platform !== "win32") await signalUnixProcessTree(child, "SIGKILL");
    },
    async terminate(signal) {
      if (platform !== "win32") {
        await signalUnixProcessTree(child, signal);
        return;
      }
      // Terminating the host closes its KILL_ON_JOB_CLOSE handle in the kernel.
      // Never fall back to taskkill by PID: a dead/reused leader PID is not a
      // process-tree identity and cannot produce an authoritative receipt.
      if (child?.exitCode != null || child?.signalCode != null) return;
      let sent;
      try {
        sent = child?.kill?.(signal);
      } catch (error) {
        throw peerError("plugin_cleanup", `Windows plugin Job host termination failed: ${error?.message || error}`);
      }
      if (!sent && child?.exitCode == null && child?.signalCode == null) {
        throw peerError("plugin_cleanup", "Windows plugin Job host rejected termination");
      }
    },
  };
}

export function launchPluginPeerProcess({
  path: executable,
  pluginId,
  dataDir,
  action,
  input,
  peer,
  signal,
  spawnImpl = spawn,
  processTreeFactory = createProcessTreeController,
  writeTimeoutMs = PLUGIN_WRITE_TIMEOUT_MS,
  cancelWriteTimeoutMs = PLUGIN_CANCEL_WRITE_TIMEOUT_MS,
}) {
  throwIfAborted(signal);
  const spec = pluginSpawnSpec(executable);
  const child = spawnImpl(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FLEET_PLUGIN_PEER: "1",
      FLEET_PLUGIN_ID: String(pluginId || ""),
      FLEET_PLUGIN_DATA_DIR: dataDir ? path.resolve(dataDir) : "",
    },
    detached: spec.detached,
    windowsHide: true,
  });
  const processTree = processTreeFactory(child);
  const queue = new RecordQueue();
  let buffer = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let closed = false;
  let stopping;
  let stopMode = "";
  let cancelRequested = false;
  let cancelConfirmed = false;
  let exitStatus = null;
  let treeCleanup = Promise.resolve();
  let treeCleanupError;
  let stdoutIsDrained = !child.stdout;
  let noteStdoutDrained;
  let stdoutDrainWait;
  const stdoutDrained = new Promise((resolve) => {
    noteStdoutDrained = resolve;
    if (stdoutIsDrained) resolve();
  });
  const markStdoutDrained = () => {
    if (stdoutIsDrained) return;
    stdoutIsDrained = true;
    noteStdoutDrained();
  };
  let noteExit;
  const exited = new Promise((resolve) => {
    noteExit = resolve;
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 256 << 10) stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, 256 << 10);
  });
  child.stdout?.once("end", markStdoutDrained);
  child.stdout?.once("close", markStdoutDrained);
  child.once("close", markStdoutDrained);
  child.stdin?.on("error", (error) => {
    if (stopping) return;
    queue.fail(peerError("plugin_protocol", `plugin stdin failed: ${error?.message || error}`), true);
    void abort().catch(() => {});
  });
  child.stdout?.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      if (buffer.length < FLPP_HEADER_BYTES) return;
      const kind = buffer.readUInt8(5);
      const length = buffer.readUInt32BE(8);
      const limit = kind === FLPP_CONTROL ? FLPP_CONTROL_MAX : kind === FLPP_DATA ? FLPP_DATA_MAX : -1;
      if (!buffer.subarray(0, 4).equals(FLPP_MAGIC) || buffer.readUInt8(4) !== 1 || buffer.readUInt16BE(6) !== 0 || limit < 0 || length > limit) {
        queue.fail(peerError("plugin_protocol", "invalid FLPP record header"), true);
        void abort().catch(() => {});
        return;
      }
      if (buffer.length < FLPP_HEADER_BYTES + length) return;
      const payload = buffer.subarray(FLPP_HEADER_BYTES, FLPP_HEADER_BYTES + length);
      buffer = buffer.subarray(FLPP_HEADER_BYTES + length);
      if (kind === FLPP_CONTROL) {
        let control;
        try {
          control = JSON.parse(payload.toString("utf8"));
        } catch {
          queue.fail(peerError("plugin_protocol", "invalid FLPP JSON control"), true);
          void abort().catch(() => {});
          return;
        }
        if (control?.v !== 1 || control?.type !== "status") {
          queue.fail(peerError("plugin_protocol", "invalid FLPP status"), true);
          void abort().catch(() => {});
          return;
        }
        if (cancelRequested && control.status === "canceled") cancelConfirmed = true;
        if (!queue.push({ kind: "control", control }, payload.length)) void abort().catch(() => {});
      } else {
        if (!queue.push({ kind: "data", data: Buffer.from(payload) }, payload.length)) void abort().catch(() => {});
      }
    }
  });
  child.on("error", (error) => {
    queue.fail(error, true);
    if (!child.pid && !closed) {
      closed = true;
      exitStatus = { code: null, signal: null, error };
      noteExit(exitStatus);
    }
  });
  child.on("exit", (code, childSignal) => {
    closed = true;
    exitStatus = { code, signal: childSignal };
    child.stdin?.destroy?.();
    treeCleanup = Promise.resolve()
      .then(() => processTree.leaderExited())
      .catch((error) => { treeCleanupError = error; });
    noteExit(exitStatus);
    void Promise.all([waitForTreeCleanup(), waitForStdoutDrain()]).then(
      () => {
        if (stopping || signal?.aborted) {
          queue.fail(peerError("cancelled", "plugin peer cancelled"), true);
        } else if (code !== 0) {
          queue.fail(peerError("plugin_failed", stderr.toString("utf8").trim() || `plugin exited ${code ?? childSignal}`));
        } else {
          queue.fail(peerError("plugin_closed", "plugin process closed"));
        }
      },
      (error) => queue.fail(error, true),
    );
  });
  function waitForStdoutDrain() {
    if (stdoutIsDrained) return Promise.resolve();
    if (!stdoutDrainWait) {
      stdoutDrainWait = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(peerError("plugin_cleanup", "plugin stdout did not close after process exit")),
          PLUGIN_STDOUT_DRAIN_TIMEOUT_MS,
        );
        stdoutDrained.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return stdoutDrainWait;
  }
  async function waitForTreeCleanup() {
    await treeCleanup;
    if (treeCleanupError) throw treeCleanupError;
  }
  async function abort() {
    if (stopping) return stopping;
    stopMode = "abort";
    stopping = (async () => {
      child.stdin?.destroy?.();
      if (!closed) await processTree.terminate("SIGKILL");
      await Promise.race([exited, waitMilliseconds(250)]);
      if (!closed) throw peerError("plugin_cleanup", "plugin process tree did not stop after forced termination");
      if (closed) await waitForTreeCleanup();
    })();
    queue.fail(peerError("cancelled", "plugin peer cancelled"), true);
    return stopping;
  }
  const onAbort = () => {
    void abort().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  async function writeRecord(kind, value) {
    try {
      await writeStream(child.stdin, encodeRecord(kind, value), { signal, timeoutMs: writeTimeoutMs });
    } catch (error) {
      if (!stopping) void abort().catch(() => {});
      throw error;
    }
  }
  const api = {
    async open(onOpenWritten) {
      await api.writeControl({ v: 1, type: "open", action, input: input ?? {}, peer });
      await onOpenWritten?.();
      const record = await api.next(signal);
      if (record.kind === "control" && record.control.status === "error") {
        throw peerError(
          String(record.control.code || "plugin_failed"),
          String(record.control.error || "plugin rejected the open request"),
        );
      }
      if (record.kind !== "control" || record.control.status !== "ready") {
        throw peerError("plugin_protocol", "plugin must become ready before DATA");
      }
    },
    next: (readSignal = signal) => queue.next(readSignal),
    writeControl: (value) => writeRecord(FLPP_CONTROL, JSON.stringify(value)),
    writeData: (value) => writeRecord(FLPP_DATA, value),
    abort,
    async cancel() {
      if (stopping) {
        if (stopMode !== "cancel") {
          throw peerError("cancel_unapplied", "plugin process was aborted before FLPP cancel");
        }
        return stopping;
      }
      if (closed) {
        throw peerError("cancel_unapplied", "plugin process exited before FLPP cancel");
      }
      stopMode = "cancel";
      stopping = (async () => {
        let cancelWritten = false;
        let cancelWriteError;
        let forcedStop = false;
        let cleanupError;
        cancelRequested = true;
        if (!closed) {
          try {
            await writeStream(
              child.stdin,
              encodeRecord(FLPP_CONTROL, JSON.stringify({ v: 1, type: "cancel" })),
              { timeoutMs: cancelWriteTimeoutMs },
            );
            cancelWritten = true;
          } catch (error) {
            cancelWriteError = error;
          }
        }
        if (cancelWritten) await Promise.race([exited, waitMilliseconds(500)]);
        if (!closed) {
          forcedStop = true;
          child.stdin?.destroy?.();
          try {
            await processTree.terminate("SIGTERM");
          } catch (error) {
            cleanupError = error;
          }
          await Promise.race([exited, waitMilliseconds(250)]);
        }
        if (!closed) {
          try {
            await processTree.terminate("SIGKILL");
          } catch (error) {
            cleanupError = cleanupError || error;
          }
          await Promise.race([exited, waitMilliseconds(250)]);
        }
        if (!closed) {
          cleanupError = cleanupError || peerError(
            "plugin_cleanup",
            "plugin process tree did not stop after forced termination",
          );
        }
        if (closed) {
          try {
            await Promise.all([waitForTreeCleanup(), waitForStdoutDrain()]);
          } catch (error) {
            cleanupError = cleanupError || error;
          }
        }
        queue.fail(peerError("cancelled", "plugin peer cancelled"), true);
        const cleanExit = !forcedStop && exitStatus?.code === 0 && !exitStatus?.signal;
        if (!cancelWritten || !cancelConfirmed || !cleanExit || cleanupError) {
          throw peerError(
            "cancel_unapplied",
            cleanupError
              ? `plugin process tree cleanup failed: ${cleanupError?.message || cleanupError}`
              : !cancelWritten
              ? `FLPP cancel control was not written: ${cancelWriteError?.message || "plugin stdin was closed"}`
              : !cancelConfirmed
                ? "plugin exited without confirming FLPP cancellation"
                : forcedStop
                  ? "plugin did not exit cleanly after confirming FLPP cancellation"
                  : `plugin cancellation exited ${exitStatus?.code ?? exitStatus?.signal ?? "without status"}`,
          );
        }
      })();
      return stopping;
    },
  };
  return api;
}

export function createPluginPeerLauncher({ resolve, spawnImpl } = {}) {
  if (typeof resolve !== "function") throw new TypeError("plugin resolver is required");
  return async ({ pluginId, protocol, role, input, peer, signal, onProcess }) => {
    const declaration = await resolve(pluginId, protocol, role, { signal });
    throwIfAborted(signal);
    if (!declaration?.dataDir) {
      throw peerError("plugin_unavailable", "plugin resolver did not provide a stable data directory");
    }
    await mkdir(declaration.dataDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(declaration.dataDir, 0o700);
    throwIfAborted(signal);
    const pluginProcess = launchPluginPeerProcess({
      path: declaration.path,
      pluginId,
      dataDir: declaration.dataDir,
      action: declaration.action,
      input,
      peer,
      signal,
      spawnImpl,
    });
    const launched = { ...pluginProcess, declaration };
    let owned = false;
    try {
      await launched.open(typeof onProcess === "function" ? async () => {
        owned = true;
        await onProcess(launched);
      } : undefined);
    } catch (error) {
      if (!owned) await launched.abort().catch(() => {});
      throw error;
    }
    return launched;
  };
}

export const pluginPeerPluginInternals = Object.freeze({
  createProcessTreeController,
  pluginSpawnSpec,
  writeStream,
  windowsJobHostPath,
  PLUGIN_CANCEL_WRITE_TIMEOUT_MS,
  PLUGIN_STDOUT_DRAIN_TIMEOUT_MS,
  PLUGIN_WRITE_TIMEOUT_MS,
});
