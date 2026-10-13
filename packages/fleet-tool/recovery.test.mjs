import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openRecovery } from "./recovery.mjs";
import { createOperator, operationCorr, operationInput, formatMcpText, isFinishedResult } from "./operator.mjs";

const binding = { url: "https://test.invalid", token: "private-test-secret" };
function checkpoint(t) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "session.json");
}

test("recovery is opt-in, private, locked and bound to the credential generation", (t) => {
  assert.equal(openRecovery(undefined, binding), null);
  assert.throws(() => openRecovery("relative.json", binding), /absolute/);
  const path = checkpoint(t);
  const first = openRecovery(path, binding);
  try {
    assert.throws(() => openRecovery(path, binding), /EEXIST/);
    first.save({ lastUsed: "device-1", corrByDevice: { "device-1": "job-1" }, lastCwd: "/workspace", token: binding.token, command: "private-command", stdout: "private-output" });
    const data = readFileSync(path, "utf8");
    assert.doesNotMatch(data, /private-test-secret|private-command|private-output/);
  } finally { first.close(); }
  const resumed = openRecovery(path, binding);
  assert.equal(resumed.fingerprint, first.fingerprint);
  assert.equal(resumed.state.lastUsed, "device-1");
  assert.equal(resumed.state.corrByDevice["device-1"], "job-1");
  resumed.close();
  assert.throws(() => openRecovery(path, { ...binding, token: "rotated" }), /different hub or token/);
  assert.throws(() => openRecovery(path, { ...binding, url: "https://other.invalid" }), /different hub or token/);
});

test("different checkpoint paths never share operator identity", (t) => {
  const a = openRecovery(checkpoint(t), binding);
  const b = openRecovery(checkpoint(t), binding);
  assert.notEqual(a.fingerprint, b.fingerprint);
  a.close(); b.close();
});

test("CLI keeps its argument validation while stdio owns the inherited session path", (t) => {
  const path = checkpoint(t);
  const saved = openRecovery(path, binding);
  try {
    const output = spawnSync(process.execPath, [fileURLToPath(new URL("./index.mjs", import.meta.url)), "run"], {
      env: { ...process.env, FLEET_URL: binding.url, FLEET_TOKEN: binding.token, FLEET_SESSION_PATH: path }, encoding: "utf8",
    });
    assert.equal(output.status, 1);
    assert.match(output.stderr, /usage: run/);
    assert.doesNotMatch(output.stderr, /locked|EEXIST/);
    assert.throws(() => openRecovery(path, binding), /locked/);
  } finally { saved.close(); }
});

test("unsafe checkpoint permissions and symlinks fail closed", { skip: process.platform === "win32" }, (t) => {
  const path = checkpoint(t);
  const saved = openRecovery(path, binding); saved.close();
  chmodSync(path, 0o644);
  assert.throws(() => openRecovery(path, binding), /unsafe/);
  const linked = checkpoint(t);
  symlinkSync(path, linked);
  assert.throws(() => openRecovery(linked, binding), /unsafe/);
});

test("WS and RTC operation IDs are deterministic, case normalized and operator-scoped", async () => {
  const id = "e9301640-c8b3-4d84-9b44-12c458d08e8c";
  assert.equal(await operationCorr("operator-1", id), await operationCorr("operator-1", id.toUpperCase()));
  assert.notEqual(await operationCorr("operator-1", id), await operationCorr("operator-2", id));
  await assert.rejects(operationCorr("operator-1", "../../somewhere"), /UUID/);
});

test("lost run response saves the query handle before sending and never retries", async (t) => {
  const path = checkpoint(t);
  const saved = openRecovery(path, binding);
  let dispatches = 0;
  const op = createOperator({ fingerprint: saved.fingerprint, state: saved.state, saveState: saved.save, rpc: async (route, body) => {
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["operation_recovery_v1"] };
    assert.equal(route, "/v1/run");
    dispatches++;
    assert.equal(JSON.parse(readFileSync(path)).state.corrByDevice["device-1"], await operationCorr(saved.fingerprint, body.request_id));
    throw new Error("response lost after device execution");
  } });
  await assert.rejects(op.callTool("run", { device_id: "device-1", command: "echo safe", wait_ms: 0 }), /response lost/);
  saved.close();
  const resumed = openRecovery(path, binding);
  const recoveryCalls = [];
  const second = createOperator({ state: resumed.state, fingerprint: resumed.fingerprint, saveState: resumed.save, rpc: async (route, body) => {
    recoveryCalls.push(route);
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["operation_recovery_v1"] };
    if (route === "/v1/get_result") return { corr: body.corr, ok: true, exit_code: 0, stdout: "completed once" };
    if (route === "/v1/read_screen") return { screen: { pane_id: `pane-${body.corr}`, running: false } };
    assert.fail(`unsafe recovery route ${route}`);
  } });
  const result = await second.callTool("recover_session", {});
  assert.equal(result.result.stdout, "completed once");
  assert.equal(result.replayed, false);
  assert.equal(dispatches, 1);
  assert.deepEqual(recoveryCalls, ["/v1/get_computer", "/v1/get_result", "/v1/read_screen"]);
  resumed.close();
});

test("unknown is not still-running or success, and wait never reissues run", async () => {
  const routes = [];
  const unknown = { status: "unknown", error: "Outcome unknown; inspect first" };
  const op = createOperator({ state: { lastUsed: "device-1", corrByDevice: { "device-1": "job-1" } }, rpc: async (route) => {
    routes.push(route);
    if (route === "/v1/get_computer") return { id: "device-1" };
    return unknown;
  } });
  const result = await op.callTool("wait", {});
  assert.equal(result.status, "unknown");
  assert.equal(isFinishedResult(result), true);
  assert.equal(formatMcpText("wait", result), unknown.error);
  assert.equal(routes.includes("/v1/run"), false);
});

test("old devices keep the old run contract; explicit recovery fails before dispatch", async () => {
  const runs = [];
  const op = createOperator({ fingerprint: "operator-1", rpc: async (route, body) => {
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["shell"] };
    runs.push(body); return { corr: "legacy-job", status: "running" };
  } });
  await op.callTool("run", { device_id: "device-1", command: "echo safe", wait_ms: 0 });
  assert.equal(Object.hasOwn(runs[0], "request_id"), false);
  await assert.rejects(op.callTool("run", { device_id: "device-1", command: "echo safe", request_id: "e9301640-c8b3-4d84-9b44-12c458d08e8c" }), /update the Agent/);
  assert.equal(runs.length, 1);
});

test("checkpoint write failure blocks command dispatch", async () => {
  let runs = 0;
  const op = createOperator({ saveState: () => { throw new Error("disk full"); }, rpc: async (route) => {
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["operation_recovery_v1"] };
    runs++; return {};
  } });
  await assert.rejects(op.callTool("run", { device_id: "device-1", command: "echo safe" }), /disk full/);
  assert.equal(runs, 0);
});

test("recovered cwd metadata is machine-local, not a shared working environment", async () => {
  const op = createOperator({ state: { lastUsed: "device-1", lastCwd: "/work/a", cwdByDevice: { "device-1": "/work/a", "device-2": "C:\\work\\b" } }, rpc: async (_, body) => ({ id: body.device_id }) });
  await op.callTool("set_computer", { device_id: "device-2" });
  assert.equal((await op.callTool("get_current_computer", {})).cwd, "C:\\work\\b");
});

test("a cached completion for different input must never become this command's success", async () => {
  const originalHash = await operationInput("original command");
  const request_id = "e9301640-c8b3-4d84-9b44-12c458d08e8c";
  const corr = await operationCorr("operator-a", request_id);
  const op = createOperator({ fingerprint:"operator-a", rpc:async (route) => {
    if (route === "/v1/get_computer") return {id:"device-1", caps:["operation_recovery_v1"]};
    if (route === "/v1/run") return {corr, status:"running"};
    return {corr, ok:true, exit_code:0, stdout:"original output", input_hash:originalHash};
  } });
  await assert.rejects(op.callTool("run", {device_id:"device-1", command:"different command", request_id}), /already used with different command/);
});

test("remote MCP retains the request proof even when its adapter owns the fingerprint", async () => {
  const request_id = "e9301640-c8b3-4d84-9b44-12c458d08e8c";
  const corr = await operationCorr("remote-mcp-operator", request_id);
  const calls = [];
  const rpc = async (route, body) => {
    calls.push({ route, body });
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["operation_recovery_v1"] };
    if (route === "/v1/run") return { corr, status: "running" };
    if (route === "/v1/get_result") return { corr, ok: true, exit_code: 0 };
    return { screen: null };
  };
  const first = createOperator({ rpc });
  await first.callTool("run", { device_id: "device-1", command: "echo safe", request_id, wait_ms: 0 });
  const resumed = createOperator({ rpc, state: first.getState() });
  await resumed.callTool("recover_session", {});
  const query = calls.find(call => call.route === "/v1/get_result");
  assert.equal(query.body.request_id, request_id);
  assert.equal(query.body.corr, corr);
  assert.equal(calls.filter(call => call.route === "/v1/run").length, 1);
});

test("invalid explicit request IDs fail before command dispatch", async () => {
  let runs = 0;
  const operator = createOperator({ rpc: async (route) => {
    if (route === "/v1/get_computer") return { id: "device-1", caps: ["operation_recovery_v1"] };
    runs++; return {};
  } });
  for (const request_id of ["", false, 0]) {
    await assert.rejects(operator.callTool("run", { device_id: "device-1", command: "echo safe", request_id }), /UUID/);
  }
  assert.equal(runs, 0);
});

test("fresh capability lookup invalidates a previously supported recovery device", async () => {
  let caps = ["operation_recovery_v1"], runs = 0;
  const operator = createOperator({ rpc: async (route) => {
    if (route === "/v1/get_computer") return { id: "device-1", caps };
    runs++; return {};
  } });
  await operator.callTool("set_computer", { device_id: "device-1" });
  caps = ["shell"];
  await operator.callTool("get_computer", {});
  await assert.rejects(operator.callTool("run", { command: "echo safe", request_id: "e9301640-c8b3-4d84-9b44-12c458d08e8c" }), /update the Agent/);
  assert.equal(runs, 0);
});
