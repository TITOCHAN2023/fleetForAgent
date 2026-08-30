import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createPluginPeerLauncher } from "./plugin-peer-plugin.mjs";
import { createPluginPeerManager, pluginPeerRuntimeInternals } from "./plugin-peer-runtime.mjs";

const ROUND1 = "815739bb-bca5-48a9-aeee-2c16bbfe11de";
const ROUND2 = "0ef1f797-f298-4f20-8248-5284858f46ef";
const OPERATOR = "tool-1";
const USER = "user-1";
const PROTOCOL = { id: "example.bytes.v1", abi: "fleet.plugin.peer.v1", transport: "direct_ordered", approval: "both_once" };
const SOURCE = { kind: "tool", id: OPERATOR, plugin_id: "example.source", plugin_version: "1.2.3", action: "send", role: "source", input: { path: "/tmp/a", chunk_size: 32768 } };
const TARGET = { kind: "device", id: "device-1", name: "target machine", plugin_id: "example.target", plugin_version: "4.5.6", action: "receive", role: "target", input: { directory: "/srv/incoming" } };
const PEER_SESSION_NONCE = Buffer.alloc(32, 0x51).toString("base64url");
const PEER_ROUND_NONCE = Buffer.alloc(32, 0x52).toString("base64url");

function sdp(byte) {
  return `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(":")}\r\n`;
}

function dcControl(type, sessionId, roundId, body = {}) {
  return JSON.stringify({ v: 1, type, id: `${type}-${roundId}`, t: Date.now(), body: { session_id: sessionId, round_id: roundId, ...body } });
}

class FakeChannel {
  constructor(hub, roundId) {
    this.hub = hub;
    this.roundId = roundId;
    this.readyState = "open";
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    if (this.readyState !== "open") throw Object.assign(new Error("closed"), { code: "direct_unavailable" });
    this.sent.push(value);
    if (typeof value === "string") {
      const control = JSON.parse(value);
      if (control.type === "peer_bindings") {
        if (this.hub.updateAt === "binding_failed") {
          this.hub.pushUpdate("failed", "REMOTE_BINDING_FAILED");
          return;
        }
        if (this.hub.silentHandshake) return;
        if (this.hub.earlyBindings) return;
        queueMicrotask(() => this.onmessage?.({ data: dcControl("peer_bindings", this.hub.sessionId, this.roundId, {
          session_binding: PEER_SESSION_NONCE,
          round_binding: PEER_ROUND_NONCE,
        }) }));
      } else if (control.type === "peer_ready") {
        queueMicrotask(() => {
          this.onmessage?.({ data: dcControl("peer_ready", this.hub.sessionId, this.roundId) });
          if (this.hub.remoteDoneBeforeLocal) {
            this.onmessage?.({ data: dcControl("peer_done", this.hub.sessionId, this.roundId) });
          }
        });
      } else if (control.type === "peer_done") {
        this.hub.localPeerDoneSent = true;
        if (this.hub.holdPeerDoneBuffer) {
          this.bufferedAmount = 64;
          return;
        }
        if (!this.hub.remoteDoneBeforeLocal) {
          queueMicrotask(() => this.onmessage?.({ data: dcControl("peer_done", this.hub.sessionId, this.roundId) }));
        }
      }
      return;
    }
    this.hub.received.push({ roundId: this.roundId, data: Buffer.from(value) });
    if (this.roundId === ROUND1 && this.hub.interruptFirstRound) {
      queueMicrotask(() => {
        this.readyState = "closed";
        this.onclose?.();
      });
      return;
    }
    this.bufferedAmount = 32;
    setTimeout(() => { this.bufferedAmount = 0; }, 10);
  }

  close() {
    this.readyState = "closed";
  }
}

class FakeHub {
  constructor({
    interruptFirstRound = true,
    badTicket = false,
    loseCreateResponse = true,
    loseFirstAckResponse = false,
    silentHandshake = false,
    earlyBindings = false,
    updateAt = "",
    cancelOnFailEvent = false,
    remoteDoneBeforeLocal = false,
    holdPeerDoneBuffer = false,
  } = {}) {
    this.interruptFirstRound = interruptFirstRound;
    this.badTicket = badTicket;
    this.loseCreateResponse = loseCreateResponse;
    this.loseFirstAckResponse = loseFirstAckResponse;
    this.silentHandshake = silentHandshake;
    this.earlyBindings = earlyBindings;
    this.updateAt = updateAt;
    this.cancelOnFailEvent = cancelOnFailEvent;
    this.remoteDoneBeforeLocal = remoteDoneBeforeLocal;
    this.holdPeerDoneBuffer = holdPeerDoneBuffer;
    this.localPeerDoneSent = false;
    this.lostAckResponse = false;
    this.roundId = ROUND1;
    this.roundNo = 1;
    this.phase = "waiting_approval";
    this.deliveries = new Map();
    this.deliverySeq = 0;
    this.received = [];
    this.channels = [];
    this.createBodies = [];
    this.events = [];
    this.endpointEvents = { source: {}, target: { active: true, completed: true } };
  }

  session() {
    return {
      session_id: this.sessionId,
      phase: this.phase,
      protocol: PROTOCOL,
      round: { id: this.roundId, no: this.roundNo },
      signal_sides: { initiator: "source", responder: "target" },
      endpoint_events: this.endpointEvents,
      ...(this.failureCode ? { failure_code: this.failureCode } : {}),
    };
  }

  enqueue(type, body) {
    const delivery_id = `ps:test:${++this.deliverySeq}`;
    this.deliveries.set(delivery_id, { delivery_id, type, body });
  }

  pushUpdate(phase, failureCode = "") {
    this.phase = phase;
    this.failureCode = failureCode;
    this.enqueue("peer_session_update", {
      session_id: this.sessionId,
      phase,
      session: this.session(),
    });
  }

  prepare() {
    this.enqueue("peer_session_prepare", {
      session_id: this.sessionId,
      round_id: this.roundId,
      side: "source",
      signal_role: "initiator",
      direct_only: true,
      operator_id: OPERATOR,
      user_id: USER,
      protocol: PROTOCOL,
      plugin: { id: SOURCE.plugin_id, version: SOURCE.plugin_version, action: SOURCE.action, role: SOURCE.role },
      peer: Object.fromEntries(Object.entries(TARGET).filter(([key]) => key !== "input")),
      input: SOURCE.input,
      stun_urls: [],
    });
  }

  ticket(offer, answer) {
    const local = this.authorized;
    const ticket = {
      v: 1,
      kind: this.badTicket ? "plugin_peer_session" : "plugin_peer",
      session_id: this.sessionId,
      round_id: this.roundId,
      kid: "kid-1",
      user_id: USER,
      operator_id: OPERATOR,
      protocol: PROTOCOL.id,
      abi: PROTOCOL.abi,
      transport: PROTOCOL.transport,
      approval: PROTOCOL.approval,
      source_kind: SOURCE.kind,
      source_id: SOURCE.id,
      source_plugin_id: SOURCE.plugin_id,
      source_plugin_version: SOURCE.plugin_version,
      source_action: SOURCE.action,
      source_role: SOURCE.role,
      target_kind: TARGET.kind,
      target_id: TARGET.id,
      target_plugin_id: TARGET.plugin_id,
      target_plugin_version: TARGET.plugin_version,
      target_action: TARGET.action,
      target_role: TARGET.role,
      initiator_kind: SOURCE.kind,
      initiator_id: SOURCE.id,
      responder_kind: TARGET.kind,
      responder_id: TARGET.id,
      capability_digest: pluginPeerRuntimeInternals.capabilityDigest(PROTOCOL, SOURCE, TARGET),
      source_session_binding_hash: pluginPeerRuntimeInternals.bindingHash(local.session_binding),
      source_round_binding_hash: pluginPeerRuntimeInternals.bindingHash(local.round_binding),
      target_session_binding_hash: pluginPeerRuntimeInternals.bindingHash(PEER_SESSION_NONCE),
      target_round_binding_hash: pluginPeerRuntimeInternals.bindingHash(PEER_ROUND_NONCE),
      offer_fp: pluginPeerRuntimeInternals.peerFingerprint(offer),
      answer_fp: pluginPeerRuntimeInternals.peerFingerprint(answer),
      direct_only: true,
      iat: Date.now() - 100,
      exp: Date.now() + 30_000,
    };
    this.enqueue("peer_session_ticket", { session_id: this.sessionId, round_id: this.roundId, statement: { ticket } });
  }

  async post(pathname, body) {
    if (pathname.endsWith("/create")) {
      this.createBodies.push(structuredClone(body));
      if (this.createBodies.length === 1) {
        this.sessionId = body.session_id;
        this.prepare();
        if (this.loseCreateResponse) throw new Error("response lost after commit");
      }
      assert.equal(body.session_id, this.sessionId);
      return { session: this.session() };
    }
    if (pathname.endsWith("/inbox/poll")) {
      for (const id of body.ack_delivery_ids || []) this.deliveries.delete(id);
      if (body.ack_delivery_ids?.length && this.loseFirstAckResponse && !this.lostAckResponse) {
        this.lostAckResponse = true;
        throw new Error("ACK response lost after commit");
      }
      return { items: [...this.deliveries.values()].map((value) => structuredClone(value)) };
    }
    if (pathname.endsWith("/status")) return { session: this.session() };
    if (pathname.endsWith("/authorize")) {
      this.authorized = structuredClone(body);
      if (this.updateAt === "authorize_cancelled_status_only") {
        this.phase = "cancelled";
        return { session: this.session() };
      }
      if (this.updateAt === "authorize_interrupted") {
        this.pushUpdate("interrupted");
        return { session: this.session() };
      }
      this.phase = "signaling";
      return { session: this.session() };
    }
    if (pathname.endsWith("/signal")) {
      if (this.updateAt === "signal_failed") {
        this.pushUpdate("failed", "REMOTE_SIGNAL_FAILED");
        return { session: this.session() };
      }
      if (this.updateAt === "signal_interrupted") {
        this.pushUpdate("interrupted");
        return { session: this.session() };
      }
      const offer = body.signal.sdp;
      const answer = sdp(this.roundId === ROUND1 ? "22" : "44");
      this.enqueue("peer_session_signal", {
        session_id: this.sessionId,
        round_id: this.roundId,
        from: "responder",
        signal: { kind: "answer", seq: 0, sdp: answer },
      });
      this.ticket(offer, answer);
      return { session: this.session() };
    }
    if (pathname.endsWith("/event")) {
      this.events.push({ ...body });
      if (["completed", "cancelled", "failed", "expired"].includes(this.phase)) {
        return { session: this.session() };
      }
      if (body.event === "fail" && this.cancelOnFailEvent) {
        this.pushUpdate("cancelled");
        return { session: this.session() };
      }
      if (body.event === "active") {
        this.phase = "active";
        this.endpointEvents.source.active = true;
      } else if (body.event === "interrupt") {
        this.roundId = ROUND2;
        this.roundNo = 2;
        this.phase = "interrupted";
        this.enqueue("peer_session_round_prepare", {
          session_id: this.sessionId,
          round_id: ROUND2,
          round_no: 2,
          side: "source",
          signal_role: "initiator",
          direct_only: true,
        });
      } else if (body.event === "complete") {
        this.endpointEvents.source.completed = true;
        this.phase = "completed";
      } else if (body.event === "cancel") {
        this.phase = "cancelled";
      } else if (body.event === "fail") {
        this.phase = "failed";
        this.failure_code = body.failure_code;
      }
      return { session: this.session() };
    }
    throw new Error(`unexpected Hub path ${pathname}`);
  }
}

function peerConnectionClass(hub, { hangClose = false } = {}) {
  return class FakePeerConnection {
    constructor() {
      this.roundId = hub.roundId;
      this.connectionStateChange = { subscribe() {} };
      this.onDataChannel = { subscribe() {} };
    }
    createDataChannel() {
      this.channel = new FakeChannel(hub, this.roundId);
      hub.channels.push(this.channel);
      if (hub.earlyBindings) {
        queueMicrotask(() => this.channel.onmessage?.({ data: dcControl("peer_bindings", hub.sessionId, this.roundId, {
          session_binding: PEER_SESSION_NONCE,
          round_binding: PEER_ROUND_NONCE,
        }) }));
      }
      return this.channel;
    }
    async createOffer() { return { type: "offer", sdp: sdp(this.roundId === ROUND1 ? "11" : "33") }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async close() {
      if (hangClose) return new Promise(() => {});
      this.channel?.close();
    }
  };
}

function fakePlugin(records, counters, { cancelGate, cancelError, abortGate } = {}) {
  let waiter;
  let stopped = false;
  return {
    next(signal) {
      if (records.length) return Promise.resolve(records.shift());
      return new Promise((resolve, reject) => {
        const aborted = () => reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
        signal?.addEventListener("abort", aborted, { once: true });
        waiter = { reject, aborted, signal };
      });
    },
    async writeData(value) { counters.fromPeer.push(Buffer.from(value)); },
    async cancel() {
      counters.cancel += 1;
      counters.order.push("cancel");
      if (cancelGate) await cancelGate;
      if (cancelError) throw cancelError;
      stopped = true;
      waiter?.reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    },
    async abort() {
      counters.order.push("abort");
      if (!stopped) counters.abort += 1;
      if (abortGate) await abortGate;
      stopped = true;
      waiter?.reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
    },
  };
}

function waitGate(gate, signal) {
  if (!gate) return Promise.resolve();
  const processCancelled = () => Object.assign(new Error("plugin process aborted"), { code: "cancelled" });
  if (signal?.aborted) return Promise.reject(processCancelled());
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal?.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => finish(reject, processCancelled());
    signal?.addEventListener("abort", aborted, { once: true });
    Promise.resolve(gate).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function managerFor(hub, {
  idle = false,
  firstRoundIdle = false,
  completeOnly = false,
  cancelGate,
  cancelError,
  abortGate,
  startupGate,
  hangPeerClose = false,
  totalMs = 10_000,
  cancelMs,
} = {}) {
  let launch = 0;
  const counters = [];
  const launchArgs = [];
  const manager = createPluginPeerManager({
    hubPost: hub.post.bind(hub),
    token: "token",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({ pub: "pub", kid: "kid-1" }),
    verifyFleetStatement: async ({ ticket }) => ticket,
    launchPlugin: async (args) => {
      const { onProcess, ...serializableArgs } = args;
      launchArgs.push(structuredClone(serializableArgs));
      const counter = { abort: 0, cancel: 0, fromPeer: [], order: [] };
      counters.push(counter);
      launch += 1;
      const records = idle || (firstRoundIdle && launch === 1) ? [] : completeOnly
        ? [{ kind: "control", control: { status: "complete", result: { ok: true } } }]
        : launch === 1 && hub.interruptFirstRound
        ? [{ kind: "data", data: Buffer.from("first") }]
        : [{ kind: "data", data: Buffer.from("resumed") }, { kind: "control", control: { status: "complete", result: { ok: true } } }];
      const plugin = fakePlugin(records, counter, {
        cancelGate: typeof cancelGate === "function" ? cancelGate(launch) : cancelGate,
        cancelError: typeof cancelError === "function" ? cancelError(launch) : cancelError,
        abortGate: typeof abortGate === "function" ? abortGate(launch) : abortGate,
      });
      await onProcess?.(plugin);
      await waitGate(startupGate, args.signal);
      return plugin;
    },
    runtime: {
      loadPeerConnection: async () => peerConnectionClass(hub, { hangClose: hangPeerClose }),
      randomBytes: () => Buffer.alloc(32, 0x40 + launch),
      connectMs: 50,
      maxRounds: 3,
      totalMs,
      ...(cancelMs == null ? {} : { cancelMs }),
    },
  });
  return { manager, counters, launchArgs, launches: () => launch };
}

test("canonical capability digest and fingerprint match the shared Go fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fleet-agent/testdata/plugin-peer-canonical.json", import.meta.url), "utf8"));
  assert.equal(pluginPeerRuntimeInternals.capabilityDigest(fixture.protocol, fixture.source, fixture.target), fixture.capability_digest);
  assert.equal(pluginPeerRuntimeInternals.peerFingerprint(fixture.sdp), fixture.fingerprint);
});

test("opaque plugin input equality is independent of object key insertion order", () => {
  const local = pluginPeerRuntimeInternals.canonicalOpaque({ path: "/tmp/a", chunk_size: 32768 });
  const delivered = pluginPeerRuntimeInternals.canonicalOpaque({ chunk_size: 32768, path: "/tmp/a" });
  assert.equal(JSON.stringify(local), JSON.stringify(delivered));
});

test("Tool passes only bounded STUN and STUNS URLs supported by werift", () => {
  assert.deepEqual(
    pluginPeerRuntimeInternals.iceServers([
      "stun:one.example:3478",
      "stuns:two.example:5349",
      "STUNS:three.example:5349",
      "turn:relay.example:3478",
      "stun:bad host",
    ]),
    [
      { urls: "stun:one.example:3478" },
      { urls: "stuns:two.example:5349" },
      { urls: "STUNS:three.example:5349" },
    ],
  );
});

test("a Hub prepare with reordered opaque-input keys passes the full manager path", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager } = managerFor(hub);
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "completed");
  assert.deepEqual(Object.keys(hub.createBodies[0].source.input), ["chunk_size", "path"]);
  assert.deepEqual(Object.keys(SOURCE.input), ["path", "chunk_size"]);
});

test("FLPP open receives only the minimal peer context, never Fleet capability metadata", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager, launchArgs } = managerFor(hub);
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "completed");
  assert.deepEqual(launchArgs[0].peer, { kind: "device", id: "device-1", name: "target machine" });
  assert.equal("plugin_id" in launchArgs[0].peer, false);
});

test("bindings sent immediately after DataChannel creation are installed before any async signaling step", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false, earlyBindings: true });
  const { manager } = managerFor(hub);
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "completed", JSON.stringify(result));
});

test("DataChannel inbox enforces hard bounds and AbortSignal wakes a pending read", async () => {
  const channel = {};
  const controller = new AbortController();
  const inbox = pluginPeerRuntimeInternals.createChannelInbox(channel, controller.signal);
  const pending = inbox.next();
  controller.abort();
  await assert.rejects(() => pending, (error) => error?.code === "cancelled");

  const boundedChannel = { close() { this.closed = true; } };
  const bounded = pluginPeerRuntimeInternals.createChannelInbox(boundedChannel);
  const rejected = bounded.next();
  boundedChannel.onmessage({ data: "x".repeat((64 << 10) + 1) });
  await assert.rejects(() => rejected, (error) => error?.code === "backpressure");
  assert.equal(boundedChannel.closed, true);
});

test("waiting for channel open preserves the inbox close and error handlers", async () => {
  const channel = { readyState: "connecting" };
  const inbox = pluginPeerRuntimeInternals.createChannelInbox(channel);
  const opening = pluginPeerRuntimeInternals.waitOpen(
    channel,
    { connectionStateChange: { subscribe() {} } },
    undefined,
    100,
  );
  channel.readyState = "open";
  channel.onopen();
  await opening;
  const pending = inbox.next();
  channel.readyState = "closed";
  channel.onclose();
  await assert.rejects(() => pending, (error) => error?.code === "interrupted");
});

test("caller supplied session_id is strict UUIDv4 and rejected before Hub I/O", async () => {
  let hubCalls = 0;
  const manager = createPluginPeerManager({
    hubPost: async () => { hubCalls += 1; },
    token: "token",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({}),
    verifyFleetStatement: async () => ({}),
    launchPlugin: async () => ({}),
  });
  await assert.rejects(
    () => manager.start({ session_id: "not-a-uuid", protocol: PROTOCOL, source: SOURCE, target: TARGET }),
    (error) => error?.code === "invalid_session",
  );
  assert.equal(hubCalls, 0);
});

test("endpoint names reject embedded ASCII controls before Hub I/O", async () => {
  let hubCalls = 0;
  const manager = createPluginPeerManager({
    hubPost: async () => { hubCalls += 1; },
    token: "token",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({}),
    verifyFleetStatement: async () => ({}),
    launchPlugin: async () => ({}),
  });
  for (const name of ["bad\u0000name", "bad\u001fname", "bad\u007fname"]) {
    await assert.rejects(
      () => manager.start({ protocol: PROTOCOL, source: { ...SOURCE, name }, target: TARGET }),
      (error) => error?.code === "invalid_endpoint",
    );
  }
  assert.equal(hubCalls, 0);
});

test("same session resumes on a fresh immutable round after DATA interruption", async () => {
  const hub = new FakeHub({ interruptFirstRound: true, loseCreateResponse: true, loseFirstAckResponse: true });
  const { manager, counters, launches } = managerFor(hub);
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const id = started.session_id;
  assert.ok(id);
  const result = await manager.wait(id);
  assert.equal(result.local.phase, "completed", JSON.stringify(result));
  assert.equal(launches(), 2);
  assert.equal(counters[0].abort, 1);
  assert.equal(counters[0].cancel, 0);
  assert.equal(hub.events.filter((value) => value.event === "interrupt").length, 1);
  assert.deepEqual(hub.received.map(({ roundId, data }) => [roundId, data.toString()]), [[ROUND1, "first"], [ROUND2, "resumed"]]);
  assert.equal(hub.createBodies.length, 2);
  assert.equal(hub.createBodies[0].session_id, hub.createBodies[1].session_id, "create retry changed session UUID");
  assert.equal(hub.lostAckResponse, true, "delivery ACK retry path was not exercised");
});

test("Hub cancel waits through retained Abort and cancels the fresh provisional owner", async () => {
  const hub = new FakeHub({ interruptFirstRound: true, loseCreateResponse: false });
  let releaseRetainedAbort;
  let releaseReplacementCancel;
  const retainedAbortGate = new Promise((resolve) => { releaseRetainedAbort = resolve; });
  const replacementCancelGate = new Promise((resolve) => { releaseReplacementCancel = resolve; });
  const { manager, counters } = managerFor(hub, {
    abortGate: (launch) => launch === 1 ? retainedAbortGate : null,
    cancelGate: (launch) => launch === 2 ? replacementCancelGate : null,
  });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const waiting = manager.wait(started.session_id);
  const abortDeadline = Date.now() + 2000;
  while ((counters[0]?.abort || 0) !== 1 && Date.now() < abortDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(counters[0]?.abort, 1, "fresh round never started retiring the interrupted plugin");

  hub.pushUpdate("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(counters.length, 1, "replacement launched before retained Abort completed");
  assert.equal(row.abort.signal.aborted, false, "Hub cancel aborted the fresh transition before replacement ownership");

  releaseRetainedAbort();
  const cancelDeadline = Date.now() + 2000;
  while ((counters[1]?.cancel || 0) !== 1 && Date.now() < cancelDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(counters[1]?.cancel, 1, "fresh provisional plugin never received FLPP cancel");
  assert.equal(counters[0].cancel, 0, "already-retiring plugin incorrectly received FLPP cancel");
  assert.equal(row.abort.signal.aborted, false, "fresh transition was aborted before provisional Cancel settled");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "Hub cancellation was ACKed before the replacement applied FLPP cancel",
  );

  releaseReplacementCancel();
  const result = await waiting;
  assert.equal(result.local.phase, "cancelled", JSON.stringify(result));
  assert.equal(counters[1].cancel, 1);
  assert.equal(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    false,
    "Hub cancellation remained after replacement cancellation was applied",
  );
});

test("fresh replacement cancel failure is force-cleaned and does not ACK Hub cancellation", async () => {
  const hub = new FakeHub({ interruptFirstRound: true, loseCreateResponse: false });
  let releaseRetainedAbort;
  const retainedAbortGate = new Promise((resolve) => { releaseRetainedAbort = resolve; });
  const replacementError = Object.assign(new Error("replacement rejected cancel"), { code: "plugin_protocol" });
  const { manager, counters } = managerFor(hub, {
    abortGate: (launch) => launch === 1 ? retainedAbortGate : null,
    cancelError: (launch) => launch === 2 ? replacementError : null,
    cancelMs: 1000,
  });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const waiting = manager.wait(started.session_id);
  const abortDeadline = Date.now() + 2000;
  while ((counters[0]?.abort || 0) !== 1 && Date.now() < abortDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(counters[0]?.abort, 1);

  hub.pushUpdate("cancelled");
  const cancelObservedDeadline = Date.now() + 2000;
  while (!manager._rows.get(started.session_id)?.cancelRequested && Date.now() < cancelObservedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manager._rows.get(started.session_id)?.cancelRequested, true, "fresh transition did not observe Hub cancellation");
  releaseRetainedAbort();
  await assert.rejects(() => waiting, (error) => error?.code === "cancel_unapplied");
  assert.equal(counters[0].cancel, 0);
  assert.equal(counters[1].cancel, 1);
  assert.equal(counters[1].abort, 1, "failed replacement cancel skipped forced cleanup");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "Hub cancellation was ACKed without a replacement cancellation receipt",
  );
});

test("an active round resumes when the channel closes before its first DATA frame", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager, launches } = managerFor(hub, { firstRoundIdle: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");
  hub.channels[0].readyState = "closed";
  hub.channels[0].onclose?.();

  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "completed", JSON.stringify(result));
  assert.equal(launches(), 2);
  assert.equal(hub.events.filter((value) => value.event === "interrupt").length, 1);
  assert.deepEqual(hub.received.map(({ roundId, data }) => [roundId, data.toString()]), [[ROUND2, "resumed"]]);
});

test("Hub cancel racing an interrupted channel retains FLPP until cleanup then ACKs", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");

  hub.channels[0].readyState = "closed";
  hub.channels[0].onclose?.();
  hub.pushUpdate("cancelled");
  const cancelStarted = Date.now() + 2000;
  while (counters[0].cancel !== 1 && Date.now() < cancelStarted) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(counters[0].cancel, 1, "retained interrupted plugin never received FLPP cancel");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "Hub cancel delivery was ACKed before gated local cleanup",
  );
  assert.equal(counters[0].abort, 0, "interruption aborted the plugin before cancellation won");

  releaseCancel();
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "cancelled", JSON.stringify(result));
  assert.equal(counters[0].cancel, 1);
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
  assert.equal(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    false,
    "terminal delivery remained after local cleanup",
  );
});

test("status-only Hub cancellation before active still gracefully cancels FLPP", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    updateAt: "authorize_cancelled_status_only",
  });
  const { manager, counters } = managerFor(hub, { idle: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "cancelled", JSON.stringify(result));
  assert.equal(counters[0].cancel, 1);
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
});

test("local and Hub cancellation await one shared plugin cleanup", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");

  const localCancel = manager.cancel(started.session_id);
  hub.pushUpdate("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(counters[0].cancel, 1, "concurrent cancellation invoked FLPP cancel twice");
  assert.equal(counters[0].abort, 0, "shared cancellation was force-aborted before its gate released");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "concurrent Hub delivery was ACKed before shared cleanup",
  );

  releaseCancel();
  await localCancel;
  await row.done;
  assert.equal(counters[0].cancel, 1);
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
});

test("a Hub cancel that wins a local protocol-failure race is applied before ACK", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    badTicket: true,
    cancelOnFailEvent: true,
  });
  const { manager, counters } = managerFor(hub, { idle: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);

  assert.equal(result.local.phase, "cancelled", JSON.stringify(result));
  assert.equal(counters[0].cancel, 1, "cancelled delivery was reconciled without FLPP Cancel");
  assert.equal(counters[0].abort, 0, "local failure aborted the plugin before the Hub decision");
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
  assert.equal(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    false,
    "cancelled delivery remained after its graceful cleanup and ACK",
  );
});

test("Hub cancellation reaches a provisional plugin that is waiting for ready", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseCancel;
  let releaseStartup;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate, startupGate });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const provisionalDeadline = Date.now() + 2000;
  while (counters.length !== 1 && Date.now() < provisionalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(counters.length, 1, "test launcher never exposed its provisional process");

  hub.pushUpdate("cancelled");
  const cancelDeadline = Date.now() + 2000;
  while (counters[0].cancel !== 1 && Date.now() < cancelDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(counters[0].cancel, 1, "Hub watcher waited for plugin ready before FLPP cancel");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "provisional cancellation was ACKed before cleanup completed",
  );
  assert.equal(counters[0].abort, 0, "provisional plugin was aborted before graceful cancellation");

  releaseCancel();
  releaseStartup();
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "cancelled", JSON.stringify(result));
  assert.equal(counters[0].cancel, 1);
  assert.equal(counters[0].abort, 0);
  assert.equal(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    false,
    "provisional cancelled delivery remained after cleanup and ACK",
  );
});

for (const terminal of [
  { phase: "failed", failureCode: "FAILED", remoteCode: "REMOTE_PLUGIN_FAILED", error: /REMOTE_PLUGIN_FAILED/ },
  { phase: "expired", failureCode: "EXPIRED", remoteCode: "SESSION_EXPIRED", error: /SESSION_EXPIRED/ },
  { phase: "completed", failureCode: "PEER_PROTOCOL", remoteCode: "", error: /Hub completed before/ },
]) {
  test(`Hub ${terminal.phase} aborts an open-written provisional plugin without waiting for ready`, async () => {
    const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
    const neverReady = new Promise(() => {});
    const { manager, counters } = managerFor(hub, {
      idle: true,
      startupGate: neverReady,
      cancelMs: 100,
    });
    const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
    const row = manager._rows.get(started.session_id);
    const provisionalDeadline = Date.now() + 2000;
    while (counters.length !== 1 && Date.now() < provisionalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(counters.length, 1, "launcher never exposed its provisional process");

    const began = Date.now();
    hub.pushUpdate(terminal.phase, terminal.remoteCode);
    const result = await manager.wait(started.session_id);
    assert.ok(Date.now() - began < 500, `${terminal.phase} waited for the never-ready launcher`);
    assert.equal(result.local.phase, "failed", JSON.stringify(result));
    assert.equal(result.local.failure_code, terminal.failureCode, JSON.stringify(result));
    assert.match(result.local.error, terminal.error, "local process cancellation replaced the authoritative Hub terminal error");
    assert.doesNotMatch(result.local.error, /plugin process aborted/);
    assert.equal(counters[0].cancel, 0);
    assert.equal(counters[0].abort, 1, "provisional process did not receive Abort");
    assert.equal(row.io.signal.aborted, true, "terminal cleanup did not stop the launcher signal");
    assert.equal(
      [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === terminal.phase),
      false,
      `${terminal.phase} delivery remained after bounded local cleanup`,
    );
  });
}

test("Hub terminal ACK cannot be followed by a late resolver spawn", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "fleet-peer-late-resolver-"));
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseResolver;
  const resolverGate = new Promise((resolve) => { releaseResolver = resolve; });
  let markResolverStarted;
  const resolverStarted = new Promise((resolve) => { markResolverStarted = resolve; });
  let resolverSignal;
  let spawns = 0;
  const launchPlugin = createPluginPeerLauncher({
    resolve: async (_pluginId, _protocol, _role, options) => {
      resolverSignal = options.signal;
      markResolverStarted();
      await resolverGate;
      return {
        path: path.join(root, "must-not-spawn"),
        action: "source",
        dataDir: path.join(root, "data"),
      };
    },
    spawnImpl: () => { spawns += 1; throw new Error("late spawn escaped terminal cleanup"); },
  });
  const manager = createPluginPeerManager({
    hubPost: hub.post.bind(hub),
    token: "token",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({ pub: "pub", kid: "kid-1" }),
    verifyFleetStatement: async ({ ticket }) => ticket,
    launchPlugin,
    runtime: {
      loadPeerConnection: async () => peerConnectionClass(hub),
      randomBytes: () => Buffer.alloc(32, 0x40),
      connectMs: 50,
      maxRounds: 3,
      totalMs: 10_000,
      cancelMs: 100,
    },
  });
  try {
    const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
    await resolverStarted;
    hub.pushUpdate("failed", "REMOTE_PLUGIN_FAILED");
    const result = await manager.wait(started.session_id);
    assert.equal(result.local.phase, "failed", JSON.stringify(result));
    assert.equal(result.local.failure_code, "FAILED", JSON.stringify(result));
    assert.equal(resolverSignal.aborted, true, "terminal cleanup did not cancel the pending resolver");
    assert.equal(spawns, 0);
    assert.equal(
      [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "failed"),
      false,
      "Hub terminal delivery was not ACKed before the late-resolver check",
    );

    releaseResolver();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(spawns, 0, "resolver spawned a plugin after terminal cleanup and ACK");
  } finally {
    releaseResolver?.();
  }
});

test("rejected plugin cancel is force-cleaned and leaves durable Hub cancellation unacknowledged", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const rejection = Object.assign(new Error("plugin rejected cancel"), { code: "plugin_protocol" });
  const { manager, counters } = managerFor(hub, { idle: true, cancelError: rejection, cancelMs: 100 });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");

  hub.pushUpdate("cancelled");
  await assert.rejects(
    () => manager.wait(started.session_id),
    (error) => error?.code === "cancel_unapplied",
  );
  assert.equal(counters[0].cancel, 1);
  assert.equal(counters[0].abort, 1, "cancel rejection skipped forced process cleanup");
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "durable cancellation was ACKed even though FLPP cancel was rejected",
  );
});

test("timed-out plugin cancel is force-cleaned and leaves durable Hub cancellation unacknowledged", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const never = new Promise(() => {});
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate: never, cancelMs: 80 });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");

  hub.pushUpdate("cancelled");
  await assert.rejects(
    () => manager.wait(started.session_id),
    (error) => error?.code === "cancel_unapplied",
  );
  assert.equal(counters[0].cancel, 1);
  assert.equal(counters[0].abort, 1, "cancel timeout skipped forced process cleanup");
  assert.ok(
    [...hub.deliveries.values()].some((item) => item.type === "peer_session_update" && item.body.phase === "cancelled"),
    "durable cancellation was ACKed after FLPP cancel timed out",
  );
});

test("local peer_done drains before Hub completion when the remote half closes first", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    remoteDoneBeforeLocal: true,
    holdPeerDoneBuffer: true,
  });
  const { manager } = managerFor(hub, { completeOnly: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  let settled = false;
  const waiting = manager.wait(started.session_id).finally(() => { settled = true; });
  const deadline = Date.now() + 2000;
  while (!hub.localPeerDoneSent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hub.localPeerDoneSent, true, "Tool never sent its half-close control");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false, "Tool completed while peer_done was still buffered");
  assert.equal(hub.events.some((value) => value.event === "complete"), false);

  hub.channels[0].bufferedAmount = 0;
  const result = await waiting;
  assert.equal(result.local.phase, "completed", JSON.stringify(result));
  assert.equal(hub.events.some((value) => value.event === "complete"), true);
});

test("a current-round interrupt update during signaling exits immediately and never resumes before active", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    updateAt: "signal_interrupted",
  });
  const { manager, launches } = managerFor(hub);
  const startedAt = Date.now();
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed", JSON.stringify(result));
  assert.equal(result.local.failure_code, "INTERRUPTED");
  assert.equal(launches(), 1);
  assert.equal(hub.events.some((value) => value.event === "interrupt"), false);
  assert.ok(Date.now() - startedAt < 1000, "signaling ignored the current-round interrupt update");
});

test("waitPhase treats an authorized current-round interrupt as terminal before active", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    updateAt: "authorize_interrupted",
  });
  const { manager, launches } = managerFor(hub);
  const startedAt = Date.now();
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed", JSON.stringify(result));
  assert.equal(result.local.failure_code, "INTERRUPTED");
  assert.equal(launches(), 1);
  assert.equal(hub.events.some((value) => value.event === "interrupt"), false);
  assert.ok(Date.now() - startedAt < 1000, "phase wait ignored the current-round interrupt");
});

test("a terminal update aborts the DataChannel binding wait instead of waiting for its deadline", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    updateAt: "binding_failed",
  });
  const { manager, launches } = managerFor(hub);
  const startedAt = Date.now();
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed", JSON.stringify(result));
  assert.equal(result.local.failure_code, "FAILED");
  assert.equal(launches(), 1);
  assert.ok(Date.now() - startedAt < 1000, "binding handshake ignored the terminal update");
});

test("old ticket kind is terminal and never starts a resume round", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, badTicket: true, loseCreateResponse: false });
  const { manager, launches } = managerFor(hub);
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed");
  assert.match(result.local.failure_code, /TICKET_REJECTED/, JSON.stringify(result));
  assert.equal(launches(), 1);
  assert.equal(hub.events.some((value) => value.event === "interrupt"), false);
});

test("a peer that opens DATA but never completes binding handshake fails within one connect deadline", async () => {
  const hub = new FakeHub({
    interruptFirstRound: false,
    loseCreateResponse: false,
    silentHandshake: true,
  });
  const { manager, launches } = managerFor(hub);
  const startedAt = Date.now();
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed");
  assert.equal(result.local.failure_code, "DIRECT_UNAVAILABLE");
  assert.equal(launches(), 1);
  assert.equal(hub.events.some((value) => value.event === "interrupt"), false);
  assert.ok(Date.now() - startedAt < 1000, "binding handshake exceeded its bounded test deadline");
});

test("the total session deadline aborts a blocked local plugin without sending explicit cancel", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager, counters } = managerFor(hub, { idle: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active");
  row.timeout.abort();
  const result = await manager.wait(started.session_id);
  assert.equal(result.local.phase, "failed");
  assert.equal(result.local.failure_code, "TIMEOUT");
  assert.equal(counters[0]?.cancel || 0, 0);
  assert.equal(counters[0]?.abort || 0, 1);
});

test("explicit cancel reaches the peer and FLPP plugin before process abort", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager, counters } = managerFor(hub, { idle: true });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active", `local=${row.phase} hub=${hub.phase}`);
  await manager.cancel(started.session_id);
  await row.done;
  assert.equal(counters[0].cancel, 1);
  assert.equal(counters[0].order[0], "cancel");
  assert.ok(hub.channels[0].sent.some((value) => typeof value === "string" && JSON.parse(value).type === "peer_cancel"));
  assert.equal(hub.phase, "cancelled");
});

test("AbortSignal waits for the same bounded cancel operation before returning", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active", `local=${row.phase} hub=${hub.phase}`);

  const controller = new AbortController();
  let settled = false;
  const waiting = manager.wait(started.session_id, { signal: controller.signal }).finally(() => { settled = true; });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(counters[0].cancel, 1);
  assert.equal(settled, false, "wait returned before FLPP cancel cleanup completed");

  releaseCancel();
  await assert.rejects(() => waiting, (error) => error?.code === "cancelled");
  assert.equal(hub.phase, "cancelled");
});

test("AbortSignal interrupts an in-flight wait status request before bounded remote cancel", async () => {
  let sessionId = "";
  let statusCalls = 0;
  let firstStatusSignal;
  let markStatusStarted;
  const statusStarted = new Promise((resolve) => { markStatusStarted = resolve; });
  const remoteSession = (phase = "active") => ({
    session_id: sessionId,
    phase,
    protocol: PROTOCOL,
    round: { id: ROUND1, no: 1 },
    signal_sides: { initiator: "source", responder: "target" },
  });
  const hubPost = async (pathname, body, options = {}) => {
    if (pathname.endsWith("/create")) {
      sessionId = body.session_id;
      return { session: remoteSession() };
    }
    if (pathname.endsWith("/status")) {
      statusCalls += 1;
      if (statusCalls > 1) return { session: remoteSession() };
      firstStatusSignal = options.signal;
      markStatusStarted();
      return new Promise((resolve, reject) => {
        firstStatusSignal.addEventListener(
          "abort",
          () => reject(firstStatusSignal.reason || new Error("aborted")),
          { once: true },
        );
      });
    }
    if (pathname.endsWith("/event")) {
      assert.equal(body.event, "cancel");
      return { session: remoteSession("cancelled") };
    }
    throw new Error(`unexpected Hub call ${pathname}`);
  };
  const manager = createPluginPeerManager({
    hubPost,
    token: "unused",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({ kid: "kid-1", pub: "pub" }),
    verifyFleetStatement: async () => null,
    launchPlugin: async () => assert.fail("device-to-device must not launch a Tool plugin"),
    runtime: { cancelMs: 100 },
  });
  const source = { ...SOURCE, kind: "device", id: "device-source" };
  const target = { ...TARGET, kind: "device", id: "device-target" };
  await manager.start({ protocol: PROTOCOL, initiator: "source", source, target });
  const controller = new AbortController();
  const waiting = manager.wait(sessionId, { signal: controller.signal });
  await statusStarted;
  controller.abort(new Error("stdio cancelled"));
  await assert.rejects(() => waiting, (error) => error?.code === "cancelled");
  assert.equal(firstStatusSignal, controller.signal);
  assert.equal(firstStatusSignal.aborted, true);
  assert.equal(statusCalls, 2);
});

test("a plugin cancel timeout is force-aborted and reported as unapplied", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const never = new Promise(() => {});
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate: never, cancelMs: 80 });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active", `local=${row.phase} hub=${hub.phase}`);

  const began = Date.now();
  await assert.rejects(
    () => manager.cancel(started.session_id),
    (error) => error?.code === "cancel_unapplied",
  );
  assert.ok(Date.now() - began < 500, "cancel exceeded its hard budget");
  await assert.rejects(() => row.done, (error) => error?.code === "cancel_unapplied");
  assert.equal(counters[0].cancel, 1);
  assert.equal(counters[0].abort, 1);
  assert.deepEqual(counters[0].order.slice(0, 2), ["cancel", "abort"]);
  assert.equal(hub.phase, "cancelled");
});

test("a peer connection that never closes cannot block the authoritative Hub cancel", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager } = managerFor(hub, { idle: true, hangPeerClose: true, cancelMs: 80 });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  const deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active", `local=${row.phase} hub=${hub.phase}`);

  const began = Date.now();
  await manager.cancel(started.session_id);
  assert.ok(Date.now() - began < 500, "cancel waited on an uninterruptible peer close");
  await row.done;
  assert.equal(hub.phase, "cancelled");
  assert.equal(row.cancelEventSent, true);
});

test("runtime shutdown joins cleanup already claimed by a terminal Hub cancellation", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const { manager, counters } = managerFor(hub, { idle: true, cancelGate, cancelMs: 500 });
  const started = await manager.start({ protocol: PROTOCOL, initiator: "source", source: SOURCE, target: TARGET });
  const row = manager._rows.get(started.session_id);
  let deadline = Date.now() + 2000;
  while (row.phase !== "active" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row.phase, "active", `local=${row.phase} hub=${hub.phase}`);

  hub.pushUpdate("cancelled");
  deadline = Date.now() + 2000;
  while ((row.phase !== "cancelled" || counters[0]?.cancel !== 1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(row.phase, "cancelled");
  assert.equal(counters[0]?.cancel, 1);

  let settled = false;
  const stopping = manager.shutdown().finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false, "shutdown returned while terminal cancellation cleanup was still running");

  releaseCancel();
  await stopping;
  await row.done;
  assert.equal(counters[0].cancel, 1);
});

test("runtime shutdown hard-bounds a terminal row whose cleanup never settles", async () => {
  const hub = new FakeHub({ interruptFirstRound: false, loseCreateResponse: false });
  const { manager } = managerFor(hub, { cancelMs: 60 });
  manager._rows.set("4ecf761e-eb10-4ffc-af0e-5bd10be51de2", {
    phase: "cancelled",
    done: new Promise(() => {}),
  });

  const began = Date.now();
  await manager.shutdown();
  const elapsed = Date.now() - began;
  assert.ok(elapsed >= 40, `shutdown skipped terminal cleanup instead of waiting for its bound (${elapsed}ms)`);
  assert.ok(elapsed < 500, `shutdown exceeded its hard bound (${elapsed}ms)`);
});

test("runtime shutdown aborts a Hub poll that otherwise never settles", async () => {
  let pollSignal;
  let pollStarted;
  const started = new Promise((resolve) => { pollStarted = resolve; });
  const sessionId = "4ecf761e-eb10-4ffc-af0e-5bd10be51de1";
  const hubPost = async (pathname, body, options = {}) => {
    if (pathname.endsWith("/create")) {
      return {
        session: {
          session_id: body.session_id,
          phase: "waiting_approval",
          protocol: PROTOCOL,
          round: { id: ROUND1, no: 1 },
          signal_sides: { initiator: "source", responder: "target" },
        },
      };
    }
    if (pathname.endsWith("/inbox/poll")) {
      pollSignal = options.signal;
      pollStarted();
      return new Promise((resolve, reject) => {
        pollSignal.addEventListener(
          "abort",
          () => reject(pollSignal.reason || new Error("aborted")),
          { once: true },
        );
      });
    }
    if (pathname.endsWith("/event")) {
      return { session: { session_id: sessionId, phase: "failed", round: { id: ROUND1 } } };
    }
    if (pathname.endsWith("/status")) {
      return { session: { session_id: sessionId, phase: "failed", round: { id: ROUND1 } } };
    }
    throw new Error(`unexpected Hub call ${pathname}`);
  };
  const manager = createPluginPeerManager({
    hubPost,
    token: "unused",
    operatorId: OPERATOR,
    verifyTokenV1: async () => ({ kid: "kid-1", pub: "pub" }),
    verifyFleetStatement: async () => null,
    launchPlugin: async () => assert.fail("approval never completed"),
    runtime: { totalMs: 60_000, cancelMs: 100 },
  });
  await manager.start({
    session_id: sessionId,
    protocol: PROTOCOL,
    source: SOURCE,
    target: TARGET,
    initiator: "source",
  });
  await started;
  await manager.shutdown();
  assert.equal(pollSignal.aborted, true);
});
