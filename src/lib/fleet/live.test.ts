import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachDevice,
  cancelHeartbeatWait,
  detachDevice,
  getAgentVer,
  isOnline,
  kickUser,
  noteHeartbeat,
  ownerOf,
  putAgentVer,
  resetLive,
  sendToDevice,
  waitNextHeartbeat,
} from "./live";

function fakeWs() {
  const sent: string[] = [];
  let readyState = 1;
  let closeCode: number | undefined;
  return {
    sent,
    get readyState() {
      return readyState;
    },
    send(data: string) {
      sent.push(data);
    },
    close(code?: number) {
      readyState = 3;
      closeCode = code;
    },
    get closeCode() {
      return closeCode;
    },
  };
}

test("two accounts on one node cannot see each other's sockets", () => {
  resetLive();
  const a = fakeWs();
  const b = fakeWs();
  attachDevice("user-a", "dev-1", a);
  attachDevice("user-b", "dev-2", b);
  assert.equal(sendToDevice("user-a", "dev-2", { type: "run" }), false);
  assert.equal(sendToDevice("user-a", "dev-1", { type: "run" }), true);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.equal(ownerOf("dev-1"), "user-a");
});

test("reset kicks every live socket for that account", () => {
  resetLive();
  const a = fakeWs();
  const b = fakeWs();
  attachDevice("user-a", "dev-1", a);
  attachDevice("user-a", "dev-2", b);
  kickUser("user-a");
  assert.equal(isOnline("dev-1"), false);
  assert.equal(isOnline("dev-2"), false);
  assert.equal(a.closeCode, 1008);
  assert.equal(b.closeCode, 1008);
});

test("waitNextHeartbeat resolves on noteHeartbeat and times out without hanging", async () => {
  resetLive();
  const pending = waitNextHeartbeat("dev-1", 1000);
  noteHeartbeat("dev-1");
  assert.equal(await pending, true);

  const t0 = Date.now();
  const missed = await waitNextHeartbeat("dev-1", 40);
  assert.equal(missed, false);
  assert.ok(Date.now() - t0 < 200, `wait hung ${Date.now() - t0}ms`);
});

test("cancelHeartbeatWait drops a waiter without waiting for the timer", async () => {
  resetLive();
  const t0 = Date.now();
  const pending = waitNextHeartbeat("dev-1", 1000);
  cancelHeartbeatWait("dev-1");
  assert.equal(await pending, false);
  assert.ok(Date.now() - t0 < 200, `cancel hung ${Date.now() - t0}ms`);
});

test("putAgentVer keeps stored on undefined and overwrites on hello empty", () => {
  resetLive();
  putAgentVer("dev-1", "0.2.5");
  putAgentVer("dev-1", undefined);
  assert.equal(getAgentVer("dev-1"), "0.2.5");
  putAgentVer("dev-1", "");
  assert.equal(getAgentVer("dev-1"), undefined);
});

test("new socket replaces the old one on the same device", () => {
  resetLive();
  const oldWs = fakeWs();
  const next = fakeWs();
  attachDevice("user-a", "dev-1", oldWs);
  attachDevice("user-a", "dev-1", next);
  assert.equal(oldWs.closeCode, 1012);
  assert.equal(isOnline("dev-1"), true);
  detachDevice("dev-1", next);
  assert.equal(isOnline("dev-1"), false);
});
