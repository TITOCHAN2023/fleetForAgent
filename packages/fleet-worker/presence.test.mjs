import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DESKTOP_WAIT_MS,
  HEARTBEAT_WAIT_DEFAULT_MS,
  HEARTBEAT_WAIT_MAX_MS,
  agentVerFromBody,
  clampHeartbeatWaitMs,
  computerPublic,
  hasComputerUse,
  joinCaps,
  normalizeCaps,
  normalizePermit,
  unsupportedCapBody,
} from "./src/presence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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
    caps: [],
    permit: null,
  });
  assert.equal(computerPublic({}), null);
  assert.equal(computerPublic(null), null);
});

test("worker heartbeat 404s a missing catalog row before DeviceDO offline", () => {
  const src = readFileSync(join(here, "src/index.ts"), "utf8");
  const start = src.indexOf('url.pathname === "/v1/heartbeat"');
  assert.notEqual(start, -1);
  const deviceDo = src.indexOf('url.pathname === "/heartbeat" && request.method === "POST"');
  assert.ok(deviceDo > start);
  const slice = src.slice(start, deviceDo);
  assert.match(slice, /computerPublic/);
  assert.match(slice, /not found/);
  assert.ok(slice.indexOf("computerPublic") < slice.indexOf("env.DEVICE.get"));
});

test("caps split from SQL text and stay arrays on the public row", () => {
  assert.deepEqual(normalizeCaps(undefined), []);
  assert.deepEqual(normalizeCaps("shell,pane,computer_use"), ["shell", "pane", "computer_use"]);
  assert.deepEqual(normalizeCaps(["shell", "pane"]), ["shell", "pane"]);
  assert.equal(joinCaps(["shell", "pane", "computer_use"]), "shell,pane,computer_use");
  assert.equal(normalizePermit("ask"), "ask");
  assert.equal(normalizePermit(""), null);
  assert.equal(normalizePermit("maybe"), null);
  const row = computerPublic({
    id: "win-1",
    name: "pc",
    os: "windows",
    online: true,
    lastSeen: 1,
    caps: "shell,pane,computer_use",
    permit: "ask",
  });
  assert.deepEqual(row.caps, ["shell", "pane", "computer_use"]);
  assert.equal(row.permit, "ask");
  assert.equal(hasComputerUse(row), true);
  assert.equal(hasComputerUse({ caps: ["shell", "pane"] }), false);
  const miss = unsupportedCapBody({ agentVer: "0.2.10", os: "darwin" });
  assert.equal(miss.code, "UNSUPPORTED_CAP");
  assert.equal(miss.os, "darwin");
  assert.equal(DESKTOP_WAIT_MS, 8_000);
});

test("worker desktop HTTP 409s missing cap before DeviceDO send", () => {
  const src = readFileSync(join(here, "src/index.ts"), "utf8");
  assert.match(src, /\/v1\/desktop_screenshot/);
  assert.match(src, /\/v1\/desktop_action/);
  assert.match(src, /unsupportedCapBody/);
  assert.match(src, /hasComputerUse/);
  const shot = src.indexOf('url.pathname === "/v1/desktop_screenshot"');
  const device = src.indexOf('url.pathname === "/desktop"');
  assert.notEqual(shot, -1);
  assert.notEqual(device, -1);
  assert.ok(shot < device);
  assert.match(src, /parsed\.type === "desktop"/);
  const desktopHandler = src.slice(src.indexOf('if (parsed.type === "desktop")'), src.indexOf('if (parsed.type === "desktop")') + 400);
  assert.equal(desktopHandler.includes("storage.put"), false);
});

test("heartbeat wait is short so an offline or mute client cannot hang the hub", () => {
  assert.equal(HEARTBEAT_WAIT_DEFAULT_MS, 3_000);
  assert.equal(HEARTBEAT_WAIT_MAX_MS, 10_000);
  assert.equal(clampHeartbeatWaitMs(undefined), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(0), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(80), 80);
  assert.equal(clampHeartbeatWaitMs(60_000), HEARTBEAT_WAIT_MAX_MS);
});
