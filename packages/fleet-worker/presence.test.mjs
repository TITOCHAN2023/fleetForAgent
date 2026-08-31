import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DEFAULT_UPDATE_BASE,
  DESKTOP_WAIT_MS,
  HEARTBEAT_WAIT_DEFAULT_MS,
  HEARTBEAT_WAIT_MAX_MS,
  advertisedUpdate,
  agentVerFromBody,
  archFromBody,
  checksumsURL,
  clampHeartbeatWaitMs,
  computerPublic,
  hasComputerUse,
  joinCaps,
  normalizeCaps,
  normalizePermit,
  parseChecksums,
  unsupportedCapBody,
} from "./src/presence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("advertisedUpdate is empty without a version", () => {
  assert.deepEqual(advertisedUpdate({}), {});
  assert.deepEqual(advertisedUpdate({ latestAgentVer: "  " }), {});
});

test("advertisedUpdate includes version, channel URL, and checksums URL", () => {
  const got = advertisedUpdate({ latestAgentVer: "0.3.2" });
  assert.equal(got.latest_agent_ver, "0.3.2");
  assert.equal(got.update_base, DEFAULT_UPDATE_BASE);
  assert.equal(got.update_checksums, checksumsURL(DEFAULT_UPDATE_BASE, "0.3.2"));
  assert.equal(got.update_checksums.endsWith("/checksums-0.3.2.txt"), true);
});

test("advertisedUpdate can inline checksums.txt so the client does not guess", () => {
  const got = advertisedUpdate({
    latestAgentVer: "0.3.2",
    updateBase: "http://127.0.0.1:9/dl",
    checksumsText: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  fleet-agent-linux-amd64.tar.gz\n",
  });
  assert.equal(got.update_base, "http://127.0.0.1:9/dl");
  assert.equal(got.update_checksums, "http://127.0.0.1:9/dl/checksums-0.3.2.txt");
  assert.equal(got.update_sums["fleet-agent-linux-amd64.tar.gz"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(parseChecksums("# skip\nnot-a-sum  x\n"), {});
});

test("heartbeat with version stores that agent_ver", () => {
  assert.equal(agentVerFromBody({ agent_ver: "0.2.8" }), "0.2.8");
  assert.equal(agentVerFromBody({ agent_ver: " 0.2.9 " }), "0.2.9");
});

test("agent version rejects control characters and oversized storage input", () => {
  assert.equal(agentVerFromBody({ agent_ver: "0.6.3\nforged" }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "x".repeat(65) }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "版本-0.6.3" }), "版本-0.6.3");
});

test("heartbeat without version is compat — leave stored agentVer alone", () => {
  assert.equal(agentVerFromBody({}), undefined);
  assert.equal(agentVerFromBody(undefined), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "" }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: "   " }), undefined);
  assert.equal(agentVerFromBody({ agent_ver: null }), undefined);
});

test("hello arch is stored; heartbeat without arch keeps the stored value", () => {
  assert.equal(archFromBody({ arch: "arm64" }), "arm64");
  assert.equal(archFromBody({ arch: " amd64 " }), "amd64");
  assert.equal(archFromBody({}), undefined);
  assert.equal(archFromBody(undefined), undefined);
  assert.equal(archFromBody({ arch: "" }), undefined);
  assert.equal(archFromBody({ arch: "   " }), undefined);
  assert.equal(archFromBody({ arch: null }), undefined);
});

test("computerPublic is the list_computers row and never leaks userId or IPs", () => {
  const row = computerPublic({
    id: "win-1",
    alias: "build-box",
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
    alias: "build-box",
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
  assert.match(slice, /resolveOwnedDevice/);
  assert.match(slice, /not found/);
  assert.ok(slice.indexOf("resolveOwnedDevice") < slice.indexOf("env.DEVICE.get"));
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
  const desktopDo = src.slice(src.indexOf('url.pathname === "/desktop"'), src.indexOf('url.pathname === "/heartbeat"'));
  assert.match(desktopDo, /NOT_READY/);
  assert.match(desktopDo, /Array\.isArray\(att\.caps\)/);
  const notReady = desktopDo.indexOf("NOT_READY");
  const unsup = desktopDo.indexOf("unsupportedCapBody");
  assert.ok(notReady !== -1 && unsup !== -1 && notReady < unsup);
});

test("heartbeat wait is short so an offline or mute client cannot hang the hub", () => {
  assert.equal(HEARTBEAT_WAIT_DEFAULT_MS, 3_000);
  assert.equal(HEARTBEAT_WAIT_MAX_MS, 10_000);
  assert.equal(clampHeartbeatWaitMs(undefined), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(0), HEARTBEAT_WAIT_DEFAULT_MS);
  assert.equal(clampHeartbeatWaitMs(80), 80);
  assert.equal(clampHeartbeatWaitMs(60_000), HEARTBEAT_WAIT_MAX_MS);
});
