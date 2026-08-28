import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const FILE_CHANNEL_LABEL = "fleet-file-v1";
export const FILE_FRAME_MAGIC = "FLTF";
export const FILE_FRAME_VERSION = 1;
export const FILE_FRAME_DATA = 1;
export const FILE_FRAME_HEADER_BYTES = 16;
export const FILE_CHUNK_BYTES = 32 << 10;
export const FILE_BUFFER_HIGH_WATER = 4 << 20;
export const FILE_BUFFER_LOW_WATER = 1 << 20;
export const FILE_ACK_BYTES = 4 << 20;
export const FILE_CONTROL_MAX_BYTES = 64 << 10;
export const FILE_INBOX_MAX_MESSAGES = 256;
export const FILE_INBOX_MAX_BYTES = 8 << 20;

const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSFER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_BUFFER_BYTES = 1 << 20;

function transferError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw transferError("invalid_manifest", `${name} must be a non-negative safe integer`);
  }
}

function assertSHA256(value, name = "sha256") {
  if (!SHA256_RE.test(String(value || ""))) {
    throw transferError("invalid_manifest", `${name} must be a lowercase SHA-256`);
  }
}

export function safeFileName(raw) {
  const name = String(raw || "");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    path.posix.basename(name) !== name ||
    path.win32.basename(name) !== name
  ) {
    throw transferError("invalid_name", "file name must be one basename");
  }
  return name;
}

export function validateFileManifest(raw) {
  const manifest = {
    name: safeFileName(raw?.name),
    size: Number(raw?.size),
    sha256: String(raw?.sha256 || "").toLowerCase(),
  };
  assertSafeInteger(manifest.size, "size");
  assertSHA256(manifest.sha256);
  return manifest;
}

export function encodeFileFrame(offset, payload, flags = 0) {
  assertSafeInteger(offset, "offset");
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length > FILE_CHUNK_BYTES) {
    throw transferError("frame_too_large", `file frame exceeds ${FILE_CHUNK_BYTES} bytes`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff) {
    throw transferError("invalid_frame", "invalid file frame flags");
  }
  const frame = Buffer.allocUnsafe(FILE_FRAME_HEADER_BYTES + payload.length);
  frame.write(FILE_FRAME_MAGIC, 0, 4, "ascii");
  frame.writeUInt8(FILE_FRAME_VERSION, 4);
  frame.writeUInt8(FILE_FRAME_DATA, 5);
  frame.writeUInt16BE(flags, 6);
  frame.writeBigUInt64BE(BigInt(offset), 8);
  payload.copy(frame, FILE_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeFileFrame(raw) {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (frame.length < FILE_FRAME_HEADER_BYTES || frame.subarray(0, 4).toString("ascii") !== FILE_FRAME_MAGIC) {
    throw transferError("invalid_frame", "invalid file frame magic");
  }
  if (frame.readUInt8(4) !== FILE_FRAME_VERSION || frame.readUInt8(5) !== FILE_FRAME_DATA) {
    throw transferError("invalid_frame", "unsupported file frame");
  }
  const flags = frame.readUInt16BE(6);
  if (flags !== 0) throw transferError("invalid_frame", "unknown file frame flags");
  const rawOffset = frame.readBigUInt64BE(8);
  if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw transferError("invalid_frame", "file frame offset is too large");
  }
  const payload = frame.subarray(FILE_FRAME_HEADER_BYTES);
  if (payload.length > FILE_CHUNK_BYTES) {
    throw transferError("frame_too_large", `file frame exceeds ${FILE_CHUNK_BYTES} bytes`);
  }
  return { offset: Number(rawOffset), flags, payload };
}

async function hashHandle(handle, end) {
  assertSafeInteger(end, "hash end");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, Math.max(1, end)));
  let offset = 0;
  while (offset < end) {
    const length = Math.min(buffer.length, end - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) throw transferError("source_changed", "file ended while hashing");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function hasStableFileId(value) {
  return value && value.ino !== undefined && value.dev !== undefined && String(value.ino) !== "0";
}

function sameFileIdentity(left, right) {
  if (!hasStableFileId(left) || !hasStableFileId(right)) return null;
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameFile(left, right) {
  const identity = sameFileIdentity(left, right);
  if (identity !== null) return identity;
  // Older Windows Node builds do not expose a stable file id. This fallback
  // only protects the open race; final publication additionally verifies the
  // complete SHA-256 through a second handle.
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs;
}

function noFollowFlag() {
  return process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW || 0;
}

async function openVerifiedRegular(filePath, flags, before, code, message) {
  let handle;
  try {
    handle = await open(filePath, flags | noFollowFlag());
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw transferError(code, message);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw transferError(code, message);
    throw error;
  }
}

export async function openLocalSource(rawPath) {
  const requestedPath = String(rawPath || "");
  if (!path.isAbsolute(requestedPath)) throw transferError("invalid_source", "source path must be absolute");
  const filePath = path.resolve(requestedPath);
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw transferError("invalid_source", "source must be a regular file, not a symlink");
  }
  const handle = await openVerifiedRegular(
    filePath,
    fsConstants.O_RDONLY,
    before,
    "source_changed",
    "source changed while opening",
  );
  try {
    const opened = await handle.stat();
    assertSafeInteger(opened.size, "source size");
    const sha256 = await hashHandle(handle, opened.size);
    const source = {
      path: filePath,
      handle,
      manifest: { name: safeFileName(path.basename(filePath)), size: opened.size, sha256 },
      async prefixSHA256(offset) {
        assertSafeInteger(offset, "resume offset");
        if (offset > opened.size) throw transferError("invalid_offset", "resume offset exceeds source size");
        return hashHandle(handle, offset);
      },
      async *chunks(offset = 0) {
        assertSafeInteger(offset, "resume offset");
        if (offset > opened.size) throw transferError("invalid_offset", "resume offset exceeds source size");
        let position = offset;
        const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        while (position < opened.size) {
          const length = Math.min(buffer.length, opened.size - position);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead <= 0) throw transferError("source_changed", "source ended during transfer");
          yield { offset: position, payload: Buffer.from(buffer.subarray(0, bytesRead)) };
          position += bytesRead;
        }
      },
      close: () => handle.close(),
    };
    return source;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function sidecarValue({ transferId, manifest, source, committed }) {
  return {
    v: 1,
    transfer_id: transferId,
    source,
    name: manifest.name,
    size: manifest.size,
    sha256: manifest.sha256,
    committed,
  };
}

async function writeSidecar(target, committed) {
  const value = sidecarValue({ ...target, committed });
  const tmp = `${target.sidecarPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(tmp, target.sidecarPath);
}

async function optionalStat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readVerifiedFile(filePath, before, code, message) {
  const handle = await openVerifiedRegular(filePath, fsConstants.O_RDONLY, before, code, message);
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function verifyBoundPath(filePath, expectedHandle, manifest, code, message) {
  const before = await optionalStat(filePath);
  if (!before?.isFile() || before.isSymbolicLink()) throw transferError(code, message);
  const pathHandle = await openVerifiedRegular(filePath, fsConstants.O_RDONLY, before, code, message);
  try {
    const [expected, actual] = await Promise.all([expectedHandle.stat(), pathHandle.stat()]);
    if (!expected.isFile() || !actual.isFile() || expected.size !== manifest.size || actual.size !== manifest.size) {
      throw transferError(code, message);
    }
    const identity = sameFileIdentity(expected, actual);
    if (identity === false) throw transferError(code, message);
    if (identity === null && (await hashHandle(pathHandle, actual.size)) !== manifest.sha256) {
      throw transferError(code, message);
    }
    // Recheck the directory entry after opening. On POSIX this proves that the
    // pathname still names the verified descriptor. Windows builds without a
    // stable file id get an equivalent content check after publication too.
    const after = await optionalStat(filePath);
    if (!after?.isFile() || after.isSymbolicLink()) throw transferError(code, message);
    const afterIdentity = sameFileIdentity(actual, after);
    if (afterIdentity === false || (afterIdentity === null && !sameFile(actual, after))) {
      throw transferError(code, message);
    }
    return pathHandle;
  } catch (error) {
    await pathHandle.close().catch(() => {});
    throw error;
  }
}

function sameResumeMetadata(sidecar, expected) {
  return (
    sidecar?.v === 1 &&
    sidecar.transfer_id === expected.transferId &&
    sidecar.source === expected.source &&
    sidecar.name === expected.manifest.name &&
    sidecar.size === expected.manifest.size &&
    sidecar.sha256 === expected.manifest.sha256 &&
    Number.isSafeInteger(sidecar.committed) &&
    sidecar.committed >= 0 &&
    sidecar.committed <= expected.manifest.size
  );
}

export async function openLocalTarget({ directory, name, transferId, size, sha256, source = "" }) {
  if (!TRANSFER_ID_RE.test(String(transferId || ""))) {
    throw transferError("invalid_transfer", "transfer_id must be a UUID");
  }
  const manifest = validateFileManifest({ name, size, sha256 });
  const rawDirectory = String(directory || "");
  if (!path.isAbsolute(rawDirectory)) throw transferError("invalid_target", "target directory must be absolute");
  const requestedDir = path.resolve(rawDirectory);
  const directoryInfo = await stat(requestedDir);
  if (!directoryInfo.isDirectory()) throw transferError("invalid_target", "target directory is not a directory");
  const targetDir = await realpath(requestedDir);
  const finalPath = path.join(targetDir, manifest.name);
  if (await optionalStat(finalPath)) throw transferError("destination_exists", "destination already exists");

  const stem = `.fleet-transfer-${transferId}`;
  const partPath = path.join(targetDir, `${stem}.part`);
  const sidecarPath = path.join(targetDir, `${stem}.json`);
  const expected = { transferId, manifest, source: String(source || ""), partPath, sidecarPath };
  const sidecarInfo = await optionalStat(sidecarPath);
  const partInfo = await optionalStat(partPath);
  let committed = 0;
  let handle;
  if (sidecarInfo || partInfo) {
    if (!sidecarInfo?.isFile() || !partInfo?.isFile() || sidecarInfo.isSymbolicLink() || partInfo.isSymbolicLink()) {
      throw transferError("invalid_partial", "partial transfer files are incomplete or unsafe");
    }
    let saved;
    try {
      saved = JSON.parse(
        await readVerifiedFile(
          sidecarPath,
          sidecarInfo,
          "invalid_partial",
          "partial transfer sidecar changed while opening",
        ),
      );
    } catch {
      throw transferError("invalid_partial", "partial transfer sidecar is invalid");
    }
    if (!sameResumeMetadata(saved, expected) || partInfo.size !== saved.committed) {
      throw transferError("invalid_partial", "partial transfer metadata does not match");
    }
    committed = saved.committed;
    handle = await openVerifiedRegular(
      partPath,
      fsConstants.O_RDWR,
      partInfo,
      "invalid_partial",
      "partial transfer file changed while opening",
    );
  } else {
    handle = await open(partPath, "wx+", 0o600);
    await writeSidecar(expected, 0);
  }

  const target = {
    ...expected,
    finalPath,
    handle,
    committed,
    async prefixSHA256() {
      return hashHandle(handle, this.committed);
    },
    assertPrefix(expectedHash) {
      assertSHA256(expectedHash, "prefix_sha256");
      return this.prefixSHA256().then((actual) => {
        if (actual !== expectedHash) throw transferError("resume_mismatch", "partial file does not match source");
      });
    },
    async writeFrame(raw) {
      const frame = decodeFileFrame(raw);
      if (frame.offset !== this.committed) throw transferError("invalid_offset", "file frame is not contiguous");
      if (this.committed + frame.payload.length > manifest.size) {
        throw transferError("invalid_frame", "file frame exceeds declared size");
      }
      let written = 0;
      while (written < frame.payload.length) {
        const result = await handle.write(
          frame.payload,
          written,
          frame.payload.length - written,
          this.committed + written,
        );
        if (result.bytesWritten <= 0) throw transferError("write_failed", "target write made no progress");
        written += result.bytesWritten;
      }
      this.committed += written;
      return this.committed;
    },
    async checkpoint() {
      await handle.sync();
      await writeSidecar(this, this.committed);
      return this.committed;
    },
    async finish() {
      if (this.committed !== manifest.size) throw transferError("size_mismatch", "received size does not match manifest");
      await this.checkpoint();
      const got = await hashHandle(handle, manifest.size);
      if (got !== manifest.sha256) throw transferError("hash_mismatch", "received SHA-256 does not match manifest");
      await handle.sync();
      let partVerifier;
      let finalVerifier;
      try {
        partVerifier = await verifyBoundPath(
          partPath,
          handle,
          manifest,
          "path_changed",
          "partial transfer path no longer names the verified file",
        );
        await link(partPath, finalPath);
        finalVerifier = await verifyBoundPath(
          finalPath,
          handle,
          manifest,
          "path_changed",
          "published path does not name the verified file",
        );
      } catch (error) {
        await finalVerifier?.close().catch(() => {});
        await partVerifier?.close().catch(() => {});
        if (error?.code === "EEXIST") throw transferError("destination_exists", "destination appeared before commit");
        throw error;
      }
      await finalVerifier.close();
      await partVerifier.close();
      await handle.close();
      this.handle = null;
      await unlink(partPath);
      await unlink(sidecarPath);
      return { path: finalPath, size: manifest.size, sha256: manifest.sha256 };
    },
    async cancel() {
      if (this.handle) await handle.close().catch(() => {});
      this.handle = null;
      await unlink(partPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await unlink(sidecarPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
    async close() {
      if (this.handle) await handle.close();
      this.handle = null;
    },
  };
  return target;
}

export function fileEnvelope(type, body = {}) {
  return { v: 1, type, id: randomUUID(), t: Date.now(), body };
}

export function parseFileControl(raw) {
  const text = String(raw);
  if (Buffer.byteLength(text) > FILE_CONTROL_MAX_BYTES) {
    throw transferError("control_too_large", `file control frame exceeds ${FILE_CONTROL_MAX_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw transferError("invalid_control", "invalid file control JSON");
  }
  if (value?.v !== 1 || typeof value.type !== "string" || typeof value.body !== "object") {
    throw transferError("invalid_control", "invalid file control envelope");
  }
  return value;
}

function channelError(code, message) {
  return transferError(code, message);
}

function binaryMessage(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

function boundedInboxValue(raw) {
  const binary = binaryMessage(raw);
  if (binary) {
    if (binary.length > FILE_FRAME_HEADER_BYTES + FILE_CHUNK_BYTES) {
      throw channelError("frame_too_large", "file data frame exceeds the protocol limit");
    }
    return { value: raw, bytes: binary.length };
  }
  const bytes = Buffer.byteLength(String(raw));
  if (bytes > FILE_CONTROL_MAX_BYTES) {
    throw channelError("control_too_large", `file control frame exceeds ${FILE_CONTROL_MAX_BYTES} bytes`);
  }
  return { value: raw, bytes };
}

function createChannelInbox(channel, signal) {
  const queue = [];
  const waiters = [];
  let failure = null;
  let queuedBytes = 0;
  const cancelled = () => fail(channelError("cancelled", "file transfer cancelled"));
  const push = (raw) => {
    if (failure) return;
    let entry;
    try {
      entry = boundedInboxValue(raw);
    } catch (error) {
      fail(error);
      channel.close?.();
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(entry.value);
      return;
    }
    if (
      queue.length >= FILE_INBOX_MAX_MESSAGES ||
      queuedBytes + entry.bytes > FILE_INBOX_MAX_BYTES
    ) {
      fail(channelError("inbox_overflow", "file channel inbox exceeded its hard limit"));
      channel.close?.();
      return;
    }
    queue.push(entry);
    queuedBytes += entry.bytes;
  };
  const fail = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : channelError("direct_unavailable", String(error));
    queue.length = 0;
    queuedBytes = 0;
    signal?.removeEventListener("abort", cancelled);
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };
  channel.onmessage = (event) => push(event?.data ?? event);
  channel.onclose = () => fail(channelError("interrupted", "file data channel closed"));
  channel.onerror = (event) => fail(channelError("direct_unavailable", event?.error?.message || "file data channel failed"));
  signal?.addEventListener("abort", cancelled, { once: true });
  if (signal?.aborted) cancelled();
  return {
    next(timeoutMs = 30_000) {
      if (failure) return Promise.reject(failure);
      if (queue.length) {
        const entry = queue.shift();
        queuedBytes -= entry.bytes;
        return Promise.resolve(entry.value);
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(channelError("timeout", "file channel reply timeout"));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
    fail,
    dispose() {
      signal?.removeEventListener("abort", cancelled);
    },
  };
}

function sendControl(channel, type, transferId, body = {}) {
  const payload = JSON.stringify(fileEnvelope(type, { transfer_id: transferId, ...body }));
  if (Buffer.byteLength(payload) > FILE_CONTROL_MAX_BYTES) {
    throw channelError("control_too_large", `file control frame exceeds ${FILE_CONTROL_MAX_BYTES} bytes`);
  }
  channel.send(payload);
}

async function waitForBufferedChannel(channel, signal) {
  while (Number(channel.bufferedAmount || 0) > FILE_BUFFER_HIGH_WATER) {
    if (signal?.aborted) throw channelError("cancelled", "file transfer cancelled");
    if (["closed", "closing"].includes(channel.readyState)) {
      throw channelError("interrupted", "file data channel closed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function controlForTransfer(raw, transferId) {
  const binary = binaryMessage(raw);
  if (binary) return { binary };
  const message = parseFileControl(raw);
  if (message.body?.transfer_id !== transferId) {
    throw channelError("invalid_control", "file control belongs to another transfer");
  }
  return { message };
}

export async function sendLocalFile({ channel, source, transferId, signal, onProgress = () => {} }) {
  if (!TRANSFER_ID_RE.test(String(transferId || ""))) throw channelError("invalid_transfer", "transfer_id must be a UUID");
  const inbox = createChannelInbox(channel, signal);
  try {
    let ready;
    while (!ready) {
      const { message, binary } = controlForTransfer(await inbox.next(), transferId);
      if (binary) throw channelError("invalid_frame", "sender received an unexpected file frame");
      if (message.type === "file_error") throw channelError(message.body?.code || "remote_error", message.body?.error || "receiver failed");
      if (message.type === "file_cancel") throw channelError("cancelled", "receiver cancelled the transfer");
      if (message.type === "file_ready") ready = message.body;
    }
    const offset = Number(ready.offset);
    assertSafeInteger(offset, "resume offset");
    if (offset > source.manifest.size) throw channelError("invalid_offset", "receiver offset exceeds source size");
    assertSHA256(ready.prefix_sha256, "prefix_sha256");
    const prefix = await source.prefixSHA256(offset);
    if (prefix !== ready.prefix_sha256) throw channelError("resume_mismatch", "receiver partial file does not match source");

    let acknowledged = offset;
    let sent = offset;
    const waitAck = async () => {
      for (;;) {
        const { message, binary } = controlForTransfer(await inbox.next(), transferId);
        if (binary) throw channelError("invalid_frame", "sender received an unexpected file frame");
        if (message.type === "file_error") throw channelError(message.body?.code || "remote_error", message.body?.error || "receiver failed");
        if (message.type === "file_cancel") throw channelError("cancelled", "receiver cancelled the transfer");
        if (message.type !== "file_ack") continue;
        const committed = Number(message.body?.committed);
        assertSafeInteger(committed, "committed offset");
        if (committed < acknowledged || committed > sent) throw channelError("invalid_ack", "receiver acknowledged an impossible offset");
        acknowledged = committed;
        onProgress({ sent, committed: acknowledged, size: source.manifest.size });
        return;
      }
    };

    for await (const chunk of source.chunks(offset)) {
      if (signal?.aborted) throw channelError("cancelled", "file transfer cancelled");
      while (sent - acknowledged >= FILE_ACK_BYTES) await waitAck();
      await waitForBufferedChannel(channel, signal);
      channel.send(encodeFileFrame(chunk.offset, chunk.payload));
      sent = chunk.offset + chunk.payload.length;
      onProgress({ sent, committed: acknowledged, size: source.manifest.size });
    }
    sendControl(channel, "file_eof", transferId, { size: source.manifest.size, sha256: source.manifest.sha256 });
    for (;;) {
      const { message, binary } = controlForTransfer(await inbox.next(), transferId);
      if (binary) throw channelError("invalid_frame", "sender received an unexpected file frame");
      if (message.type === "file_ack") {
        const committed = Number(message.body?.committed);
        assertSafeInteger(committed, "committed offset");
        if (committed < acknowledged || committed > sent) throw channelError("invalid_ack", "receiver acknowledged an impossible offset");
        acknowledged = committed;
        continue;
      }
      if (message.type === "file_complete") {
        if (Number(message.body?.size) !== source.manifest.size || message.body?.sha256 !== source.manifest.sha256) {
          throw channelError("invalid_complete", "receiver completion does not match source");
        }
        sendControl(channel, "file_complete_ack", transferId, {
          size: source.manifest.size,
          sha256: source.manifest.sha256,
        });
        onProgress({ sent, committed: source.manifest.size, size: source.manifest.size });
        return { size: source.manifest.size, sha256: source.manifest.sha256 };
      }
      if (message.type === "file_error") throw channelError(message.body?.code || "remote_error", message.body?.error || "receiver failed");
      if (message.type === "file_cancel") throw channelError("cancelled", "receiver cancelled the transfer");
    }
  } catch (error) {
    try {
      sendControl(channel, error?.code === "cancelled" ? "file_cancel" : "file_error", transferId, {
        code: error?.code || "transfer_failed",
        error: error?.message || String(error),
      });
    } catch {
      /* Channel failure is already the primary error. */
    }
    throw error;
  } finally {
    inbox.dispose();
  }
}

export async function receiveLocalFile({ channel, target, transferId, signal, onProgress = () => {} }) {
  if (!TRANSFER_ID_RE.test(String(transferId || ""))) throw channelError("invalid_transfer", "transfer_id must be a UUID");
  const inbox = createChannelInbox(channel, signal);
  let lastAck = target.committed;
  const readyHash = await target.prefixSHA256();
  sendControl(channel, "file_ready", transferId, { offset: target.committed, prefix_sha256: readyHash });
  try {
    for (;;) {
      if (signal?.aborted) throw channelError("cancelled", "file transfer cancelled");
      const { message, binary } = controlForTransfer(await inbox.next(), transferId);
      if (binary) {
        const committed = await target.writeFrame(binary);
        onProgress({ committed, size: target.manifest.size });
        if (committed - lastAck >= FILE_ACK_BYTES) {
          await target.checkpoint();
          lastAck = committed;
          sendControl(channel, "file_ack", transferId, { committed });
        }
        continue;
      }
      if (message.type === "file_cancel") {
        await target.cancel();
        throw channelError("cancelled", "sender cancelled the transfer");
      }
      if (message.type === "file_error") throw channelError(message.body?.code || "remote_error", message.body?.error || "sender failed");
      if (message.type !== "file_eof") continue;
      if (Number(message.body?.size) !== target.manifest.size || message.body?.sha256 !== target.manifest.sha256) {
        throw channelError("invalid_eof", "sender EOF does not match manifest");
      }
      await target.checkpoint();
      sendControl(channel, "file_ack", transferId, { committed: target.committed });
      const result = await target.finish();
      sendControl(channel, "file_complete", transferId, { size: result.size, sha256: result.sha256 });
      onProgress({ committed: result.size, size: result.size });
      return result;
    }
  } catch (error) {
    if (error?.code === "cancelled") {
      await target.cancel().catch(() => {});
    } else {
      // A direct channel can disappear between ACK windows. Persist the exact
      // contiguous prefix before closing so the next RTC round can reopen the
      // same transfer instead of rejecting the longer .part as tampering.
      if (["interrupted", "direct_unavailable"].includes(error?.code)) {
        await target.checkpoint().catch(() => {});
      }
      await target.close().catch(() => {});
    }
    try {
      sendControl(channel, error?.code === "cancelled" ? "file_cancel" : "file_error", transferId, {
        code: error?.code || "transfer_failed",
        error: error?.message || String(error),
      });
    } catch {
      /* Channel failure is already the primary error. */
    }
    throw error;
  } finally {
    inbox.dispose();
  }
}
