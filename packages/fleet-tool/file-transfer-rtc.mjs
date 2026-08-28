import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  FILE_CHANNEL_LABEL,
  FILE_CHUNK_BYTES,
  openLocalSource,
  openLocalTarget,
  receiveLocalFile,
  sendLocalFile,
  validateFileManifest,
} from "./file-transfer.mjs";

const CONNECT_TIMEOUT_MS = 15_000;
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const RESUME_TOTAL_MS = 30 * 60_000;
const MAX_TRANSFER_ROUNDS = 4;
const POLL_MS = 100;
const DROP_MAIL = Symbol("drop-mail");
let peerConnectionCtor;

async function loadPeerConnection() {
  peerConnectionCtor ||= import("werift").then((module) => module.RTCPeerConnection);
  return peerConnectionCtor;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("file transfer cancelled"), { code: "cancelled" }));
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => done(Object.assign(new Error("file transfer cancelled"), { code: "cancelled" }));
    const timer = setTimeout(() => done(), ms);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function rtcFingerprint(sdp) {
  const match = String(sdp || "").match(/^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$/im);
  const value = match ? match[1].replaceAll(":", "").toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(value) ? value : "";
}

function transferFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeSource(raw, operatorId) {
  const kind = raw?.kind === "tool" ? "tool" : raw?.kind === "device" ? "device" : "";
  const sourcePath = typeof raw?.path === "string" ? raw.path : "";
  if (!kind || !sourcePath) throw transferFailure("invalid_source", "source kind and path are required");
  if (kind === "tool") {
    if (!path.isAbsolute(sourcePath)) throw transferFailure("invalid_source", "Tool source path must be absolute");
    return { kind, id: operatorId, path: sourcePath };
  }
  const id = String(raw?.device_id || raw?.id || "").trim();
  if (!id) throw transferFailure("invalid_source", "source device_id is required");
  return { kind, id, path: sourcePath };
}

function normalizeTarget(raw, operatorId) {
  const kind = raw?.kind === "tool" ? "tool" : raw?.kind === "device" ? "device" : "";
  const directory = typeof raw?.directory === "string" ? raw.directory : "";
  if (!kind || !directory) throw transferFailure("invalid_target", "target kind and directory are required");
  if (kind === "tool") {
    if (!path.isAbsolute(directory)) throw transferFailure("invalid_target", "Tool target directory must be absolute");
    return { kind, id: operatorId, directory };
  }
  const id = String(raw?.device_id || raw?.id || "").trim();
  if (!id) throw transferFailure("invalid_target", "target device_id is required");
  return { kind, id, directory };
}

function failureCode(error) {
  const value = String(error?.code || "TRANSFER_FAILED").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return value.slice(0, 64) || "TRANSFER_FAILED";
}

function localStatus(row) {
  return {
    transfer_id: row.transferId,
    phase: row.phase,
    direct_only: true,
    progress: { ...row.progress },
    ...(row.error ? { error: row.error } : {}),
    ...(row.result ? { result: row.result } : {}),
  };
}

async function waitOpen(channel, peer, signal, timeoutMs = CONNECT_TIMEOUT_MS) {
  if (signal?.aborted) throw transferFailure("cancelled", "file transfer cancelled");
  if (channel?.readyState === "open") return channel;
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => done(transferFailure("cancelled", "file transfer cancelled"));
    const timer = setTimeout(
      () => done(transferFailure("direct_unavailable", "direct file channel timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancelled, { once: true });
    channel.onopen = () => done();
    channel.onerror = () => done(transferFailure("direct_unavailable", "direct file channel failed"));
    channel.onclose = () => done(transferFailure("direct_unavailable", "direct file channel closed"));
    peer.connectionStateChange.subscribe((state) => {
      if (["failed", "disconnected", "closed"].includes(state)) {
        done(transferFailure("direct_unavailable", `direct peer ${state}`));
      }
    });
  });
  return channel;
}

function iceServers(config) {
  return (Array.isArray(config?.stun_urls) ? config.stun_urls : [])
    .filter((value) => String(value).startsWith("stun:"))
    .map((urls) => ({ urls }));
}

function endpointBinding(endpoint) {
  return createHash("sha256")
    .update(String(endpoint.kind))
    .update("\0")
    .update(String(endpoint.id))
    .digest("hex");
}

function waitDataChannel(peer, signal, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(transferFailure("cancelled", "file transfer cancelled"));
      return;
    }
    let settled = false;
    const done = (error, channel) => {
      if (settled) {
        if (channel) channel.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else resolve(channel);
    };
    const cancelled = () => done(transferFailure("cancelled", "file transfer cancelled"));
    const timer = setTimeout(
      () => done(transferFailure("direct_unavailable", "peer did not open file channel")),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancelled, { once: true });
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== FILE_CHANNEL_LABEL) {
        channel.close();
        return;
      }
      done(null, channel);
    });
  });
}

export function createFileTransferManager({
  hubPost,
  token,
  operatorId,
  verifyTokenV1,
  verifyFleetStatement,
  runtime = {},
}) {
  const rows = new Map();
  let claimsPromise;
  const getPeerConnection = runtime.loadPeerConnection || loadPeerConnection;
  const openSource = runtime.openLocalSource || openLocalSource;
  const openTarget = runtime.openLocalTarget || openLocalTarget;
  const sendFile = runtime.sendLocalFile || sendLocalFile;
  const receiveFile = runtime.receiveLocalFile || receiveLocalFile;
  const newId = runtime.randomUUID || randomUUID;
  const now = runtime.now || Date.now;
  const sleep = runtime.delay || delay;
  const maxRounds = runtime.maxTransferRounds || MAX_TRANSFER_ROUNDS;
  const resumeTotalMs = runtime.resumeTotalMs || RESUME_TOTAL_MS;

  async function claims() {
    claimsPromise ||= verifyTokenV1(token);
    return claimsPromise;
  }

  async function post(pathname, body) {
    return hubPost(`/v1/transfer/${pathname}`, body);
  }

  async function status(transferId) {
    const id = String(transferId || "").trim();
    if (!id) throw transferFailure("invalid_transfer", "transfer_id required");
    const remote = await post("status", { transfer_id: id });
    const local = rows.get(id);
    return local ? { ...remote.transfer, local: localStatus(local) } : remote.transfer;
  }

  async function poll(transferId, signal) {
    const value = await post("signal/poll", { transfer_id: transferId });
    if (signal?.aborted) throw transferFailure("cancelled", "file transfer cancelled");
    return Array.isArray(value?.items) ? value.items : [];
  }

  async function waitFor(row, match, timeoutMs = PREPARE_TIMEOUT_MS) {
    const deadline = Math.min(now() + timeoutMs, row.deadline);
    while (now() < deadline) {
      for (let index = 0; index < row.mailbox.length; index += 1) {
        const item = row.mailbox[index];
        const found = match(item);
        if (found === DROP_MAIL) {
          row.mailbox.splice(index, 1);
          index -= 1;
          continue;
        }
        if (found) {
          row.mailbox.splice(index, 1);
          return found;
        }
      }
      const items = await poll(row.transferId, row.abort.signal);
      row.mailbox.push(...items);
      if (items.length === 0) await sleep(POLL_MS, row.abort.signal);
    }
    throw transferFailure("timeout", "file transfer peer did not respond");
  }

  async function waitPhase(row, wanted, timeoutMs = PREPARE_TIMEOUT_MS) {
    const deadline = Math.min(now() + timeoutMs, row.deadline);
    while (now() < deadline) {
      const remote = await status(row.transferId);
      if (wanted.includes(remote.phase)) return remote;
      if (["failed", "cancelled", "expired"].includes(remote.phase)) {
        throw transferFailure(remote.failure_code || remote.phase, `file transfer ${remote.phase}`);
      }
      await sleep(POLL_MS, row.abort.signal);
    }
    throw transferFailure("timeout", "file transfer preparation timed out");
  }

  async function decodeTicket(signed) {
    const tokenClaims = await claims();
    if (!tokenClaims?.pub || !tokenClaims?.kid) {
      throw transferFailure("ticket_rejected", "Hub token claims are incomplete");
    }
    let ticket;
    try {
      ticket = await verifyFleetStatement({ publicSpkiB64: tokenClaims.pub, ...signed });
    } catch {
      throw transferFailure("ticket_rejected", "file transfer ticket signature is invalid");
    }
    if (!ticket || typeof ticket !== "object") {
      throw transferFailure("ticket_rejected", "file transfer ticket signature is invalid");
    }
    return { ticket, tokenClaims };
  }

  function assertTicket({ row, ticket, tokenClaims, sid, offer, answer, manifest, resume }) {
    const checkedAt = now();
    const exact = {
      v: 1,
      kind: "file_transfer",
      sid,
      kid: tokenClaims.kid,
      operator_id: operatorId,
      source_kind: row.source.kind,
      source_id: row.source.id,
      target_kind: row.target.kind,
      target_id: row.target.id,
      offerer_kind: row.source.kind,
      offerer_id: row.source.id,
      answerer_kind: row.target.kind,
      answerer_id: row.target.id,
      file_name: manifest.name,
      file_size: manifest.size,
      file_sha256: manifest.sha256,
      chunk_size: FILE_CHUNK_BYTES,
      resume_offset: resume.offset,
      prefix_sha256: resume.prefix_sha256,
      offer_fp: rtcFingerprint(offer),
      answer_fp: rtcFingerprint(answer),
      direct_only: true,
    };
    if (Object.entries(exact).some(([key, value]) => ticket[key] !== value)) {
      throw transferFailure("ticket_rejected", "file transfer ticket does not match this connection");
    }
    if (
      ticket.transfer_id !== row.transferId ||
      typeof ticket.user_id !== "string" ||
      !ticket.user_id ||
      !Number.isSafeInteger(ticket.iat) ||
      !Number.isSafeInteger(ticket.exp) ||
      ticket.iat <= 0 ||
      ticket.iat > checkedAt + 30_000 ||
      ticket.exp <= ticket.iat ||
      ticket.exp <= checkedAt ||
      ticket.exp - ticket.iat > 60_000
    ) {
      throw transferFailure("ticket_rejected", "file transfer ticket is expired or invalid");
    }
    return ticket;
  }

  async function waitTicket(row, { sid, offer, answer, manifest, resume }) {
    for (;;) {
      const signed = await waitFor(row, (item) => (item?.kind === "ticket" ? item.statement : null));
      const decoded = await decodeTicket(signed);
      if (decoded.ticket.sid !== sid && row.usedSids.has(decoded.ticket.sid)) {
        // signal/poll is consume-on-read. A ticket from the previous RTC round
        // may already be in this process's mailbox when an interrupt wins the
        // race. It is signed but no longer authoritative, so drop it.
        continue;
      }
      return assertTicket({ row, ...decoded, sid, offer, answer, manifest, resume });
    }
  }

  async function peerConfig(row) {
    const device = row.source.kind === "device" ? row.source.id : row.target.id;
    const config = await hubPost("/v1/rtc/config", { device_id: device });
    if (!config?.available) throw transferFailure("direct_unavailable", config?.reason || "device does not support direct transfer");
    return { iceServers: iceServers(config) };
  }

  function retryableRoundError(row, error) {
    if (row.abort.signal.aborted || !row.roundStarted) return false;
    return ["interrupted", "direct_unavailable"].includes(String(error?.code || "").toLowerCase());
  }

  function nextSid(row) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const sid = newId();
      if (!row.usedSids.has(sid)) {
        row.usedSids.add(sid);
        return sid;
      }
    }
    throw transferFailure("sid_exhausted", "could not allocate a fresh file signaling sid");
  }

  async function closePeer(row, expected = row.peer) {
    if (!expected) return;
    if (row.peer === expected) row.peer = null;
    await expected.close().catch(() => {});
  }

  async function cancelTarget(row) {
    const target = row.targetHandle;
    if (!target || row.cancelledTargets.has(target)) return;
    row.cancelledTargets.add(target);
    await target.cancel().catch(() => {});
  }

  async function reportInterrupt(row, sid) {
    if (row.reportedInterrupts.has(sid)) return;
    row.reportedInterrupts.add(sid);
    await post("event", { transfer_id: row.transferId, event: "interrupt" }).catch(() => {});
  }

  async function prepareRetry(row, error, sid, round) {
    if (!retryableRoundError(row, error)) throw error;
    if (round >= maxRounds || now() >= row.deadline) {
      throw transferFailure("direct_unavailable", "direct file transfer resume limit reached");
    }
    row.phase = "interrupted";
    row.roundStarted = false;
    await reportInterrupt(row, sid);
    // The peer may have won the interrupt race, or its target may already have
    // re-authorized. Both states prove that the old transport is dead.
    await waitPhase(row, ["interrupted", "signaling"]);
  }

  async function sourceRound(row, manifest, resume) {
    row.phase = "signaling";
    row.roundStarted = false;
    const config = await peerConfig(row);
    const RTCPeerConnection = await getPeerConnection();
    const pc = new RTCPeerConnection(config);
    row.peer = pc;
    const channel = pc.createDataChannel(FILE_CHANNEL_LABEL, { ordered: true });
    const sid = nextSid(row);
    try {
      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);
      const offer = pc.localDescription?.sdp || offerDescription.sdp;
      if (!rtcFingerprint(offer)) throw transferFailure("direct_unavailable", "file offer fingerprint missing");
      await post("signal", {
        transfer_id: row.transferId,
        role: "source",
        sid,
        signal: { kind: "offer", seq: 1, sdp: offer },
      });
      const answer = await waitFor(row, (item) => {
        if (item?.kind !== "signal") return null;
        if (item.sid !== sid) return DROP_MAIL;
        return item.signal?.kind === "answer" ? item.signal.sdp : DROP_MAIL;
      });
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await waitTicket(row, { sid, offer, answer, manifest, resume });
      await waitOpen(channel, pc, row.abort.signal);
      await post("event", { transfer_id: row.transferId, event: "start" });
      row.roundStarted = true;
      row.phase = "transferring";
      const result = await sendFile({
        channel,
        source: row.sourceHandle,
        transferId: row.transferId,
        signal: row.abort.signal,
        onProgress: (progress) => {
          row.progress = progress;
        },
      });
      return { result, sid };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { fileSid: sid });
    } finally {
      await closePeer(row, pc);
    }
  }

  async function runLocalSource(row) {
    row.phase = "preparing_source";
    const source = await openSource(row.source.path);
    row.sourceHandle = source;
    const manifest = source.manifest;
    await post("authorize", {
      transfer_id: row.transferId,
      role: "source",
      preparation: { file: { ...manifest, chunk_size: FILE_CHUNK_BYTES } },
    });
    for (let round = 1; round <= maxRounds; round += 1) {
      const prepared = await waitPhase(row, ["signaling", "ready"]);
      const resume = {
        offset: Number(prepared.resume?.offset || 0),
        prefix_sha256: String(prepared.resume?.prefix_sha256 || ""),
      };
      try {
        const finished = await sourceRound(row, manifest, resume);
        row.result = finished.result;
        row.phase = "completed";
        return;
      } catch (error) {
        await prepareRetry(row, error, error?.fileSid || "unknown", round);
      }
    }
  }

  async function targetRound(row, manifest, resume) {
    row.phase = "signaling";
    row.roundStarted = false;
    const offerItem = await waitFor(row, (item) => {
      if (item?.kind !== "signal") return null;
      if (item.signal?.kind !== "offer") return DROP_MAIL;
      if (row.usedSids.has(item.sid)) return DROP_MAIL;
      return item;
    });
    const sid = offerItem.sid;
    row.usedSids.add(sid);
    const offer = offerItem.signal.sdp;
    const config = await peerConfig(row);
    const RTCPeerConnection = await getPeerConnection();
    const pc = new RTCPeerConnection(config);
    row.peer = pc;
    try {
      const channelPromise = waitDataChannel(pc, row.abort.signal);
      void channelPromise.catch(() => {});
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);
      const answer = pc.localDescription?.sdp || answerDescription.sdp;
      if (!rtcFingerprint(answer)) throw transferFailure("direct_unavailable", "file answer fingerprint missing");
      await post("signal", {
        transfer_id: row.transferId,
        role: "target",
        sid,
        signal: { kind: "answer", seq: 1, sdp: answer },
      });
      await waitTicket(row, { sid, offer, answer, manifest, resume });
      const channel = await channelPromise;
      await waitOpen(channel, pc, row.abort.signal);
      row.roundStarted = true;
      row.phase = "transferring";
      const result = await receiveFile({
        channel,
        target: row.targetHandle,
        transferId: row.transferId,
        signal: row.abort.signal,
        onProgress: (progress) => {
          row.progress = progress;
        },
      });
      return { result, sid };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { fileSid: sid });
    } finally {
      await closePeer(row, pc);
    }
  }

  async function runLocalTarget(row) {
    row.phase = "waiting_source";
    const manifestItem = await waitFor(row, (item) => (item?.kind === "manifest" ? item.file : null));
    const manifest = validateFileManifest({
      name: manifestItem.name,
      size: manifestItem.size,
      sha256: manifestItem.sha256,
    });
    if (Number(manifestItem.chunkSize ?? manifestItem.chunk_size) !== FILE_CHUNK_BYTES) {
      throw transferFailure("invalid_manifest", "peer chunk size is not fleet-file-v1");
    }
    const targetInput = {
      directory: row.target.directory,
      ...manifest,
      transferId: row.transferId,
      source: endpointBinding(row.source),
    };
    for (let round = 1; round <= maxRounds; round += 1) {
      row.phase = "preparing_target";
      row.targetHandle = await openTarget(targetInput);
      const prefixSHA256 = await row.targetHandle.prefixSHA256();
      const resume = { offset: row.targetHandle.committed, prefix_sha256: prefixSHA256 };
      row.progress = { committed: resume.offset, size: manifest.size };
      await post("authorize", {
        transfer_id: row.transferId,
        role: "target",
        preparation: { resume },
      });
      try {
        const finished = await targetRound(row, manifest, resume);
        row.result = finished.result;
        await post("event", { transfer_id: row.transferId, event: "complete" });
        row.phase = "completed";
        return;
      } catch (error) {
        if (retryableRoundError(row, error)) {
          await row.targetHandle?.close().catch(() => {});
        }
        await prepareRetry(row, error, error?.fileSid || "unknown", round);
      }
    }
  }

  async function run(row) {
    try {
      if (row.source.kind === "tool") await runLocalSource(row);
      else if (row.target.kind === "tool") await runLocalTarget(row);
    } catch (error) {
      const cancelled = row.abort.signal.aborted || error?.code === "cancelled";
      row.phase = cancelled ? "cancelled" : error?.code === "direct_unavailable" ? "direct_unavailable" : "failed";
      row.error = error?.message || String(error);
      if (!cancelled) {
        await post("event", {
          transfer_id: row.transferId,
          event: "fail",
          failure_code: failureCode(error),
        }).catch(() => {});
      }
    } finally {
      await row.sourceHandle?.close().catch(() => {});
      if (row.abort.signal.aborted) await cancelTarget(row);
      else await row.targetHandle?.close().catch(() => {});
      await closePeer(row);
    }
  }

  async function start(input) {
    const source = normalizeSource(input?.source, operatorId);
    const target = normalizeTarget(input?.target, operatorId);
    if (source.kind === target.kind && source.id === target.id) {
      throw transferFailure("endpoint_collision", "source and target must be different endpoints");
    }
    if (source.kind === "tool" && target.kind === "tool") {
      throw transferFailure("unsupported_pair", "tool-to-tool transfer is not supported");
    }
    const created = await post("create", {
      source: { kind: source.kind, id: source.id },
      target: { kind: target.kind, id: target.id },
      source_path: source.kind === "device" ? source.path : "",
      target_path: target.kind === "device" ? target.directory : "",
    });
    const transferId = created?.transfer?.transfer_id;
    if (!transferId) throw transferFailure("invalid_response", "Hub did not return transfer_id");
    const row = {
      transferId,
      source,
      target,
      abort: new AbortController(),
      phase: created.transfer.phase,
      progress: { committed: 0, size: 0 },
      error: "",
      result: null,
      peer: null,
      sourceHandle: null,
      targetHandle: null,
      mailbox: [],
      usedSids: new Set(),
      reportedInterrupts: new Set(),
      cancelledTargets: new WeakSet(),
      roundStarted: false,
      deadline: now() + resumeTotalMs,
      done: null,
    };
    rows.set(transferId, row);
    if (source.kind === "tool" || target.kind === "tool") row.done = run(row);
    return { ...created.transfer, local: localStatus(row) };
  }

  async function cancel(transferId) {
    const id = String(transferId || "").trim();
    const row = rows.get(id);
    row?.abort.abort();
    if (row) {
      row.phase = "cancelled";
      await closePeer(row);
      await cancelTarget(row);
    }
    const remote = await post("event", { transfer_id: id, event: "cancel" });
    return remote.transfer;
  }

  return { start, status, cancel, _rows: rows };
}
