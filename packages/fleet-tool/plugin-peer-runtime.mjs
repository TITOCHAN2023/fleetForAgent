import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createPluginPeerAPI } from "./plugin-peer-api.mjs";

const CHANNEL_LABEL = "fleet-plugin-peer-v1";
const CONTROL_MAX = 64 << 10;
const DATA_MAX = 32 << 10;
const OPAQUE_INPUT_MAX = 8 << 10;
const INBOX_MAX = 128;
const INBOX_BYTES_MAX = 2 << 20;
const SEND_WINDOW = 4 << 20;
const CONNECT_TIMEOUT_MS = 15_000;
const HALF_CLOSE_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 10_000;
const SESSION_TOTAL_MS = 30 * 60_000;
const MAX_ROUNDS = 4;
const POLL_MS = 100;
const EVENT_RETRIES = 4;
const DROP = Symbol("drop");
const TERMINAL_PHASES = new Set(["completed", "cancelled", "failed", "expired"]);
const DELIVERY_TYPES = new Set([
  "peer_session_prepare",
  "peer_session_round_prepare",
  "peer_session_signal",
  "peer_session_ticket",
  "peer_session_update",
]);
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let peerConnectionCtor;

async function loadPeerConnection() {
  peerConnectionCtor ||= import("werift").then((module) => module.RTCPeerConnection);
  return peerConnectionCtor;
}

function peerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sessionUUID(value) {
  if (value == null || value === "") return randomUUID();
  const id = String(value).trim();
  if (!UUID_V4_RE.test(id)) throw peerError("invalid_session", "session_id must be a UUIDv4");
  return id.toLowerCase();
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(peerError("cancelled", "plugin peer cancelled"));
    const timer = setTimeout(done, ms);
    const aborted = () => done(peerError("cancelled", "plugin peer cancelled"));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function bounded(promise, ms, code, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(peerError(code, message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || peerError("cancelled", "plugin peer cancelled"));
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => finish(reject, signal.reason || peerError("cancelled", "plugin peer cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

/** Worker ticket canonical form: lower-case SHA-256 hex without separators. */
function peerFingerprint(sdp) {
  const found = [...String(sdp || "").matchAll(/^a=fingerprint:sha-256\s+([^\r\n]+)\r?$/gim)];
  if (found.length !== 1) return "";
  const value = String(found[0]?.[1] || "").trim().toUpperCase();
  return /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value)
    ? value.replaceAll(":", "").toLowerCase()
    : "";
}

function nonce(random = randomBytes) {
  const value = Buffer.from(random(32));
  if (value.length !== 32) throw peerError("random_unavailable", "plugin peer nonce must contain 32 bytes");
  return value.toString("base64url");
}

function decodeNonce(value) {
  let decoded;
  try {
    decoded = Buffer.from(String(value || ""), "base64url");
  } catch {
    return null;
  }
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : null;
}

function bindingHash(value) {
  const decoded = decodeNonce(value);
  return decoded ? createHash("sha256").update(decoded).digest("hex") : "";
}

function capabilityObject(protocol, source, target) {
  const endpoint = (value) => ({
    plugin_id: value.plugin_id,
    plugin_version: value.plugin_version,
    action: value.action,
    role: value.role,
  });
  return {
    protocol: {
      id: protocol.id,
      abi: protocol.abi,
      transport: protocol.transport,
      approval: protocol.approval,
    },
    source: endpoint(source),
    target: endpoint(target),
  };
}

function capabilityDigest(protocol, source, target) {
  return createHash("sha256")
    .update(JSON.stringify(capabilityObject(protocol, source, target)), "utf8")
    .digest("hex");
}

function canonicalOpaque(value, name = "plugin") {
  const normalize = (item, depth = 0) => {
    if (depth > 32) throw peerError("invalid_input", `${name} input is too deeply nested`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => normalize(child, depth + 1));
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key], depth + 1)]),
      );
    }
    throw peerError("invalid_input", `invalid ${name} input`);
  };
  const normalized = normalize(value);
  if (Buffer.byteLength(JSON.stringify(normalized)) > OPAQUE_INPUT_MAX) {
    throw peerError("invalid_input", `${name} plugin input exceeds 8 KiB`);
  }
  return normalized;
}

function cleanProtocol(value) {
  const protocol = {
    id: String(value?.id || "").trim(),
    abi: String(value?.abi || "").trim(),
    transport: String(value?.transport || "").trim(),
    approval: String(value?.approval || "").trim(),
  };
  if (
    !protocol.id ||
    protocol.abi !== "fleet.plugin.peer.v1" ||
    protocol.transport !== "direct_ordered" ||
    protocol.approval !== "both_once"
  ) {
    throw peerError("unsupported_plugin", "invalid plugin peer protocol declaration");
  }
  return protocol;
}

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cleanEndpoint(value, side) {
  const name = String(value?.name || "").trim();
  if (name && (name.length > 128 || hasAsciiControl(name))) {
    throw peerError("invalid_endpoint", `invalid ${side} endpoint name`);
  }
  const endpoint = {
    kind: String(value?.kind || ""),
    id: String(value?.id || value?.device_id || "").trim(),
    ...(name ? { name } : {}),
    plugin_id: String(value?.plugin_id || "").trim(),
    plugin_version: String(value?.plugin_version || "").trim(),
    action: String(value?.action || "").trim(),
    role: String(value?.role || "").trim(),
    input: canonicalOpaque(value?.input ?? null, side),
  };
  if (
    (endpoint.kind !== "tool" && endpoint.kind !== "device") ||
    !endpoint.id ||
    !endpoint.plugin_id ||
    !endpoint.plugin_version ||
    !endpoint.action ||
    endpoint.role !== side
  ) {
    throw peerError("invalid_endpoint", `invalid ${side} plugin endpoint`);
  }
  return endpoint;
}

function publicEndpoint(value) {
  const { input: _input, ...endpoint } = value;
  return endpoint;
}

function pluginPeerContext(value) {
  return {
    kind: value.kind,
    id: value.id,
    ...(value.name ? { name: value.name } : {}),
  };
}

function sameEndpoint(left, right) {
  return ["kind", "id", "plugin_id", "plugin_version", "action", "role"].every(
    (key) => left?.[key] === right?.[key],
  );
}

function sameProtocol(left, right) {
  return ["id", "abi", "transport", "approval"].every((key) => left?.[key] === right?.[key]);
}

function iceServers(urls) {
  return (Array.isArray(urls) ? urls : [])
    .filter((value) => /^stuns?:[^\s]{1,512}$/i.test(String(value)))
    .slice(0, 4)
    .map((value) => ({ urls: value }));
}

function waitOpen(channel, peer, signal, timeoutMs = CONNECT_TIMEOUT_MS) {
  if (channel?.readyState === "open") return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(channel);
    };
    const aborted = () => finish(peerError("cancelled", "plugin peer cancelled"));
    const timer = setTimeout(() => finish(peerError("direct_unavailable", "direct channel timed out")), timeoutMs);
    const previousOpen = channel.onopen;
    const previousError = channel.onerror;
    const previousClose = channel.onclose;
    channel.onopen = (...args) => {
      previousOpen?.(...args);
      finish();
    };
    channel.onerror = (...args) => {
      previousError?.(...args);
      finish(peerError("direct_unavailable", "direct channel failed"));
    };
    channel.onclose = (...args) => {
      previousClose?.(...args);
      finish(peerError("direct_unavailable", "direct channel closed"));
    };
    peer.connectionStateChange?.subscribe((state) => {
      if (["failed", "disconnected", "closed"].includes(state)) {
        finish(peerError("direct_unavailable", `direct peer ${state}`));
      }
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function waitDataChannel(peer, signal, timeoutMs = CONNECT_TIMEOUT_MS, prepare = (channel) => channel) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, channel) => {
      if (settled) {
        channel?.close?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(channel);
    };
    const aborted = () => finish(peerError("cancelled", "plugin peer cancelled"));
    const timer = setTimeout(() => finish(peerError("direct_unavailable", "peer did not open a channel")), timeoutMs);
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== CHANNEL_LABEL) {
        channel.close?.();
        return;
      }
      if (settled) {
        channel.close?.();
        return;
      }
      try {
        finish(null, prepare(channel));
      } catch (error) {
        channel.close?.();
        finish(error);
      }
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function messageValue(raw) {
  const value = raw?.data ?? raw;
  if (typeof value === "string") return { text: true, value, bytes: Buffer.byteLength(value) };
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { text: false, value: data, bytes: data.length };
}

function createChannelInbox(channel, signal) {
  const queue = [];
  const waiters = [];
  let bytes = 0;
  let failure;
  const fail = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    queue.length = 0;
    bytes = 0;
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };
  const push = (raw) => {
    if (failure) return;
    let item;
    try {
      item = messageValue(raw);
    } catch {
      fail(peerError("peer_protocol", "invalid channel message"));
      return;
    }
    const limit = item.text ? CONTROL_MAX : DATA_MAX;
    if (item.bytes > limit || queue.length >= INBOX_MAX || bytes + item.bytes > INBOX_BYTES_MAX) {
      fail(peerError("backpressure", "plugin peer inbox exceeded its hard limit"));
      channel.close?.();
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(item);
    else {
      queue.push(item);
      bytes += item.bytes;
    }
  };
  const aborted = () => fail(peerError("cancelled", "plugin peer cancelled"));
  channel.onmessage = push;
  channel.onclose = () => fail(peerError("interrupted", "plugin peer channel closed"));
  channel.onerror = () => fail(peerError("direct_unavailable", "plugin peer channel failed"));
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  return {
    next() {
      if (failure) return Promise.reject(failure);
      if (queue.length) {
        const item = queue.shift();
        bytes -= item.bytes;
        return Promise.resolve(item);
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    dispose(error = peerError("interrupted", "plugin peer inbox disposed")) {
      signal?.removeEventListener("abort", aborted);
      fail(error);
    },
  };
}

function controlEnvelope(type, sessionId, roundId, body = {}) {
  return JSON.stringify({
    v: 1,
    type,
    id: randomUUID(),
    t: Date.now(),
    body: { session_id: sessionId, round_id: roundId, ...body },
  });
}

function parseControl(item, sessionId, roundId) {
  if (!item.text || item.bytes > CONTROL_MAX) throw peerError("peer_protocol", "expected bounded text control");
  let value;
  try {
    value = JSON.parse(item.value);
  } catch {
    throw peerError("peer_protocol", "invalid peer control JSON");
  }
  if (
    value?.v !== 1 ||
    typeof value.id !== "string" ||
    !Number.isFinite(value.t) ||
    value.body?.session_id !== sessionId ||
    value.body?.round_id !== roundId
  ) {
    throw peerError("peer_protocol", "peer control belongs to another round");
  }
  return value;
}

async function waitBuffered(channel, signal, nextBytes = 0) {
  while (Number(channel.bufferedAmount || 0) + nextBytes > SEND_WINDOW) {
    if (signal?.aborted) throw peerError("cancelled", "plugin peer cancelled");
    if (["closing", "closed"].includes(channel.readyState)) {
      throw peerError("interrupted", "plugin peer channel closed");
    }
    await delay(5, signal);
  }
}

async function drainChannel(channel, signal, timeoutMs = HALF_CLOSE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Number(channel.bufferedAmount || 0) > 0) {
    if (signal?.aborted) throw peerError("cancelled", "plugin peer cancelled");
    if (["closing", "closed"].includes(channel.readyState)) {
      throw peerError("interrupted", "plugin peer channel closed before buffered DATA drained");
    }
    if (Date.now() >= deadline) throw peerError("direct_unavailable", "plugin peer DATA drain timed out");
    await delay(5, signal);
  }
}

function sendChannel(channel, value) {
  try {
    channel.send(value);
  } catch (error) {
    throw peerError("direct_unavailable", `plugin peer channel send failed: ${error?.message || error}`);
  }
}

function sessionValue(value) {
  return value?.session ?? value?.peer_session ?? value;
}

function roundID(session) {
  return String(session?.round?.id || "");
}

function localSignalRole(session, side) {
  if (session?.signal_sides?.initiator === side) return "initiator";
  if (session?.signal_sides?.responder === side) return "responder";
  throw peerError("invalid_response", "Hub did not assign an explicit signaling side");
}

function normalizeDelivery(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.delivery_id !== "string" ||
    !value.delivery_id ||
    typeof value.type !== "string" ||
    !value.type ||
    !value.body ||
    typeof value.body !== "object" ||
    Array.isArray(value.body)
  ) {
    return null;
  }
  return { deliveryId: value.delivery_id, type: value.type, body: value.body };
}

export function createPluginPeerManager({
  hubPost,
  token,
  operatorId,
  verifyTokenV1,
  verifyFleetStatement,
  launchPlugin,
  runtime = {},
}) {
  const api = createPluginPeerAPI(hubPost);
  const rows = new Map();
  const getPeerConnection = runtime.loadPeerConnection || loadPeerConnection;
  const random = runtime.randomBytes || randomBytes;
  const now = runtime.now || Date.now;
  const sleep = runtime.delay || delay;
  const maxRounds = runtime.maxRounds || MAX_ROUNDS;
  const totalMs = runtime.totalMs || SESSION_TOTAL_MS;
  const cancelMs = runtime.cancelMs || CANCEL_TIMEOUT_MS;
  const connectMs = runtime.connectMs ?? CONNECT_TIMEOUT_MS;
  const terminalCacheMs = runtime.terminalCacheMs ?? 60_000;
  let claimsPromise;

  async function claims() {
    claimsPromise ||= verifyTokenV1(token);
    return claimsPromise;
  }

  async function remoteStatus(sessionId, { signal } = {}) {
    return sessionValue(await api.status({ session_id: sessionId }, { signal }));
  }

  async function status(sessionId, { signal } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) throw peerError("invalid_session", "session_id required");
    if (signal?.aborted) throw peerError("cancelled", "plugin peer request cancelled");
    const remote = await remoteStatus(id, { signal });
    const local = rows.get(id);
    return local ? { ...remote, local: localStatus(local) } : remote;
  }

  function localStatus(row) {
    return {
      session_id: row.sessionId,
      round_id: row.roundId,
      phase: row.phase,
      direct_only: true,
      ...(row.error ? { error: row.error, failure_code: row.failureCode } : {}),
      ...(row.result !== undefined ? { result: row.result } : {}),
    };
  }

  async function poll(row, signal = row.io.signal) {
    const submitted = [...row.ackPending];
    const result = await api.poll({
      session_id: row.sessionId,
      ...(submitted.length ? { ack_delivery_ids: submitted } : {}),
    }, { signal });
    for (const deliveryId of submitted) {
      row.ackPending.delete(deliveryId);
      row.acked.add(deliveryId);
      row.pending.delete(deliveryId);
    }
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const raw of items) {
      const item = normalizeDelivery(raw);
      if (!item) throw peerError("invalid_response", "Hub returned a malformed plugin peer delivery");
      if (!DELIVERY_TYPES.has(item.type)) {
        throw peerError("invalid_response", `Hub returned unknown plugin peer delivery ${item.type}`);
      }
      if (row.acked.has(item.deliveryId)) continue;
      if (row.applied.has(item.deliveryId)) {
        row.ackPending.add(item.deliveryId);
        continue;
      }
      if (!row.pending.has(item.deliveryId)) row.pending.set(item.deliveryId, item);
    }
  }

  async function ackDelivery(row, item, signal = row.io.signal) {
    row.applied.add(item.deliveryId);
    row.ackPending.add(item.deliveryId);
    let lastError;
    for (let attempt = 0; attempt < EVENT_RETRIES; attempt += 1) {
      try {
        await poll(row, signal);
        if (row.acked.has(item.deliveryId)) return;
      } catch (error) {
        if (error?.code === "invalid_response") throw error;
        lastError = error;
      }
      await sleep(Math.min(1000, 100 * 2 ** attempt), signal);
    }
    throw lastError || peerError("ack_unconfirmed", "Hub did not confirm plugin peer delivery ACK");
  }

  function sessionStateError(remote, expectedRound, { acceptInterrupted = false } = {}) {
    const phase = String(remote?.phase || "");
    const currentRound = roundID(remote);
    if (phase === "cancelled") return peerError("cancelled", "plugin peer cancelled by Hub");
    if (phase === "failed" || phase === "expired") {
      return peerError(phase, `plugin peer ${phase}: ${remote?.failure_code || "unknown failure"}`);
    }
    if (phase === "completed") {
      return peerError("peer_protocol", "Hub completed before the ordered channel half-close");
    }
    if (phase === "interrupted") {
      if (acceptInterrupted && (!currentRound || currentRound === expectedRound)) return null;
      return peerError("interrupted", "Hub interrupted the current plugin peer round");
    }
    if (currentRound && currentRound !== expectedRound) {
      return peerError("interrupted", "Hub advanced the plugin peer round");
    }
    return null;
  }

  async function consumeSessionUpdate(row, item, expectedRound, options = {}) {
    if (item.body.session_id !== row.sessionId) {
      throw peerError("invalid_response", "Hub delivered an update for another plugin peer session");
    }
    const error = sessionStateError(sessionValue(item.body), expectedRound, options);
    await ackDelivery(row, item, options.signal);
    if (error) throw error;
  }

  async function takeDelivery(row, matcher, { expectedRound = row.roundId, acceptInterrupted = false } = {}) {
    while (now() < row.deadline) {
      for (const item of row.pending.values()) {
        if (item.type === "peer_session_update") {
          await consumeSessionUpdate(row, item, expectedRound, { acceptInterrupted });
          continue;
        }
        const matched = matcher(item);
        if (!matched) continue;
        if (matched === DROP) {
          await ackDelivery(row, item);
          continue;
        }
        return { item, value: matched };
      }
      await poll(row);
      await sleep(POLL_MS, row.io.signal);
    }
    throw peerError("timeout", "plugin peer mailbox timed out");
  }

  async function waitPhase(row, wanted) {
    while (now() < row.deadline) {
      const remote = await remoteStatus(row.sessionId, { signal: row.io.signal });
      if (wanted.includes(remote.phase)) return remote;
      const stateError = sessionStateError(remote, row.roundId);
      if (stateError) throw stateError;
      await sleep(POLL_MS, row.io.signal);
    }
    throw peerError("timeout", "plugin peer status timed out");
  }

  function validatePrepare(row, item) {
    if (item.type !== "peer_session_prepare") return false;
    const body = item.body;
    if (body.session_id !== row.sessionId || body.round_id !== row.roundId || body.side !== row.role) return DROP;
    const local = body.plugin;
    const peer = body.peer;
    if (
      body.direct_only !== true ||
      body.operator_id !== operatorId ||
      typeof body.user_id !== "string" ||
      !body.user_id ||
      !sameProtocol(body.protocol, row.protocol) ||
      !sameEndpoint(
        {
          kind: row.local.kind,
          id: row.local.id,
          plugin_id: local?.id,
          plugin_version: local?.version,
          action: local?.action,
          role: local?.role,
        },
        publicEndpoint(row.local),
      ) ||
      !sameEndpoint(peer, publicEndpoint(row.peer)) ||
      body.signal_role !== row.signalRole ||
      JSON.stringify(canonicalOpaque(body.input ?? null, "Hub")) !== JSON.stringify(row.input)
    ) {
      throw peerError("invalid_response", "Hub delivered a mismatched plugin peer preparation");
    }
    return body;
  }

  async function waitPrepare(row) {
    const delivery = await takeDelivery(row, (item) => validatePrepare(row, item));
    const body = delivery.value;
    row.userId = body.user_id;
    row.signalRole = body.signal_role;
    row.stunURLs = Array.isArray(body.stun_urls) ? body.stun_urls.slice(0, 4) : [];
    row.input = canonicalOpaque(body.input ?? null, "Hub");
    await ackDelivery(row, delivery.item);
    return body;
  }

  async function waitRoundPrepare(row, expectedRound) {
    const delivery = await takeDelivery(row, (item) => {
      if (item.type !== "peer_session_round_prepare") return false;
      if (item.body.session_id !== row.sessionId || item.body.round_id !== expectedRound) return DROP;
      if (
        item.body.side !== row.role ||
        item.body.direct_only !== true ||
        item.body.round_no !== row.roundNo + 1 ||
        item.body.signal_role !== row.signalRole
      ) {
        throw peerError("invalid_response", "Hub delivered a mismatched round preparation");
      }
      return item.body;
    }, { expectedRound, acceptInterrupted: true });
    const body = delivery.value;
    row.roundId = expectedRound;
    row.roundNo = body.round_no;
    row.signalRole = body.signal_role;
    await ackDelivery(row, delivery.item);
    return body;
  }

  async function verifyTicket(row, signed, round, offer, answer) {
    const tokenClaims = await abortable(claims(), round.signal);
    if (!tokenClaims?.pub || !tokenClaims?.kid) throw peerError("ticket_rejected", "Hub token claims are incomplete");
    let ticket;
    try {
      ticket = await abortable(verifyFleetStatement({ publicSpkiB64: tokenClaims.pub, ...signed }), round.signal);
    } catch {
      throw peerError("ticket_rejected", "plugin peer ticket signature is invalid");
    }
    const exact = {
      v: 1,
      kind: "plugin_peer",
      session_id: row.sessionId,
      round_id: round.roundId,
      kid: tokenClaims.kid,
      user_id: row.userId,
      operator_id: operatorId,
      protocol: row.protocol.id,
      abi: row.protocol.abi,
      transport: row.protocol.transport,
      approval: row.protocol.approval,
      source_kind: row.source.kind,
      source_id: row.source.id,
      source_plugin_id: row.source.plugin_id,
      source_plugin_version: row.source.plugin_version,
      source_action: row.source.action,
      source_role: row.source.role,
      target_kind: row.target.kind,
      target_id: row.target.id,
      target_plugin_id: row.target.plugin_id,
      target_plugin_version: row.target.plugin_version,
      target_action: row.target.action,
      target_role: row.target.role,
      initiator_kind: row[row.signalRole === "initiator" ? "local" : "peer"].kind,
      initiator_id: row[row.signalRole === "initiator" ? "local" : "peer"].id,
      responder_kind: row[row.signalRole === "responder" ? "local" : "peer"].kind,
      responder_id: row[row.signalRole === "responder" ? "local" : "peer"].id,
      capability_digest: capabilityDigest(row.protocol, row.source, row.target),
      offer_fp: peerFingerprint(offer),
      answer_fp: peerFingerprint(answer),
      direct_only: true,
    };
    if (!ticket || Object.entries(exact).some(([key, value]) => ticket[key] !== value)) {
      throw peerError("ticket_rejected", "plugin peer ticket does not match this round");
    }
    const localSessionKey = row.role === "source" ? "source_session_binding_hash" : "target_session_binding_hash";
    const localRoundKey = row.role === "source" ? "source_round_binding_hash" : "target_round_binding_hash";
    const peerSessionKey = row.role === "source" ? "target_session_binding_hash" : "source_session_binding_hash";
    const peerRoundKey = row.role === "source" ? "target_round_binding_hash" : "source_round_binding_hash";
    if (
      ticket[localSessionKey] !== bindingHash(row.sessionNonce) ||
      ticket[localRoundKey] !== bindingHash(round.nonce) ||
      !/^[0-9a-f]{64}$/.test(ticket[peerSessionKey] || "") ||
      !/^[0-9a-f]{64}$/.test(ticket[peerRoundKey] || "") ||
      !Number.isSafeInteger(ticket.iat) ||
      !Number.isSafeInteger(ticket.exp) ||
      ticket.iat <= 0 ||
      ticket.iat > now() + 30_000 ||
      ticket.exp <= now() ||
      ticket.exp <= ticket.iat ||
      ticket.exp - ticket.iat > 60_000
    ) {
      throw peerError("ticket_rejected", "plugin peer ticket bindings or lifetime are invalid");
    }
    return { peerSessionHash: ticket[peerSessionKey], peerRoundHash: ticket[peerRoundKey] };
  }

  async function waitTicket(row, round, offer, answer) {
    const delivery = await takeDelivery(row, (value) => {
      if (value.type !== "peer_session_ticket") return false;
      if (value.body.session_id !== row.sessionId || value.body.round_id !== round.roundId) return DROP;
      return value.body;
    }, { expectedRound: round.roundId });
    const bindings = await verifyTicket(row, delivery.value.statement, round, offer, answer);
    await ackDelivery(row, delivery.item);
    return bindings;
  }

  async function negotiate(row, round) {
    const RTCPeerConnection = await abortable(getPeerConnection(), round.signal);
    const pc = new RTCPeerConnection({ iceServers: iceServers(row.stunURLs) });
    row.peerConnection = pc;
    row.peerConnectionRound = round;
    if (row.signalRole === "initiator") {
      const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
      const inbox = createChannelInbox(channel, round.signal);
      try {
        const offerDescription = await abortable(pc.createOffer(), round.signal);
        await abortable(pc.setLocalDescription(offerDescription), round.signal);
        const offer = pc.localDescription?.sdp || offerDescription.sdp;
        if (!peerFingerprint(offer)) throw peerError("direct_unavailable", "offer fingerprint missing");
        await api.signal({
          session_id: row.sessionId,
          round_id: round.roundId,
          signal_role: row.signalRole,
          signal: { kind: "offer", seq: 0, sdp: offer },
        }, { signal: round.signal });
        const answerDelivery = await takeDelivery(row, (item) => {
          if (item.type !== "peer_session_signal") return false;
          if (item.body.session_id !== row.sessionId || item.body.round_id !== round.roundId) return DROP;
          return item.body.from === "responder" && item.body.signal?.kind === "answer" ? item.body : DROP;
        }, { expectedRound: round.roundId });
        const answer = answerDelivery.value.signal.sdp;
        await abortable(pc.setRemoteDescription({ type: "answer", sdp: answer }), round.signal);
        await ackDelivery(row, answerDelivery.item);
        const bindings = await waitTicket(row, round, offer, answer);
        await raceHub(row, round, waitOpen(channel, pc, round.signal));
        return { pc, channel, inbox, bindings };
      } catch (error) {
        inbox.dispose();
        throw error;
      }
    }
    const offerDelivery = await takeDelivery(row, (item) => {
      if (item.type !== "peer_session_signal") return false;
      if (item.body.session_id !== row.sessionId || item.body.round_id !== round.roundId) return DROP;
      return item.body.from === "initiator" && item.body.signal?.kind === "offer" ? item.body : DROP;
    }, { expectedRound: round.roundId });
    const channelPromise = waitDataChannel(pc, round.signal, CONNECT_TIMEOUT_MS, (channel) => ({
      channel,
      inbox: createChannelInbox(channel, round.signal),
    }));
    void channelPromise.catch(() => {});
    const offer = offerDelivery.value.signal.sdp;
    await abortable(pc.setRemoteDescription({ type: "offer", sdp: offer }), round.signal);
    await ackDelivery(row, offerDelivery.item);
    const answerDescription = await abortable(pc.createAnswer(), round.signal);
    await abortable(pc.setLocalDescription(answerDescription), round.signal);
    const answer = pc.localDescription?.sdp || answerDescription.sdp;
    if (!peerFingerprint(answer)) throw peerError("direct_unavailable", "answer fingerprint missing");
    await api.signal({
      session_id: row.sessionId,
      round_id: round.roundId,
      signal_role: row.signalRole,
      signal: { kind: "answer", seq: 0, sdp: answer },
    }, { signal: round.signal });
    const bindings = await waitTicket(row, round, offer, answer);
    const prepared = await raceHub(row, round, channelPromise);
    try {
      await raceHub(row, round, waitOpen(prepared.channel, pc, round.signal));
      return { pc, ...prepared, bindings };
    } catch (error) {
      prepared.inbox.dispose();
      throw error;
    }
  }

  async function bindingHandshake(row, round, channel, inbox, bindings) {
    return raceHub(row, round, (async () => {
      const deadline = Math.min(row.deadline, now() + connectMs);
      const next = () => {
        const remaining = deadline - now();
        if (remaining <= 0) throw peerError("direct_unavailable", "plugin peer handshake timed out");
        return bounded(inbox.next(), remaining, "direct_unavailable", "plugin peer handshake timed out");
      };
      sendChannel(channel, controlEnvelope("peer_bindings", row.sessionId, round.roundId, {
        session_binding: row.sessionNonce,
        round_binding: round.nonce,
      }));
      for (;;) {
        const message = parseControl(await next(), row.sessionId, round.roundId);
        if (message.type !== "peer_bindings") continue;
        if (
          bindingHash(message.body.session_binding) !== bindings.peerSessionHash ||
          bindingHash(message.body.round_binding) !== bindings.peerRoundHash
        ) {
          throw peerError("peer_protocol", "peer nonce does not match signed ticket");
        }
        break;
      }
      sendChannel(channel, controlEnvelope("peer_ready", row.sessionId, round.roundId));
      for (;;) {
        const message = parseControl(await next(), row.sessionId, round.roundId);
        if (message.type === "peer_ready") return inbox;
        if (message.type === "peer_error") {
          throw peerError(message.body?.code || "peer_error", message.body?.error || "peer failed");
        }
        if (message.type === "peer_cancel") throw peerError("cancelled", "peer cancelled");
      }
    })());
  }

  function nextPlugin(plugin, signal) {
    return plugin.next(signal).then(
      (value) => ({ side: "plugin", value }),
      (error) => ({ side: "plugin", error }),
    );
  }

  function nextPeer(inbox) {
    return inbox.next().then(
      (value) => ({ side: "peer", value }),
      (error) => ({ side: "peer", error }),
    );
  }

  async function watchHub(row, round, signal = round.signal) {
    let lastError;
    while (now() < row.deadline) {
      try {
        await poll(row, signal);
        for (const item of row.pending.values()) {
          if (item.type !== "peer_session_update") continue;
          await consumeSessionUpdate(row, item, round.roundId, { signal });
        }
        const remote = await remoteStatus(row.sessionId, { signal });
        const stateError = sessionStateError(remote, round.roundId);
        if (stateError) throw stateError;
        lastError = undefined;
      } catch (error) {
        if (["interrupted", "cancelled", "failed", "expired", "peer_protocol", "invalid_response"].includes(String(error?.code || ""))) {
          throw error;
        }
        lastError = error;
      }
      await sleep(POLL_MS, signal);
    }
    throw lastError || peerError("timeout", "plugin peer Hub watcher timed out");
  }

  async function raceHub(row, round, operation) {
    const stop = new AbortController();
    const abort = () => stop.abort();
    round.signal?.addEventListener("abort", abort, { once: true });
    if (round.signal?.aborted) stop.abort();
    const watcher = watchHub(row, round, stop.signal);
    void watcher.catch(() => {});
    try {
      return await Promise.race([operation, watcher]);
    } finally {
      stop.abort();
      round.signal?.removeEventListener("abort", abort);
    }
  }

  function nextHub(row, round) {
    return watchHub(row, round).then(
      (value) => ({ side: "hub", value }),
      (error) => ({ side: "hub", error }),
    );
  }

  async function cancelPluginOnce(row, plugin) {
    if (!plugin || row.cancelledPlugins.has(plugin)) return;
    row.cancelledPlugins.add(plugin);
    const gracefulMs = Math.max(1, cancelMs - Math.min(1_000, Math.floor(cancelMs / 4)));
    let graceful;
    try {
      // Invoke synchronously so launchPluginPeerProcess installs its graceful
      // stopping promise before row.abort can trigger the force-abort listener.
      graceful = plugin.cancel?.();
    } catch {
      graceful = undefined;
    }
    await bounded(
      graceful,
      gracefulMs,
      "cancel_timeout",
      "plugin did not finish graceful cancellation",
    ).catch(() => {});
    let forced;
    try {
      forced = plugin.abort?.();
    } catch {
      forced = undefined;
    }
    await bounded(
      forced,
      Math.max(1, cancelMs - gracefulMs),
      "cancel_timeout",
      "plugin process tree did not stop",
    ).catch(() => {});
  }

  async function bridge(row, round, plugin, channel, inbox) {
    let pluginNext = nextPlugin(plugin, round.signal);
    let peerNext = nextPeer(inbox);
    const hubNext = nextHub(row, round);
    let halfClose = null;
    let localDone = false;
    let remoteDone = false;
    let result;
    for (;;) {
      const choices = [peerNext, hubNext];
      if (pluginNext) choices.push(pluginNext);
      if (halfClose) choices.push(halfClose);
      const winner = await Promise.race(choices);
      if (winner.error) {
        if (winner.error?.code === "cancelled" && !row.timeout.signal.aborted) {
          await cancelPluginOnce(row, plugin);
        }
        throw winner.error;
      }
      if (winner.side === "half_close") {
        throw peerError("direct_unavailable", "peer did not finish the ordered channel half-close");
      }
      if (winner.side === "plugin") {
        const record = winner.value;
        if (record.kind === "data") {
          if (localDone) throw peerError("plugin_protocol", "plugin emitted DATA after complete");
          if (record.data.length > DATA_MAX) throw peerError("plugin_protocol", "plugin DATA exceeds FLPP limit");
          await waitBuffered(channel, round.signal, record.data.length);
          sendChannel(channel, record.data);
          pluginNext = nextPlugin(plugin, round.signal);
          continue;
        }
        const control = record.control;
        if (control.status === "complete") {
          localDone = true;
          result = control.result;
          pluginNext = null;
          await drainChannel(channel, round.signal);
          sendChannel(channel, controlEnvelope("peer_done", row.sessionId, round.roundId));
          await drainChannel(channel, round.signal);
          halfClose ||= sleep(HALF_CLOSE_TIMEOUT_MS, round.signal).then(
            () => ({ side: "half_close" }),
            (error) => ({ side: "half_close", error }),
          );
          if (remoteDone) return result;
          continue;
        }
        if (control.status === "canceled") throw peerError("cancelled", "plugin cancelled");
        if (control.status === "error") {
          throw peerError(control.code || "plugin_failed", control.error || "plugin failed");
        }
        throw peerError("plugin_protocol", `unexpected plugin status ${control.status}`);
      }
      if (winner.value.text) {
        const control = parseControl(winner.value, row.sessionId, round.roundId);
        if (control.type === "peer_done") {
          remoteDone = true;
          halfClose ||= sleep(HALF_CLOSE_TIMEOUT_MS, round.signal).then(
            () => ({ side: "half_close" }),
            (error) => ({ side: "half_close", error }),
          );
          if (localDone) return result;
          peerNext = nextPeer(inbox);
          continue;
        }
        if (control.type === "peer_cancel") {
          await cancelPluginOnce(row, plugin);
          throw peerError("cancelled", "peer cancelled");
        }
        if (control.type === "peer_error") {
          throw peerError(control.body?.code || "peer_error", control.body?.error || "peer failed");
        }
        throw peerError("peer_protocol", `unexpected peer control ${control.type}`);
      }
      if (remoteDone) throw peerError("peer_protocol", "peer emitted DATA after peer_done");
      await plugin.writeData(winner.value.value);
      peerNext = nextPeer(inbox);
    }
  }

  function eventReceipt(event, remote, row, round) {
    if (!remote || (roundID(remote) !== round.roundId && event !== "interrupt")) return false;
    if (event === "active") return remote.endpoint_events?.[row.role]?.active === true;
    if (event === "complete") return remote.endpoint_events?.[row.role]?.completed === true;
    if (event === "cancel") return remote.phase === "cancelled";
    if (event === "fail") return remote.phase === "failed";
    if (event === "interrupt") return Boolean(roundID(remote) && roundID(remote) !== round.roundId);
    return false;
  }

  async function reportEvent(row, round, event, extra = {}, eventSignal = row.io.signal) {
    let cleanupTimer;
    let cleanupController;
    let signal = eventSignal;
    if (!signal) {
      cleanupController = new AbortController();
      cleanupTimer = setTimeout(
        () => cleanupController.abort(peerError("event_timeout", `plugin peer ${event} report timed out`)),
        cancelMs,
      );
      cleanupTimer.unref?.();
      signal = cleanupController.signal;
    }
    let lastError;
    try {
      for (let attempt = 0; attempt < EVENT_RETRIES; attempt += 1) {
        try {
          const remote = sessionValue(await api.event({
            session_id: row.sessionId,
            round_id: round.roundId,
            event,
            ...extra,
          }, { signal }));
          if (eventReceipt(event, remote, row, round)) return remote;
        } catch (error) {
          lastError = error;
        }
        try {
          const remote = await remoteStatus(row.sessionId, { signal });
          if (eventReceipt(event, remote, row, round)) return remote;
        } catch (error) {
          lastError = error;
        }
        await sleep(Math.min(1000, 100 * 2 ** attempt), signal);
      }
      throw lastError || peerError("event_unconfirmed", `Hub did not confirm ${event}`);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }

  async function runRound(row, round) {
    const controller = new AbortController();
    round.signal = controller.signal;
    const abort = () => controller.abort();
    row.abort.signal.addEventListener("abort", abort, { once: true });
    row.timeout.signal.addEventListener("abort", abort, { once: true });
    let plugin;
    try {
      plugin = await launchPlugin({
        pluginId: row.local.plugin_id,
        protocol: row.protocol.id,
        role: row.role,
        input: row.input,
        peer: pluginPeerContext(row.peer),
        signal: controller.signal,
      });
      row.pluginProcess = plugin;
      await api.authorize({
        session_id: row.sessionId,
        round_id: round.roundId,
        side: row.role,
        session_binding: row.sessionNonce,
        round_binding: round.nonce,
      }, { signal: controller.signal });
      await waitPhase(row, ["signaling", "connecting"]);
      const negotiated = await negotiate(row, round);
      row.channel = negotiated.channel;
      row.activeRound = round;
      const inbox = await bindingHandshake(row, round, negotiated.channel, negotiated.inbox, negotiated.bindings);
      try {
        await reportEvent(row, round, "active", {}, controller.signal);
        round.active = true;
        row.phase = "active";
        const result = await bridge(row, round, plugin, negotiated.channel, inbox);
        await reportEvent(row, round, "complete", {}, controller.signal);
        return result;
      } finally {
        inbox.dispose();
      }
    } finally {
      row.abort.signal.removeEventListener("abort", abort);
      row.timeout.signal.removeEventListener("abort", abort);
      controller.abort();
      await bounded(
        Promise.resolve().then(() => plugin?.abort?.()),
        cancelMs,
        "cancel_timeout",
        "plugin process tree did not stop",
      ).catch(() => {});
      if (row.pluginProcess === plugin) row.pluginProcess = null;
      if (row.activeRound === round) {
        row.activeRound = null;
        row.channel = null;
      }
      if (row.peerConnectionRound === round) {
        await bounded(
          Promise.resolve().then(() => row.peerConnection?.close?.()),
          cancelMs,
          "cancel_timeout",
          "direct peer did not close",
        ).catch(() => {});
        row.peerConnection = null;
        row.peerConnectionRound = null;
      }
    }
  }

  async function run(row) {
    try {
      await waitPrepare(row);
      for (let attempt = 0; attempt < maxRounds; attempt += 1) {
        const round = { roundId: row.roundId, nonce: nonce(random), active: false };
        try {
          row.phase = "preparing";
          row.result = await runRound(row, round);
          await waitPhase(row, ["completed"]);
          row.phase = "completed";
          return;
        } catch (error) {
          const interrupted = round.active && ["interrupted", "direct_unavailable"].includes(String(error?.code || ""));
          if (!interrupted || attempt + 1 >= maxRounds || now() >= row.deadline) throw error;
          row.phase = "interrupted";
          if (row.reportedInterrupts.has(round.roundId)) {
            throw peerError("stale_round", "plugin peer round was interrupted twice");
          }
          row.reportedInterrupts.add(round.roundId);
          const remote = await reportEvent(row, round, "interrupt");
          const next = roundID(remote);
          if (!next || next === round.roundId) throw peerError("invalid_response", "Hub did not allocate a fresh round");
          await waitRoundPrepare(row, next);
        }
      }
    } catch (error) {
      const locallyStopped = row.timeout.signal.aborted;
      const cancelled = !locallyStopped && (row.abort.signal.aborted || error?.code === "cancelled");
      row.phase = cancelled ? "cancelled" : "failed";
      row.error = locallyStopped
        ? row.localFailureCode === "LOCAL_SHUTDOWN"
          ? "plugin peer runtime shut down"
          : "plugin peer session timed out"
        : error?.message || String(error);
      row.failureCode = locallyStopped
        ? row.localFailureCode || "TIMEOUT"
        : String(error?.code || (cancelled ? "CANCELLED" : "PEER_FAILED")).toUpperCase();
      if (cancelled && !row.cancelEventSent) {
        const round = { roundId: row.roundId };
        await reportEvent(row, round, "cancel", {}, null).then(
          () => { row.cancelEventSent = true; },
          () => {},
        );
      } else if (!cancelled) {
        const round = { roundId: row.roundId };
        await reportEvent(row, round, "fail", { failure_code: row.failureCode }, null).catch(() => {});
      }
    } finally {
      clearTimeout(row.deadlineTimer);
    }
  }

  async function start(config, { signal } = {}) {
    if (signal?.aborted) throw peerError("cancelled", "plugin peer request cancelled");
    const protocol = cleanProtocol(config?.protocol);
    const source = cleanEndpoint(config?.source, "source");
    const target = cleanEndpoint(config?.target, "target");
    if (source.kind === target.kind && source.id === target.id) {
      throw peerError("invalid_endpoint", "two different peer endpoints are required");
    }
    if (source.kind === "tool" && target.kind === "tool") {
      throw peerError("unsupported_pair", "two Tool endpoints are unsupported");
    }
    const initiator = config?.initiator === "target" ? "target" : "source";
    const local = source.kind === "tool" ? source : target.kind === "tool" ? target : null;
    const requestedSessionId = sessionUUID(config?.session_id);
    const createRequest = {
      session_id: requestedSessionId,
      protocol_id: protocol.id,
      initiator,
      source,
      target,
    };
    let created;
    let createError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        created = await api.create(createRequest, { signal });
        break;
      } catch (error) {
        createError = error;
        if (signal?.aborted) throw peerError("cancelled", "plugin peer request cancelled");
        if (attempt < 2) await sleep(100 * 2 ** attempt, signal);
      }
    }
    if (!created) throw createError || peerError("invalid_response", "Hub did not create a plugin peer session");
    const remote = sessionValue(created);
    const sessionId = String(remote?.session_id || "");
    const initialRound = roundID(remote);
    if (sessionId !== requestedSessionId || !initialRound || !sameProtocol(remote.protocol, protocol)) {
      throw peerError("invalid_response", "Hub did not return the requested session and round");
    }
    if (!local) return remote;
    const role = local === source ? "source" : "target";
    const row = {
      sessionId,
      roundId: initialRound,
      roundNo: Number(remote?.round?.no || 1),
      role,
      signalRole: localSignalRole(remote, role),
      source,
      target,
      local,
      peer: role === "source" ? target : source,
      protocol,
      input: local.input,
      userId: "",
      stunURLs: [],
      sessionNonce: nonce(random),
      abort: new AbortController(),
      timeout: new AbortController(),
      io: new AbortController(),
      localFailureCode: "",
      phase: remote.phase || "waiting_approval",
      result: undefined,
      error: "",
      failureCode: "",
      deadline: now() + totalMs,
      pending: new Map(),
      applied: new Set(),
      acked: new Set(),
      ackPending: new Set(),
      reportedInterrupts: new Set(),
      cancelledPlugins: new WeakSet(),
      cancelEventSent: false,
      cancelPromise: null,
      pluginProcess: null,
      peerConnection: null,
      peerConnectionRound: null,
      channel: null,
      activeRound: null,
      done: null,
      deadlineTimer: null,
    };
    const abortIO = () => row.io.abort(peerError("cancelled", "plugin peer cancelled"));
    const timeoutIO = () => row.io.abort(peerError("timeout", "plugin peer session timed out"));
    row.abort.signal.addEventListener("abort", abortIO, { once: true });
    row.timeout.signal.addEventListener("abort", timeoutIO, { once: true });
    row.deadlineTimer = setTimeout(() => {
      row.localFailureCode = "TIMEOUT";
      row.timeout.abort();
    }, totalMs);
    row.deadlineTimer.unref?.();
    rows.set(sessionId, row);
    row.done = run(row);
    const expireTerminalRow = () => {
      const timer = setTimeout(() => {
        if (rows.get(sessionId) === row) rows.delete(sessionId);
      }, terminalCacheMs);
      timer.unref?.();
    };
    void row.done.then(expireTerminalRow, expireTerminalRow);
    return { ...remote, local: localStatus(row) };
  }

  async function wait(sessionId, { signal, onProgress } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) throw peerError("invalid_session", "session_id required");
    const row = rows.get(id);
    let lastPhase = "";
    let cancellation;
    const abort = () => {
      cancellation ||= cancel(id);
      void cancellation.catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      for (;;) {
        if (signal?.aborted) {
          await cancellation;
          throw peerError("cancelled", "plugin peer cancelled");
        }
        if (row?.done && TERMINAL_PHASES.has(row.phase)) await row.done;
        let current;
        try {
          current = await status(id, { signal });
        } catch (error) {
          if (!signal?.aborted) throw error;
          await cancellation;
          throw peerError("cancelled", "plugin peer cancelled");
        }
        const phase = current.local?.phase || current.phase;
        if (phase !== lastPhase) {
          lastPhase = phase;
          onProgress?.(current);
        }
        if (TERMINAL_PHASES.has(phase) || TERMINAL_PHASES.has(current.phase)) {
          if (row?.cancelPromise) await row.cancelPromise;
          if (row?.done) await row.done;
          if (signal?.aborted) throw peerError("cancelled", "plugin peer cancelled");
          const final = row ? await status(id) : current;
          if (row && rows.get(id) === row) rows.delete(id);
          return final;
        }
        try {
          await sleep(POLL_MS, signal);
        } catch (error) {
          if (!signal?.aborted) throw error;
          await cancellation;
          throw peerError("cancelled", "plugin peer cancelled");
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async function cancel(sessionId, { signal } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) throw peerError("invalid_session", "session_id required");
    if (signal?.aborted) throw peerError("cancelled", "plugin peer request cancelled");
    const row = rows.get(id);
    if (row && TERMINAL_PHASES.has(row.phase)) {
      if (row.done) await row.done;
      return status(id, { signal });
    }
    if (row?.cancelPromise) return row.cancelPromise;
    const operationController = new AbortController();
    const abortOperation = () => operationController.abort(signal?.reason || peerError("cancelled", "plugin peer request cancelled"));
    if (!row) {
      signal?.addEventListener("abort", abortOperation, { once: true });
      if (signal?.aborted) abortOperation();
    }
    const operationTimer = setTimeout(
      () => operationController.abort(peerError("cancel_timeout", "plugin peer cancellation timed out")),
      cancelMs,
    );
    operationTimer.unref?.();
    const operation = (async () => {
      try {
        let localCleanup = Promise.resolve();
        if (row) {
          row.phase = "cancelled";
          if (row.channel?.readyState === "open" && row.activeRound) {
            try {
              sendChannel(row.channel, controlEnvelope("peer_cancel", row.sessionId, row.activeRound.roundId, { code: "CANCELLED" }));
            } catch {
              // The Hub event below remains authoritative when the direct channel is already gone.
            }
          }
          const peerConnection = row.peerConnection;
          row.peerConnection = null;
          row.peerConnectionRound = null;
          const pluginCancellation = cancelPluginOnce(row, row.pluginProcess);
          row.abort.abort();
          const peerCancellation = bounded(
            Promise.resolve().then(() => peerConnection?.close?.()),
            Math.max(1, Math.floor(cancelMs / 4)),
            "cancel_timeout",
            "direct peer did not close",
          ).catch(() => {});
          localCleanup = Promise.all([pluginCancellation, peerCancellation]);
        }
        const remote = row ? null : await remoteStatus(id, { signal: operationController.signal });
        const currentRound = row?.roundId || roundID(remote);
        if (!currentRound) throw peerError("invalid_response", "Hub session has no current round");
        const reporting = row
          ? reportEvent(row, { roundId: currentRound }, "cancel", {}, operationController.signal)
          : api.event(
              { session_id: id, round_id: currentRound, event: "cancel" },
              { signal: operationController.signal },
            ).then(sessionValue);
        const [result] = await Promise.all([reporting, localCleanup]);
        if (row) row.cancelEventSent = true;
        if (row?.done) await row.done;
        return sessionValue(result);
      } finally {
        clearTimeout(operationTimer);
        if (!row) signal?.removeEventListener("abort", abortOperation);
      }
    })();
    const pending = bounded(operation, cancelMs, "cancel_timeout", "plugin peer cancellation timed out");
    if (row) row.cancelPromise = pending;
    return pending;
  }

  async function shutdown() {
    const pending = [];
    for (const row of rows.values()) {
      if (TERMINAL_PHASES.has(row.phase)) continue;
      row.localFailureCode = "LOCAL_SHUTDOWN";
      row.timeout.abort();
      pending.push(row.done);
    }
    await bounded(
      Promise.allSettled(pending),
      cancelMs,
      "shutdown_timeout",
      "plugin peer shutdown timed out",
    ).catch(() => {});
  }

  return { start, status, wait, cancel, shutdown, _rows: rows };
}

export const pluginPeerRuntimeInternals = Object.freeze({
  bindingHash,
  canonicalOpaque,
  capabilityDigest,
  capabilityObject,
  cleanProtocol,
  createChannelInbox,
  iceServers,
  normalizeDelivery,
  parseControl,
  peerFingerprint,
  pluginPeerContext,
  sessionUUID,
  waitOpen,
  CHANNEL_LABEL,
  DROP,
});
