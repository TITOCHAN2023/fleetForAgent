import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { FILE_CHUNK_BYTES } from "./file-transfer.mjs";
import { createFileTransferManager } from "./file-transfer-rtc.mjs";

const TRANSFER_ID = "11111111-2222-4333-8444-555555555555";
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPERATOR_ID = "tool-operator-1";
const DEVICE_ID = "device-1";
const USER_ID = "user-1";
const KID = "kid-1";
const NOW = 1_900_000_000_000;
const OFFER_FP = "11".repeat(32);
const ANSWER_FP = "22".repeat(32);
const FILE_SHA256 = "ab".repeat(32);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function fingerprintLine(byte) {
  return Array.from({ length: 32 }, () => byte.repeat(2)).join(":");
}

const OFFER = `v=0\r\na=fingerprint:sha-256 ${fingerprintLine("1")}\r\n`;
const ANSWER = `v=0\r\na=fingerprint:sha-256 ${fingerprintLine("2")}\r\n`;
const MANIFEST = Object.freeze({ name: "source.bin", size: 5, sha256: FILE_SHA256 });

function endpointBinding(kind, id) {
  return createHash("sha256").update(kind).update("\0").update(id).digest("hex");
}

function validTicket({
  source = { kind: "tool", id: OPERATOR_ID },
  target = { kind: "device", id: DEVICE_ID },
  sid = SID,
  manifest = MANIFEST,
  resume = { offset: 0, prefix_sha256: EMPTY_SHA256 },
  iat = NOW - 1_000,
  exp = NOW + 30_000,
} = {}) {
  return {
    v: 1,
    kind: "file_transfer",
    transfer_id: TRANSFER_ID,
    sid,
    user_id: USER_ID,
    kid: KID,
    operator_id: OPERATOR_ID,
    source_kind: source.kind,
    source_id: source.id,
    target_kind: target.kind,
    target_id: target.id,
    offerer_kind: source.kind,
    offerer_id: source.id,
    answerer_kind: target.kind,
    answerer_id: target.id,
    file_name: manifest.name,
    file_size: manifest.size,
    file_sha256: manifest.sha256,
    chunk_size: FILE_CHUNK_BYTES,
    resume_offset: resume.offset,
    prefix_sha256: resume.prefix_sha256,
    offer_fp: OFFER_FP,
    answer_fp: ANSWER_FP,
    direct_only: true,
    iat,
    exp,
  };
}

function fakePeerRuntime({ instances, channel = { readyState: "open", label: "" } }) {
  class FakeRTCPeerConnection {
    constructor(config) {
      this.config = config;
      this.localDescription = null;
      this.remoteDescription = null;
      this.closed = false;
      this.connectionStateChange = { subscribe: (listener) => (this.stateListener = listener) };
      this.onDataChannel = { subscribe: (listener) => (this.dataChannelListener = listener) };
      instances.push(this);
    }

    createDataChannel(label, options) {
      channel.label = label;
      this.createdChannel = { label, options };
      return channel;
    }

    async createOffer() {
      return { type: "offer", sdp: OFFER };
    }

    async createAnswer() {
      return { type: "answer", sdp: ANSWER };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
      if (description.type === "offer") this.dataChannelListener?.(channel);
    }

    async close() {
      this.closed = true;
    }
  }

  return {
    loadPeerConnection: async () => FakeRTCPeerConnection,
    randomUUID: () => SID,
    now: () => NOW,
  };
}

function assertNoFileBytesInHub(calls) {
  const visit = (value) => {
    assert.equal(Buffer.isBuffer(value), false, "Hub control calls must never contain file buffers");
    assert.equal(ArrayBuffer.isView(value), false, "Hub control calls must never contain binary views");
    assert.equal(value instanceof ArrayBuffer, false, "Hub control calls must never contain binary buffers");
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child);
  };
  for (const call of calls) {
    assert.match(call.path, /^\/v1\/(?:transfer\/|rtc\/config$)/);
    visit(call.body);
  }
}

async function toolSourceScenario({ ticketResult = validTicket(), rtcAvailable = true } = {}) {
  const calls = [];
  const order = [];
  const instances = [];
  let pollCount = 0;
  let sourceClosed = 0;
  let sendCalls = 0;
  const source = {
    manifest: MANIFEST,
    close: async () => {
      sourceClosed += 1;
    },
  };
  const runtime = {
    ...fakePeerRuntime({ instances }),
    openLocalSource: async (filePath) => {
      assert.equal(filePath, "/local/source.bin");
      order.push("open-source");
      return source;
    },
    openLocalTarget: async () => {
      throw new Error("Tool source must not open a local target");
    },
    sendLocalFile: async (input) => {
      sendCalls += 1;
      order.push("send");
      assert.equal(input.source, source);
      assert.equal(input.transferId, TRANSFER_ID);
      assert.equal(input.channel.readyState, "open");
      input.onProgress({ sent: 5, committed: 5, size: 5 });
      return { size: 5, sha256: FILE_SHA256 };
    },
    receiveLocalFile: async () => {
      throw new Error("Tool source must not receive a local file");
    },
  };
  const hubPost = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    if (path === "/v1/transfer/create") {
      assert.deepEqual(body, {
        source: { kind: "tool", id: OPERATOR_ID },
        target: { kind: "device", id: DEVICE_ID },
        source_path: "",
        target_path: "/remote/inbox",
      });
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    }
    if (path === "/v1/transfer/authorize") {
      assert.deepEqual(body, {
        transfer_id: TRANSFER_ID,
        role: "source",
        preparation: { file: { ...MANIFEST, chunk_size: FILE_CHUNK_BYTES } },
      });
      return { transfer: { transfer_id: TRANSFER_ID, phase: "authorizing" } };
    }
    if (path === "/v1/transfer/status") {
      return {
        transfer: {
          transfer_id: TRANSFER_ID,
          phase: "signaling",
          resume: { offset: 0, prefix_sha256: EMPTY_SHA256 },
        },
      };
    }
    if (path === "/v1/rtc/config") {
      assert.deepEqual(body, { device_id: DEVICE_ID });
      return rtcAvailable
        ? { available: true, stun_urls: ["stun:stun.example.test:3478", "turn:forbidden.example.test"] }
        : { available: false, reason: "no direct route" };
    }
    if (path === "/v1/transfer/signal") {
      assert.equal(body.sid, SID);
      assert.deepEqual(body.signal, { kind: "offer", seq: 1, sdp: OFFER });
      assert.equal("sid" in body.signal, false, "sid belongs to the signal request, not the SDP object");
      return { transfer: { transfer_id: TRANSFER_ID, phase: "signaling" } };
    }
    if (path === "/v1/transfer/signal/poll") {
      pollCount += 1;
      if (pollCount > 1) return { items: [] };
      return {
        items: [
          { kind: "ticket", statement: { payload: "ticket", sig: "signature" } },
          { kind: "signal", sid: SID, signal: { kind: "answer", seq: 1, sdp: ANSWER } },
        ],
      };
    }
    if (path === "/v1/transfer/event") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: body.event === "start" ? "transferring" : "failed" } };
    }
    throw new Error(`unexpected Hub call ${path}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "flt_test",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => ({ kid: KID, pub: "public-spki" }),
    verifyFleetStatement: async (signed) => {
      order.push("verify-ticket");
      assert.deepEqual(signed, {
        publicSpkiB64: "public-spki",
        payload: "ticket",
        sig: "signature",
      });
      return ticketResult;
    },
    runtime,
  });
  const started = await manager.start({
    source: { kind: "tool", path: "/local/source.bin" },
    target: { kind: "device", device_id: DEVICE_ID, directory: "/remote/inbox" },
  });
  const row = manager._rows.get(TRANSFER_ID);
  assert.ok(row?.done);
  await row.done;
  return { calls, instances, manager, order, pollCount, row, sendCalls, sourceClosed, started };
}

test("Tool source creates, authorizes, binds sid outside SDP, verifies ticket, then sends direct", async () => {
  const result = await toolSourceScenario();
  assert.equal(result.row.phase, "completed");
  assert.deepEqual(result.row.result, { size: 5, sha256: FILE_SHA256 });
  assert.equal(result.sendCalls, 1);
  assert.equal(result.sourceClosed, 1);
  assert.equal(result.pollCount, 1, "answer and ticket from one mailbox batch must both survive matching");
  assert.ok(result.order.indexOf("verify-ticket") < result.order.indexOf("send"));
  assert.deepEqual(result.instances[0].config, {
    iceServers: [{ urls: "stun:stun.example.test:3478" }],
  });
  assert.deepEqual(result.instances[0].remoteDescription, { type: "answer", sdp: ANSWER });
  assert.equal(result.instances[0].closed, true);
  assertNoFileBytesInHub(result.calls);
});

test("Tool target consumes manifest, authorizes zero resume, answers, verifies ticket, then receives", async () => {
  const calls = [];
  const order = [];
  const instances = [];
  let pollCount = 0;
  let targetClosed = 0;
  const target = {
    committed: 0,
    manifest: MANIFEST,
    prefixSHA256: async () => EMPTY_SHA256,
    close: async () => {
      targetClosed += 1;
    },
  };
  const runtime = {
    ...fakePeerRuntime({ instances, channel: { readyState: "open", label: "fleet-file-v1" } }),
    openLocalSource: async () => {
      throw new Error("Tool target must not open a local source");
    },
    openLocalTarget: async (input) => {
      order.push("open-target");
      assert.deepEqual(input, {
        directory: "/local/inbox",
        ...MANIFEST,
        transferId: TRANSFER_ID,
        source: endpointBinding("device", DEVICE_ID),
      });
      return target;
    },
    sendLocalFile: async () => {
      throw new Error("Tool target must not send a local file");
    },
    receiveLocalFile: async (input) => {
      order.push("receive");
      assert.equal(input.target, target);
      assert.equal(input.transferId, TRANSFER_ID);
      assert.equal(input.channel.readyState, "open");
      input.onProgress({ committed: 5, size: 5 });
      return { path: "/local/inbox/source.bin", size: 5, sha256: FILE_SHA256 };
    },
  };
  const hubPost = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    if (path === "/v1/transfer/create") {
      assert.deepEqual(body, {
        source: { kind: "device", id: DEVICE_ID },
        target: { kind: "tool", id: OPERATOR_ID },
        source_path: "/remote/source.bin",
        target_path: "",
      });
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    }
    if (path === "/v1/transfer/signal/poll") {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          items: [
            { kind: "prepare", role: "target", pathHint: "", at: NOW },
            { kind: "manifest", file: { ...MANIFEST, chunkSize: FILE_CHUNK_BYTES }, at: NOW },
          ],
        };
      }
      if (pollCount === 2) {
        return { items: [{ kind: "signal", sid: SID, signal: { kind: "offer", seq: 1, sdp: OFFER } }] };
      }
      if (pollCount === 3) {
        return { items: [{ kind: "ticket", statement: { payload: "ticket", sig: "signature" } }] };
      }
      return { items: [] };
    }
    if (path === "/v1/transfer/authorize") {
      assert.deepEqual(body, {
        transfer_id: TRANSFER_ID,
        role: "target",
        preparation: { resume: { offset: 0, prefix_sha256: EMPTY_SHA256 } },
      });
      return { transfer: { transfer_id: TRANSFER_ID, phase: "signaling" } };
    }
    if (path === "/v1/rtc/config") return { available: true, stun_urls: [] };
    if (path === "/v1/transfer/signal") {
      assert.equal(body.sid, SID);
      assert.deepEqual(body.signal, { kind: "answer", seq: 1, sdp: ANSWER });
      assert.equal("sid" in body.signal, false);
      return { transfer: { transfer_id: TRANSFER_ID, phase: "ready" } };
    }
    if (path === "/v1/transfer/event") {
      assert.equal(body.event, "complete");
      return { transfer: { transfer_id: TRANSFER_ID, phase: "completed" } };
    }
    throw new Error(`unexpected Hub call ${path}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "flt_test",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => ({ kid: KID, pub: "public-spki" }),
    verifyFleetStatement: async () => {
      order.push("verify-ticket");
      return validTicket({
        source: { kind: "device", id: DEVICE_ID },
        target: { kind: "tool", id: OPERATOR_ID },
      });
    },
    runtime,
  });
  await manager.start({
    source: { kind: "device", device_id: DEVICE_ID, path: "/remote/source.bin" },
    target: { kind: "tool", directory: "/local/inbox" },
  });
  const row = manager._rows.get(TRANSFER_ID);
  await row.done;
  assert.equal(row.phase, "completed");
  assert.equal(pollCount, 3);
  assert.ok(order.indexOf("verify-ticket") < order.indexOf("receive"));
  assert.deepEqual(instances[0].remoteDescription, { type: "offer", sdp: OFFER });
  assert.equal(instances[0].closed, true);
  assert.equal(targetClosed, 1);
  assertNoFileBytesInHub(calls);
});

test("tampered and expired tickets are rejected before any file byte is sent", async (t) => {
  await t.test("tampered signature", async () => {
    const result = await toolSourceScenario({ ticketResult: null });
    assert.equal(result.row.phase, "failed");
    assert.match(result.row.error, /ticket signature is invalid/i);
    assert.equal(result.sendCalls, 0);
    assert.deepEqual(result.calls.at(-1).body, {
      transfer_id: TRANSFER_ID,
      event: "fail",
      failure_code: "TICKET_REJECTED",
    });
  });

  await t.test("valid signature bound to another sid", async () => {
    const result = await toolSourceScenario({
      ticketResult: validTicket({ sid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }),
    });
    assert.equal(result.row.phase, "failed");
    assert.match(result.row.error, /does not match/i);
    assert.equal(result.sendCalls, 0);
    assert.equal(result.calls.at(-1).body.failure_code, "TICKET_REJECTED");
  });

  await t.test("expired signed statement", async () => {
    const result = await toolSourceScenario({
      ticketResult: validTicket({ iat: NOW - 30_000, exp: NOW - 1 }),
    });
    assert.equal(result.row.phase, "failed");
    assert.match(result.row.error, /expired or invalid/i);
    assert.equal(result.sendCalls, 0);
    assert.equal(result.calls.at(-1).body.failure_code, "TICKET_REJECTED");
  });
});

test("direct unavailable fails closed and never sends file bytes through Hub/WSS", async () => {
  const result = await toolSourceScenario({ rtcAvailable: false });
  assert.equal(result.row.phase, "direct_unavailable");
  assert.match(result.row.error, /no direct route/);
  assert.equal(result.sendCalls, 0);
  assert.equal(result.instances.length, 0, "do not even construct RTC after direct capability fails");
  assert.deepEqual(result.calls.at(-1).body, {
    transfer_id: TRANSFER_ID,
    event: "fail",
    failure_code: "DIRECT_UNAVAILABLE",
  });
  assertNoFileBytesInHub(result.calls);
});

test("device-to-device starts only Hub coordination and never reads Tool files", async () => {
  const calls = [];
  let localIO = 0;
  const manager = createFileTransferManager({
    hubPost: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    },
    token: "unused",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => {
      throw new Error("device-to-device coordinator must not verify a local ticket");
    },
    verifyFleetStatement: async () => {
      throw new Error("device-to-device coordinator must not verify a local ticket");
    },
    runtime: {
      openLocalSource: async () => {
        localIO += 1;
        throw new Error("unexpected local source read");
      },
      openLocalTarget: async () => {
        localIO += 1;
        throw new Error("unexpected local target read");
      },
      sendLocalFile: async () => {
        localIO += 1;
      },
      receiveLocalFile: async () => {
        localIO += 1;
      },
      loadPeerConnection: async () => {
        throw new Error("device-to-device coordinator must not create local RTC");
      },
    },
  });
  const started = await manager.start({
    source: { kind: "device", device_id: "device-a", path: "/srv/source.bin" },
    target: { kind: "device", device_id: "device-b", directory: "/srv/inbox" },
  });
  assert.equal(localIO, 0);
  assert.equal(manager._rows.get(TRANSFER_ID).done, null);
  assert.equal(started.local.phase, "pending");
  assert.deepEqual(calls, [
    {
      path: "/v1/transfer/create",
      body: {
        source: { kind: "device", id: "device-a" },
        target: { kind: "device", id: "device-b" },
        source_path: "/srv/source.bin",
        target_path: "/srv/inbox",
      },
    },
  ]);
});

test("Tool source resumes the same transfer near 37% with a fresh sid and discards the old ticket", async () => {
  const sid2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const manifest = { name: "source.bin", size: 100, sha256: FILE_SHA256 };
  const resumedPrefix = "cd".repeat(32);
  const tickets = {
    first: validTicket({ sid: SID, manifest }),
    second: validTicket({
      sid: sid2,
      manifest,
      resume: { offset: 37, prefix_sha256: resumedPrefix },
    }),
  };
  const calls = [];
  const instances = [];
  const offeredSids = [];
  const verifiedPayloads = [];
  let phase = "signaling";
  let sawInterrupted = false;
  let pollRound = 0;
  let sends = 0;
  let starts = 0;
  let interrupts = 0;
  let sourceClosed = 0;
  const source = {
    manifest,
    close: async () => {
      sourceClosed += 1;
    },
  };
  const ids = [SID, sid2];
  const runtime = {
    ...fakePeerRuntime({ instances }),
    randomUUID: () => ids.shift(),
    openLocalSource: async () => source,
    sendLocalFile: async ({ onProgress }) => {
      sends += 1;
      if (sends === 1) {
        onProgress({ sent: 37, committed: 37, size: 100 });
        throw Object.assign(new Error("file data channel closed"), { code: "interrupted" });
      }
      onProgress({ sent: 100, committed: 100, size: 100 });
      return { size: 100, sha256: FILE_SHA256 };
    },
  };
  const hubPost = async (pathname, body) => {
    calls.push({ path: pathname, body: structuredClone(body) });
    if (pathname === "/v1/transfer/create") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    }
    if (pathname === "/v1/transfer/authorize") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "authorizing" } };
    }
    if (pathname === "/v1/transfer/status") {
      if (phase === "interrupted" && sawInterrupted) phase = "signaling";
      else if (phase === "interrupted") sawInterrupted = true;
      return {
        transfer: {
          transfer_id: TRANSFER_ID,
          phase,
          ...(phase === "signaling"
            ? {
                resume: sawInterrupted
                  ? { offset: 37, prefix_sha256: resumedPrefix }
                  : { offset: 0, prefix_sha256: EMPTY_SHA256 },
              }
            : {}),
        },
      };
    }
    if (pathname === "/v1/rtc/config") return { available: true, stun_urls: [] };
    if (pathname === "/v1/transfer/signal") {
      offeredSids.push(body.sid);
      pollRound += 1;
      return { transfer: { transfer_id: TRANSFER_ID, phase: "signaling" } };
    }
    if (pathname === "/v1/transfer/signal/poll") {
      if (pollRound === 1) {
        return {
          items: [
            { kind: "ticket", statement: { payload: "first", sig: "valid" } },
            { kind: "signal", sid: SID, signal: { kind: "answer", seq: 1, sdp: ANSWER } },
          ],
        };
      }
      if (pollRound === 2) {
        pollRound += 1;
        return {
          items: [
            { kind: "ticket", statement: { payload: "first", sig: "valid" } },
            { kind: "signal", sid: sid2, signal: { kind: "answer", seq: 1, sdp: ANSWER } },
            { kind: "ticket", statement: { payload: "second", sig: "valid" } },
          ],
        };
      }
      return { items: [] };
    }
    if (pathname === "/v1/transfer/event") {
      if (body.event === "start") {
        starts += 1;
        phase = "transferring";
      } else if (body.event === "interrupt") {
        interrupts += 1;
        phase = "interrupted";
      } else {
        assert.notEqual(body.event, "fail");
      }
      return { transfer: { transfer_id: TRANSFER_ID, phase } };
    }
    throw new Error(`unexpected Hub call ${pathname}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "flt_test",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => ({ kid: KID, pub: "public-spki" }),
    verifyFleetStatement: async ({ payload }) => {
      verifiedPayloads.push(payload);
      return tickets[payload];
    },
    runtime,
  });
  await manager.start({
    source: { kind: "tool", path: "/local/source.bin" },
    target: { kind: "device", device_id: DEVICE_ID, directory: "/remote/inbox" },
  });
  const row = manager._rows.get(TRANSFER_ID);
  await row.done;

  assert.equal(row.phase, "completed");
  assert.deepEqual(row.progress, { sent: 100, committed: 100, size: 100 });
  assert.deepEqual(offeredSids, [SID, sid2]);
  assert.deepEqual(verifiedPayloads, ["first", "first", "second"]);
  assert.equal(interrupts, 1, "one failed RTC round reports interrupt once");
  assert.equal(starts, 2, "each new signed RTC round explicitly starts");
  assert.equal(sends, 2);
  assert.equal(sourceClosed, 1, "the source descriptor survives the interrupted round");
  assert.equal(instances.length, 2);
  assert.ok(instances.every((instance) => instance.closed));
  assert.ok(calls.every((call) => call.body.transfer_id === undefined || call.body.transfer_id === TRANSFER_ID));
  assertNoFileBytesInHub(calls);
});

test("Tool target reopens its verified 37% partial and re-authorizes before accepting a fresh offer", async () => {
  const sid2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const manifest = { name: "source.bin", size: 100, sha256: FILE_SHA256 };
  const resumedPrefix = "cd".repeat(32);
  const calls = [];
  const instances = [];
  const authorizations = [];
  const verifiedPayloads = [];
  let phase = "pending";
  let openCount = 0;
  let receiveCount = 0;
  let signalRound = 0;
  let pollStage = 0;
  let interruptCount = 0;
  const targets = [
    {
      committed: 0,
      manifest,
      prefixSHA256: async () => EMPTY_SHA256,
      close: async () => {},
      cancel: async () => {},
    },
    {
      committed: 37,
      manifest,
      prefixSHA256: async () => resumedPrefix,
      close: async () => {},
      cancel: async () => {},
    },
  ];
  const runtime = {
    ...fakePeerRuntime({ instances, channel: { readyState: "open", label: "fleet-file-v1" } }),
    openLocalTarget: async () => targets[openCount++],
    receiveLocalFile: async ({ target, onProgress }) => {
      receiveCount += 1;
      if (receiveCount === 1) {
        assert.equal(target, targets[0]);
        target.committed = 37;
        onProgress({ committed: 37, size: 100 });
        throw Object.assign(new Error("file data channel closed"), { code: "interrupted" });
      }
      assert.equal(target, targets[1]);
      onProgress({ committed: 100, size: 100 });
      return { path: "/local/inbox/source.bin", size: 100, sha256: FILE_SHA256 };
    },
  };
  const tickets = {
    first: validTicket({
      source: { kind: "device", id: DEVICE_ID },
      target: { kind: "tool", id: OPERATOR_ID },
      sid: SID,
      manifest,
    }),
    second: validTicket({
      source: { kind: "device", id: DEVICE_ID },
      target: { kind: "tool", id: OPERATOR_ID },
      sid: sid2,
      manifest,
      resume: { offset: 37, prefix_sha256: resumedPrefix },
    }),
  };
  const hubPost = async (pathname, body) => {
    calls.push({ path: pathname, body: structuredClone(body) });
    if (pathname === "/v1/transfer/create") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    }
    if (pathname === "/v1/transfer/signal/poll") {
      pollStage += 1;
      if (pollStage === 1) {
        return { items: [{ kind: "manifest", file: { ...manifest, chunkSize: FILE_CHUNK_BYTES } }] };
      }
      if (pollStage === 2) {
        return { items: [{ kind: "signal", sid: SID, signal: { kind: "offer", seq: 1, sdp: OFFER } }] };
      }
      if (pollStage === 3) {
        return { items: [{ kind: "ticket", statement: { payload: "first", sig: "valid" } }] };
      }
      if (pollStage === 4) {
        return {
          items: [
            { kind: "signal", sid: SID, signal: { kind: "offer", seq: 1, sdp: OFFER } },
            { kind: "ticket", statement: { payload: "first", sig: "valid" } },
            { kind: "signal", sid: sid2, signal: { kind: "offer", seq: 1, sdp: OFFER } },
          ],
        };
      }
      if (pollStage === 5) {
        return { items: [{ kind: "ticket", statement: { payload: "second", sig: "valid" } }] };
      }
      return { items: [] };
    }
    if (pathname === "/v1/transfer/authorize") {
      authorizations.push(body.preparation.resume);
      phase = "signaling";
      return { transfer: { transfer_id: TRANSFER_ID, phase } };
    }
    if (pathname === "/v1/rtc/config") return { available: true, stun_urls: [] };
    if (pathname === "/v1/transfer/signal") {
      signalRound += 1;
      assert.equal(body.sid, signalRound === 1 ? SID : sid2);
      return { transfer: { transfer_id: TRANSFER_ID, phase: "ready" } };
    }
    if (pathname === "/v1/transfer/status") {
      return { transfer: { transfer_id: TRANSFER_ID, phase } };
    }
    if (pathname === "/v1/transfer/event") {
      if (body.event === "interrupt") {
        interruptCount += 1;
        phase = "interrupted";
      } else if (body.event === "complete") {
        phase = "completed";
      } else {
        assert.notEqual(body.event, "fail");
      }
      return { transfer: { transfer_id: TRANSFER_ID, phase } };
    }
    throw new Error(`unexpected Hub call ${pathname}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "flt_test",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => ({ kid: KID, pub: "public-spki" }),
    verifyFleetStatement: async ({ payload }) => {
      verifiedPayloads.push(payload);
      return tickets[payload];
    },
    runtime,
  });
  await manager.start({
    source: { kind: "device", device_id: DEVICE_ID, path: "/remote/source.bin" },
    target: { kind: "tool", directory: "/local/inbox" },
  });
  const row = manager._rows.get(TRANSFER_ID);
  await row.done;

  assert.equal(row.phase, "completed");
  assert.equal(openCount, 2);
  assert.equal(receiveCount, 2);
  assert.equal(interruptCount, 1);
  assert.deepEqual(authorizations, [
    { offset: 0, prefix_sha256: EMPTY_SHA256 },
    { offset: 37, prefix_sha256: resumedPrefix },
  ]);
  assert.deepEqual(verifiedPayloads, ["first", "first", "second"]);
  assert.equal(signalRound, 2);
  assert.equal(instances.length, 2);
  assertNoFileBytesInHub(calls);
});

test("cancelling a Tool target closes RTC, removes its partial once, and never retries", async () => {
  const calls = [];
  const instances = [];
  let cancelCount = 0;
  let receiveStarted;
  const started = new Promise((resolve) => {
    receiveStarted = resolve;
  });
  const target = {
    committed: 0,
    manifest: MANIFEST,
    prefixSHA256: async () => EMPTY_SHA256,
    cancel: async () => {
      cancelCount += 1;
    },
    close: async () => {},
  };
  let pollCount = 0;
  const runtime = {
    ...fakePeerRuntime({ instances, channel: { readyState: "open", label: "fleet-file-v1" } }),
    openLocalTarget: async () => target,
    receiveLocalFile: async ({ signal }) => {
      receiveStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("file transfer cancelled"), { code: "cancelled" })),
          { once: true },
        );
      });
    },
  };
  const hubPost = async (pathname, body) => {
    calls.push({ path: pathname, body: structuredClone(body) });
    if (pathname === "/v1/transfer/create") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "pending", direct_only: true } };
    }
    if (pathname === "/v1/transfer/signal/poll") {
      pollCount += 1;
      if (pollCount === 1) {
        return { items: [{ kind: "manifest", file: { ...MANIFEST, chunkSize: FILE_CHUNK_BYTES } }] };
      }
      if (pollCount === 2) {
        return { items: [{ kind: "signal", sid: SID, signal: { kind: "offer", seq: 1, sdp: OFFER } }] };
      }
      if (pollCount === 3) {
        return { items: [{ kind: "ticket", statement: { payload: "ticket", sig: "valid" } }] };
      }
      return { items: [] };
    }
    if (pathname === "/v1/transfer/authorize") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "signaling" } };
    }
    if (pathname === "/v1/rtc/config") return { available: true, stun_urls: [] };
    if (pathname === "/v1/transfer/signal") {
      return { transfer: { transfer_id: TRANSFER_ID, phase: "ready" } };
    }
    if (pathname === "/v1/transfer/event") {
      assert.equal(body.event, "cancel");
      return { transfer: { transfer_id: TRANSFER_ID, phase: "cancelled" } };
    }
    throw new Error(`unexpected Hub call ${pathname}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "flt_test",
    operatorId: OPERATOR_ID,
    verifyTokenV1: async () => ({ kid: KID, pub: "public-spki" }),
    verifyFleetStatement: async () =>
      validTicket({
        source: { kind: "device", id: DEVICE_ID },
        target: { kind: "tool", id: OPERATOR_ID },
      }),
    runtime,
  });
  await manager.start({
    source: { kind: "device", device_id: DEVICE_ID, path: "/remote/source.bin" },
    target: { kind: "tool", directory: "/local/inbox" },
  });
  await started;
  const row = manager._rows.get(TRANSFER_ID);
  await manager.cancel(TRANSFER_ID);
  await row.done;

  assert.equal(row.phase, "cancelled");
  assert.equal(cancelCount, 1);
  assert.equal(instances[0].closed, true);
  assert.equal(calls.filter((call) => call.path === "/v1/transfer/event").length, 1);
  assertNoFileBytesInHub(calls);
});
