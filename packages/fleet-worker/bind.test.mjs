import assert from "node:assert/strict";
import { test } from "node:test";
import { canClaimDevice, deviceOwnerConflict } from "./src/bind.mjs";

test("unclaimed device can be bound by any signed-in actor", () => {
  assert.equal(canClaimDevice(undefined, "user-a"), true);
  assert.equal(canClaimDevice("", "user-a"), true);
  assert.equal(canClaimDevice(null, "user-a"), true);
});

test("owner can reconnect; another account cannot", () => {
  assert.equal(canClaimDevice("user-a", "user-a"), true);
  assert.equal(canClaimDevice("user-a", "user-b"), false);
});

test("unsigned actor cannot claim", () => {
  assert.equal(canClaimDevice("", ""), false);
  assert.equal(canClaimDevice("user-a", ""), false);
  assert.equal(canClaimDevice(undefined, undefined), false);
});

test("HUB_TOKEN super id cannot steal a bound device over WebSocket", () => {
  assert.equal(canClaimDevice("user-a", "*"), false);
  assert.equal(canClaimDevice("*", "*"), true);
  assert.equal(canClaimDevice("*", "user-a"), false);
});

test("upsert conflict only when both sides set different owners", () => {
  assert.equal(deviceOwnerConflict("user-a", "user-b"), true);
  assert.equal(deviceOwnerConflict("user-a", "*"), true);
  assert.equal(deviceOwnerConflict("user-a", "user-a"), false);
  assert.equal(deviceOwnerConflict("user-a", ""), false);
  assert.equal(deviceOwnerConflict("", "user-b"), false);
  assert.equal(deviceOwnerConflict(undefined, "user-b"), false);
});
