import test from "node:test";
import assert from "node:assert/strict";

import { startAndWaitFileTransfer } from "./file-transfer-cli.mjs";
import { createFileTransferManager, createFileTransferPeerConfig } from "./file-transfer-rtc.mjs";

const plugin = {
  id: "fleet.transfer",
  version: "0.2.1",
  installable: true,
  runtime: "peer",
  actions: ["prepare_source", "prepare_target"],
  action_specs: {
    prepare_source: { runtime: "peer", role: "source" },
    prepare_target: { runtime: "peer", role: "target" },
  },
  peer_protocols: [{
    id: "fleet.transfer.v2",
    abi: "fleet.plugin.peer.v1",
    transport: "direct_ordered",
    approval: "both_once",
    roles: { source: "prepare_source", target: "prepare_target" },
  }],
  artifacts: [],
};

test("file transfer facade creates only a generic plugin peer session", async () => {
  const calls = [];
  const hubPost = async (pathname, body) => {
    calls.push({ pathname, body });
    if (pathname === "/v1/plugin-peer-session/create") {
      return {
        session: {
          session_id: body.session_id,
          phase: "waiting_approval",
          protocol: plugin.peer_protocols[0],
          round: { id: "815739bb-bca5-48a9-aeee-2c16bbfe11de", no: 1 },
          signal_sides: { initiator: "source", responder: "target" },
        },
      };
    }
    if (pathname === "/v1/plugin-peer-session/inbox/poll") return new Promise(() => {});
    throw new Error(`unexpected ${pathname}`);
  };
  const manager = createFileTransferManager({
    hubPost,
    token: "test",
    operatorId: "tool-1",
    verifyTokenV1: async () => ({}),
    verifyFleetStatement: async () => ({}),
    catalog: [plugin],
    runtime: { launchPlugin: async () => assert.fail("plugin must wait for an applied prepare") },
  });
  const started = await manager.start({
    source: { kind: "tool", path: "/tmp/source.bin" },
    target: { kind: "device", device_id: "device-1", directory: "/srv/incoming" },
  });
  assert.match(started.transfer_id, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[0].pathname, "/v1/plugin-peer-session/create");
  assert.equal(calls[0].body.session_id, started.transfer_id);
  assert.equal(calls[0].body.initiator, "source");
  assert.deepEqual(calls[0].body.source.input, { path: "/tmp/source.bin", chunk_size: 32768 });
  assert.equal(calls[0].body.target.input.directory, "/srv/incoming");
  assert.equal(calls[0].body.target.input.transfer_id, started.transfer_id);
  assert.match(calls[0].body.target.input.source, /^[0-9a-f]{64}$/);
  assert.equal("name" in calls[0].body.target.input, false);
  assert.ok(calls.every(({ pathname }) => !pathname.startsWith("/v1/transfer/")));
});

test("an already-aborted stdio call cannot create a local peer session", async () => {
  let hubCalls = 0;
  const manager = createFileTransferManager({
    hubPost: async () => { hubCalls += 1; throw new Error("unexpected Hub call"); },
    token: "test",
    operatorId: "tool-1",
    verifyTokenV1: async () => ({}),
    verifyFleetStatement: async () => ({}),
    catalog: [plugin],
    runtime: { launchPlugin: async () => assert.fail("plugin must not launch") },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => manager.start({
      source: { kind: "tool", path: "/tmp/source.bin" },
      target: { kind: "device", device_id: "device-1", directory: "/srv/incoming" },
    }, { signal: controller.signal }),
    (error) => error?.code === "cancelled",
  );
  assert.equal(hubCalls, 0);
});

test("device-only facade uses the same unlinkable transfer binding shape", async () => {
  const sessionId = "e3407bcb-732a-45ee-80e2-0f95761b5b13";
  const config = await createFileTransferPeerConfig({
    source: { kind: "device", device_id: "source-a", path: "/srv/source.bin" },
    target: { kind: "device", device_id: "target-b", directory: "/srv/incoming", name: "copy.bin" },
  }, { plugin, sessionId });
  assert.equal(config.session_id, sessionId);
  assert.deepEqual(config.source.input, { path: "/srv/source.bin", chunk_size: 32768 });
  assert.deepEqual(config.target.input, {
    directory: "/srv/incoming",
    name: "copy.bin",
    transfer_id: sessionId,
    source: "f85838364046314080c9cedcbd26bb1fa2b1ece1d02941e0d8638fadde908024",
  });
});

test("CLI helper owns the Tool endpoint until the session is terminal", async () => {
  let finish;
  let settled = false;
  const manager = {
    start: async () => ({ transfer_id: "session-1", phase: "waiting_approval" }),
    wait: () => new Promise((resolve) => { finish = resolve; }),
  };
  const running = startAndWaitFileTransfer(manager, {}).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "CLI returned while its local plugin/PeerConnection was still live");
  finish({ transfer_id: "session-1", phase: "completed" });
  assert.equal((await running).phase, "completed");
});

test("CLI helper propagates cancellation while start is pending and never enters wait", async () => {
  const controller = new AbortController();
  const cancelled = Object.assign(new Error("start cancelled"), { code: "cancelled" });
  let startSignal;
  let waitCalls = 0;
  const manager = {
    start: (_input, { signal } = {}) => {
      startSignal = signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(cancelled);
          return;
        }
        signal?.addEventListener("abort", () => reject(cancelled), { once: true });
      });
    },
    wait: async () => {
      waitCalls += 1;
      assert.fail("wait must not run when start is cancelled");
    },
  };

  const running = startAndWaitFileTransfer(manager, {}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startSignal, controller.signal);
  controller.abort();
  await assert.rejects(running, (error) => error === cancelled && error.code === "cancelled");
  assert.equal(waitCalls, 0);
});

test("CLI helper rejects a failed terminal transfer so the process exits non-zero", async () => {
  const manager = {
    start: async () => ({ transfer_id: "session-1", phase: "waiting_approval" }),
    wait: async () => ({
      transfer_id: "session-1",
      phase: "failed",
      local: { phase: "failed", failure_code: "INVALID_TICKET", error: "ticket rejected" },
    }),
  };
  await assert.rejects(
    () => startAndWaitFileTransfer(manager, {}),
    (error) => error?.code === "INVALID_TICKET" && /ticket rejected/.test(error.message),
  );
});
