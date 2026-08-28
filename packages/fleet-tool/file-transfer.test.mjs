import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FILE_CONTROL_MAX_BYTES,
  FILE_CHUNK_BYTES,
  FILE_INBOX_MAX_BYTES,
  FILE_INBOX_MAX_MESSAGES,
  decodeFileFrame,
  encodeFileFrame,
  fileEnvelope,
  openLocalSource,
  openLocalTarget,
  parseFileControl,
  receiveLocalFile,
  safeFileName,
  sendLocalFile,
  validateFileManifest,
} from "./file-transfer.mjs";

test("Agent and Tool share one golden fleet-file-v1 control envelope", async () => {
  const raw = await readFile(new URL("./testdata/file-control-v1.json", import.meta.url), "utf8");
  const message = parseFileControl(raw);
  assert.equal(message.type, "file_ack");
  assert.equal(message.body.transfer_id, "e3407bcb-732a-45ee-80e2-0f95761b5b13");
  assert.equal(message.body.committed, FILE_CHUNK_BYTES);
  assert.equal(Object.hasOwn(message, "committed"), false);
});

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-transfer-tool-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function assertMissing(filePath) {
  await assert.rejects(() => lstat(filePath), (error) => error?.code === "ENOENT");
}

test("file frame is bounded binary with an exact uint64 offset", () => {
  const payload = Buffer.alloc(FILE_CHUNK_BYTES, 0xa5);
  const decoded = decodeFileFrame(encodeFileFrame(2 ** 40 + 7, payload));
  assert.equal(decoded.offset, 2 ** 40 + 7);
  assert.deepEqual(decoded.payload, payload);
  assert.throws(() => encodeFileFrame(0, Buffer.alloc(FILE_CHUNK_BYTES + 1)), /exceeds/);
  assert.throws(() => decodeFileFrame(Buffer.from("not-a-frame")), /magic/);
});

test("manifest only accepts one basename and a canonical SHA-256", () => {
  assert.equal(safeFileName("report.txt"), "report.txt");
  for (const name of ["../report.txt", "dir/report.txt", "dir\\report.txt", ".", "..", ""]) {
    assert.throws(() => safeFileName(name));
  }
  assert.deepEqual(validateFileManifest({ name: "a", size: 0, sha256: sha256("") }), {
    name: "a",
    size: 0,
    sha256: sha256(""),
  });
});

test("local source and target paths must be absolute", async () => {
  await assert.rejects(() => openLocalSource("relative/source.bin"), /absolute/);
  await assert.rejects(
    () => openLocalTarget({
      directory: "relative/inbox",
      name: "received.bin",
      transferId: randomUUID(),
      size: 0,
      sha256: sha256(""),
      source: "tool:test",
    }),
    /absolute/,
  );
});

test("source holds one regular-file descriptor and rejects symlinks", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "source.bin");
  const alias = path.join(dir, "alias.bin");
  const data = Buffer.from("same descriptor, no path re-open");
  await writeFile(file, data);
  await symlink(file, alias);
  await assert.rejects(() => openLocalSource(alias), /symlink/);
  const source = await openLocalSource(file);
  t.after(() => source.close().catch(() => {}));
  assert.deepEqual(source.manifest, { name: "source.bin", size: data.length, sha256: sha256(data) });
  assert.equal(await source.prefixSHA256(4), sha256(data.subarray(0, 4)));
  const chunks = [];
  for await (const chunk of source.chunks(5)) chunks.push(chunk.payload);
  assert.deepEqual(Buffer.concat(chunks), data.subarray(5));
});

test("target resumes from a verified checkpoint and commits without overwrite", async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.alloc(FILE_CHUNK_BYTES * 3 + 19);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
  const transferId = randomUUID();
  const input = {
    directory: dir,
    name: "received.bin",
    transferId,
    size: data.length,
    sha256: sha256(data),
    source: "device:source-a",
  };
  let target = await openLocalTarget(input);
  const stop = FILE_CHUNK_BYTES + 7;
  await target.writeFrame(encodeFileFrame(0, data.subarray(0, FILE_CHUNK_BYTES)));
  await target.writeFrame(encodeFileFrame(FILE_CHUNK_BYTES, data.subarray(FILE_CHUNK_BYTES, stop)));
  await target.checkpoint();
  const prefix = await target.prefixSHA256();
  assert.equal(prefix, sha256(data.subarray(0, stop)));
  await target.close();

  target = await openLocalTarget(input);
  assert.equal(target.committed, stop);
  await target.assertPrefix(sha256(data.subarray(0, stop)));
  let offset = stop;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + FILE_CHUNK_BYTES);
    await target.writeFrame(encodeFileFrame(offset, data.subarray(offset, end)));
    offset = end;
  }
  const result = await target.finish();
  assert.equal(result.path, path.join(await realpath(dir), "received.bin"));
  assert.deepEqual(await readFile(result.path), data);
  await assert.rejects(() => openLocalTarget({ ...input, transferId: randomUUID() }), /already exists/);
});

test("target refuses a regular-file path swap before no-clobber publication", async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.from("the descriptor, not the pathname, is authoritative");
  const target = await openLocalTarget({
    directory: dir,
    name: "published.bin",
    transferId: randomUUID(),
    size: data.length,
    sha256: sha256(data),
    source: "device:source-a",
  });
  await target.writeFrame(encodeFileFrame(0, data));
  await target.checkpoint();
  const heldPath = `${target.partPath}.held`;
  await rename(target.partPath, heldPath);
  await writeFile(target.partPath, Buffer.alloc(data.length, 0x41), { mode: 0o600 });

  await assert.rejects(() => target.finish(), (error) => error?.code === "path_changed");
  await assertMissing(target.finalPath);
  await target.close();
});

test("target refuses a symlink swapped into the partial pathname", async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.from("symlink swap");
  const target = await openLocalTarget({
    directory: dir,
    name: "published.bin",
    transferId: randomUUID(),
    size: data.length,
    sha256: sha256(data),
    source: "device:source-a",
  });
  await target.writeFrame(encodeFileFrame(0, data));
  await target.checkpoint();
  const heldPath = `${target.partPath}.held`;
  await rename(target.partPath, heldPath);
  try {
    await symlink(heldPath, target.partPath);
  } catch (error) {
    await target.close();
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("Windows host does not grant symlink creation privilege");
      return;
    }
    throw error;
  }

  await assert.rejects(() => target.finish(), (error) => error?.code === "path_changed");
  await assertMissing(target.finalPath);
  await target.close();
});

test("zero-byte transfer commits and tampered partial cannot resume silently", async (t) => {
  const dir = await tempDir(t);
  const empty = await openLocalTarget({
    directory: dir,
    name: "empty.bin",
    transferId: randomUUID(),
    size: 0,
    sha256: sha256(""),
    source: "tool:test",
  });
  await empty.finish();
  assert.deepEqual(await readFile(path.join(dir, "empty.bin")), Buffer.alloc(0));

  const data = Buffer.from("abcdefghij");
  const input = {
    directory: dir,
    name: "resume.bin",
    transferId: randomUUID(),
    size: data.length,
    sha256: sha256(data),
    source: "tool:test",
  };
  let target = await openLocalTarget(input);
  await target.writeFrame(encodeFileFrame(0, data.subarray(0, 5)));
  await target.checkpoint();
  const partPath = target.partPath;
  await target.close();
  await writeFile(partPath, Buffer.from("xxxxx"));
  target = await openLocalTarget(input);
  await assert.rejects(() => target.assertPrefix(sha256(data.subarray(0, 5))), /does not match/);
  await target.cancel();
});

test("an interrupted receiver checkpoints its exact 37% prefix for the next RTC round", async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.alloc(100);
  for (let index = 0; index < data.length; index += 1) data[index] = index;
  const transferId = randomUUID();
  const input = {
    directory: dir,
    name: "resume-37.bin",
    transferId,
    size: data.length,
    sha256: sha256(data),
    source: "device:source-a",
  };
  const target = await openLocalTarget(input);
  const [sender, receiver] = channelPair();
  let sent = false;
  sender.onmessage = () => {
    if (sent) return;
    sent = true;
    sender.send(encodeFileFrame(0, data.subarray(0, 37)));
    setImmediate(() => sender.close());
  };
  await assert.rejects(
    receiveLocalFile({ channel: receiver, target, transferId }),
    (error) => error?.code === "interrupted",
  );

  const resumed = await openLocalTarget(input);
  assert.equal(resumed.committed, 37);
  assert.equal(await resumed.prefixSHA256(), sha256(data.subarray(0, 37)));
  await resumed.cancel();
});

function idleChannel() {
  return {
    readyState: "open",
    bufferedAmount: 0,
    sent: [],
    send(value) {
      this.sent.push(value);
    },
    close() {
      this.readyState = "closed";
      this.onclose?.();
    },
  };
}

function emptySource() {
  return {
    manifest: { name: "empty.bin", size: 0, sha256: sha256("") },
    prefixSHA256: async () => sha256(""),
    async *chunks() {},
  };
}

test("file control frames and inbox queue have hard byte and message limits", async (t) => {
  assert.throws(
    () => parseFileControl("x".repeat(FILE_CONTROL_MAX_BYTES + 1)),
    (error) => error?.code === "control_too_large",
  );

  await t.test("message count", async () => {
    const channel = idleChannel();
    const transferId = randomUUID();
    const pending = sendLocalFile({ channel, source: emptySource(), transferId });
    const noop = JSON.stringify(fileEnvelope("noop", { transfer_id: transferId }));
    channel.onmessage({ data: noop });
    for (let index = 0; index <= FILE_INBOX_MAX_MESSAGES; index += 1) {
      channel.onmessage({ data: noop });
    }
    await assert.rejects(pending, (error) => error?.code === "inbox_overflow");
  });

  await t.test("queued bytes", async () => {
    const channel = idleChannel();
    const transferId = randomUUID();
    const pending = sendLocalFile({ channel, source: emptySource(), transferId });
    const noop = JSON.stringify(fileEnvelope("noop", { transfer_id: transferId }));
    const bulky = "x".repeat(FILE_CONTROL_MAX_BYTES);
    channel.onmessage({ data: noop });
    const messages = Math.floor(FILE_INBOX_MAX_BYTES / FILE_CONTROL_MAX_BYTES) + 1;
    for (let index = 0; index < messages; index += 1) {
      channel.onmessage({ data: bulky });
    }
    await assert.rejects(pending, (error) => error?.code === "inbox_overflow");
  });
});

test("AbortSignal wakes a blocked file inbox immediately", async () => {
  const channel = idleChannel();
  const controller = new AbortController();
  const started = Date.now();
  const pending = sendLocalFile({
    channel,
    source: emptySource(),
    transferId: randomUUID(),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "cancelled");
  assert.ok(Date.now() - started < 250, "cancel must not wait for the 30 second inbox timer");
});

function channelPair() {
  const left = { readyState: "open", bufferedAmount: 0 };
  const right = { readyState: "open", bufferedAmount: 0 };
  for (const [from, to] of [
    [left, right],
    [right, left],
  ]) {
    from.send = (data) => {
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      from.bufferedAmount += size;
      setImmediate(() => {
        from.bufferedAmount -= size;
        to.onmessage?.({ data: Buffer.isBuffer(data) ? Buffer.from(data) : data });
      });
    };
    from.close = () => {
      from.readyState = "closed";
      to.readyState = "closed";
      from.onclose?.();
      to.onclose?.();
    };
  }
  return [left, right];
}

test("dedicated channel transfers 32 MiB with bounded ACK windows", async (t) => {
  const dir = await tempDir(t);
  const sourcePath = path.join(dir, "large.bin");
  const targetDir = path.join(dir, "target");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(targetDir);
  const data = Buffer.alloc((32 << 20) + 123);
  for (let offset = 0; offset < data.length; offset += 4096) data.writeUInt32LE(offset, offset);
  await writeFile(sourcePath, data);
  const source = await openLocalSource(sourcePath);
  t.after(() => source.close().catch(() => {}));
  const transferId = randomUUID();
  const target = await openLocalTarget({
    directory: targetDir,
    ...source.manifest,
    transferId,
    source: "tool:test",
  });
  const [sender, receiver] = channelPair();
  const senderControls = [];
  const send = sender.send;
  sender.send = (value) => {
    if (typeof value === "string") senderControls.push(JSON.parse(value));
    send(value);
  };
  const [sent, received] = await Promise.all([
    sendLocalFile({ channel: sender, source, transferId }),
    receiveLocalFile({ channel: receiver, target, transferId }),
  ]);
  assert.equal(sent.sha256, source.manifest.sha256);
  assert.equal(received.sha256, source.manifest.sha256);
  assert.equal(sha256(await readFile(received.path)), source.manifest.sha256);
  const completeAck = senderControls.find((message) => message.type === "file_complete_ack");
  assert.deepEqual(completeAck?.body, {
    transfer_id: transferId,
    size: source.manifest.size,
    sha256: source.manifest.sha256,
  });
});
