import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachDevice,
  detachDevice,
  isOnline,
  kickUser,
  ownerOf,
  resetLive,
  sendToDevice,
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
