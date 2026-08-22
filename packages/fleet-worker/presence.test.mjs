import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEARTBEAT_WAIT_DEFAULT_MS,
  HEARTBEAT_WAIT_MAX_MS,
  agentVerFromBody,
  clampHeartbeatWaitMs,
  computerPublic,
} from "./src/presence.mjs";

test("heartbeat with version stores that agent_ver", () => {
  assert.equal(agentVerFromBody({ agent_ver: "0.2.8" }), "0.2.8");
  assert.equal(agentVerFromBody({ agent_ver: " 0.2.9 " }), "0.2.9");
});

test("heartbeat without version is compat — leave stored agentVer alone", () => {
  assert.equal(agentVerFromBody({}), undefined);
  assert.equal(agentVerFromBody(undefined), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "" }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "   " }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: null }), undefined);
});

test("computerPublic is the list_computers row and never leaks userId or IPs", () => {
  const row = computerPublic({
    id: "win-1",
    name: "MySuperPC",
    os: "windows",
    online: true,
    lastSeen: 2000,
    agentVer: "0.2.5",
    userId: "secret-user",
    ip: "10.0.0.8",
  });
  assert.deepEqual(row, {
    id: "win-1",
    name: "MySuperPC",
    os: "windows",
    online: true,
    lastSeen: 2000,
    agentVer: "0.2.5",
  });
  assert.equal(computerPublic({}), null);
  assert.equal(computerPublic(null), null);
});

test("heartbeat wait is short so an offline or mute client cannot hang the hub", () => {
  assert.equal(HEARTBEAT_WAIT_DEFAULT_MS, 3_000);
  assert.equal(HEARTBEAT_WAIT_MAX_MS, 10_000);
  assert.equal(clampHeartbeatWaitMs(undefined), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(0), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(80), 80);
  assert.equal(clampHeartbeatWaitMs(60_000), HEARTBEAT_WAIT_MAX_MS);
});
