import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionBook } from "../fleet-worker/src/session.mjs";
import {
  CWD_MARK,
  FLEET_VERSION,
  MISSING_DEVICE_MESSAGE,
  RUN_WAIT_DEFAULT_MS,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  WAIT_POLL_MS,
  WAIT_TOOL_DEFAULT_MS,
  buildPrompts,
  buildTools,
  clampWaitMs,
  createOperator,
  getPrompt,
  MCP_INSTRUCTIONS,
  FLEET_OPERATOR_HEADER,
  fleetHubHeaders,
  fleetResultMeta,
  formatMcpText,
  applyCliDevFlag,
  isFleetDev,
  newOperatorFingerprint,
  officialPlugin,
  publicOfficialPlugins,
  isFinishedResult,
  measureHubFetch,
  parseOptionalMs,
  resultTransport,
  shQuote,
  stripSessionMeta,
  unwrapTimedRpc,
  wrapTransportRpc,
  wrapSessionCommand,
} from "./operator.mjs";

function assertSentCommand(sent, userCommand) {
  assert.equal(sent, userCommand);
}

function mockRpc(handlers) {
  const calls = [];
  async function rpc(path, body) {
    calls.push({ path, body });
    const fn = handlers[path];
    if (!fn) throw new Error(`unexpected rpc ${path}`);
    return fn(body, calls);
  }
  return { rpc, calls };
}

function clock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
}

test("clampWaitMs is 0–30s (MCP-call budget, not a kill timeout)", () => {
  assert.equal(WAIT_DEFAULT_MS, 0);
  assert.equal(RUN_WAIT_DEFAULT_MS, WAIT_MAX_MS);
  assert.equal(WAIT_MAX_MS, 30_000);
  assert.equal(clampWaitMs(0), 0);
  assert.equal(clampWaitMs(-5), 0);
  assert.equal(clampWaitMs(500), 500);
  assert.equal(clampWaitMs(30_000), 30_000);
  assert.equal(clampWaitMs(60_000), WAIT_MAX_MS);
  assert.equal(clampWaitMs(5 * 60 * 1000), WAIT_MAX_MS);
  assert.equal(clampWaitMs("nope"), 0);
});

test("parseOptionalMs keeps omitted and 0 distinct", () => {
  assert.equal(parseOptionalMs(undefined, "wait_ms"), null);
  assert.equal(parseOptionalMs(null, "wait_ms"), null);
  assert.equal(parseOptionalMs("", "wait_ms"), null);
  assert.equal(parseOptionalMs(0, "wait_ms"), 0);
  assert.equal(parseOptionalMs("0", "wait_ms"), 0);
  assert.equal(clampWaitMs(parseOptionalMs(undefined, "wait_ms") ?? RUN_WAIT_DEFAULT_MS), WAIT_MAX_MS);
  assert.equal(clampWaitMs(parseOptionalMs(0, "wait_ms") ?? RUN_WAIT_DEFAULT_MS), 0);
  assert.equal(clampWaitMs(parseOptionalMs(undefined, "wait_ms") ?? WAIT_DEFAULT_MS), 0);
});

test("isFinishedResult treats pending/running as not done", () => {
  assert.equal(isFinishedResult({ status: "pending", corr: "c" }), false);
  assert.equal(isFinishedResult({ status: "running", pane_id: "p" }), false);
  assert.equal(isFinishedResult({ status: "done", ok: true }), true);
  assert.equal(isFinishedResult({ ok: true, exit_code: 0 }), true);
});

test("existing five tools remain; device_id stays in schemas and is optional", () => {
  const tools = buildTools();
  const names = tools.map((t) => t.name);
  for (const n of ["list_computers", "get_computer", "heartbeat", "run", "get_result", "read_screen", "type"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(names.includes("wait"));
  assert.ok(names.includes("set_computer"));
  assert.ok(names.includes("get_current_computer"));

  for (const n of ["get_computer", "heartbeat", "run", "get_result", "wait", "read_screen", "type"]) {
    const t = tools.find((x) => x.name === n);
    assert.equal(typeof t.inputSchema.properties.device_id, "object", n);
    assert.equal((t.inputSchema.required ?? []).includes("device_id"), false, n);
  }
  const set = tools.find((x) => x.name === "set_computer");
  assert.deepEqual(set.inputSchema.required, ["device_id"]);
  assert.ok(set.inputSchema.properties.device_id);
  assert.deepEqual(tools.find((x) => x.name === "run").inputSchema.required, ["command"]);
  for (const n of ["get_computer", "heartbeat", "run", "get_result", "wait", "read_screen", "type"]) {
    const t = tools.find((x) => x.name === n);
    assert.equal(t.inputSchema.properties.corr, undefined, n);
    assert.equal(t.inputSchema.properties.fingerprint, undefined, n);
    assert.equal(t.inputSchema.properties.operator, undefined, n);
    assert.equal((t.inputSchema.required ?? []).includes("corr"), false, n);
  }
  assert.deepEqual(tools.find((x) => x.name === "get_result").inputSchema.required ?? [], []);
  assert.deepEqual(tools.find((x) => x.name === "wait").inputSchema.required ?? [], []);

  for (const n of ["run", "get_result", "wait"]) {
    const w = tools.find((x) => x.name === n).inputSchema.properties.wait_ms;
    assert.equal(w.maximum, WAIT_MAX_MS, n);
    assert.equal(w.minimum, 0, n);
    assert.match(w.description, /30000|30s/, n);
    assert.match(w.description, /never kills/i, n);
  }
  assert.equal(tools.find((x) => x.name === "run").inputSchema.properties.wait_ms.default, RUN_WAIT_DEFAULT_MS);
  assert.equal(tools.find((x) => x.name === "get_result").inputSchema.properties.wait_ms.default, WAIT_DEFAULT_MS);
  assert.equal(tools.find((x) => x.name === "wait").inputSchema.properties.wait_ms.default, WAIT_TOOL_DEFAULT_MS);
});

test("MCP prompts cover generate/reset and token anatomy", () => {
  const names = buildPrompts().map((p) => p.name);
  assert.deepEqual(names, ["hub_token", "hub_token_anatomy"]);
  const mint = getPrompt("hub_token");
  assert.match(mint.messages[0].content.text, /Reset token/);
  assert.match(mint.messages[0].content.text, /signed notice/);
  assert.match(mint.messages[0].content.text, /RTC session/);
  const anatomy = getPrompt("hub_token_anatomy");
  assert.match(anatomy.messages[0].content.text, /flt_1\.<payload>\.<sig>/);
  assert.match(anatomy.messages[0].content.text, /Fleet-OAEP/);
  assert.match(anatomy.messages[0].content.text, /RSA-2048/);
  assert.equal(getPrompt("nope"), null);
  assert.match(MCP_INSTRUCTIONS, /flt_1/);
});

test("run wait_ms omitted waits and returns the finished payload", async () => {
  const time = clock();
  let peeks = 0;
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c1", status: "running" }),
    "/v1/get_result": () => {
      peeks += 1;
      if (peeks < 3) return { status: "pending", corr: "c1" };
      return { status: "done", corr: "c1", ok: true, exit_code: 0, stdout: "/Users/bytedance" };
    },
  });
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep });
  const out = await op.callTool("run", { device_id: "mac-1", command: "pwd" });
  assert.equal(out.corr, "c1");
  assert.equal(out.status, "done");
  assert.equal(out.stdout, "/Users/bytedance");
  assert.equal(out.ok, true);
  assert.equal(out.device_id, "mac-1");
  assert.ok(peeks >= 3);
  assert.deepEqual(
    calls.filter((c) => c.path === "/v1/run").map((c) => c.path),
    ["/v1/run"],
  );
  assert.ok(calls.some((c) => c.path === "/v1/get_result"));
  assert.equal("wait_ms" in calls[0].body, false);
  assert.ok(calls.filter((c) => c.path === "/v1/get_result").every((c) => !("wait_ms" in c.body)));
  assert.ok(calls.filter((c) => c.path === "/v1/get_result").every((c) => c.body.corr === "c1"));
  assertSentCommand(calls[0].body.command, "pwd");
});

test("run wait_ms=0 is immediate corr and does not poll get_result", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c1b", status: "running" }),
  });
  const t0 = Date.now();
  const zero = await createOperator({ rpc }).callTool("run", {
    device_id: "mac-1",
    command: "uname",
    wait_ms: 0,
  });
  assert.ok(Date.now() - t0 < 50);
  assert.equal(zero.corr, "c1b");
  assert.equal(zero.status, "running");
  assert.equal(zero.device_id, "mac-1");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v1/run"],
  );
  assert.equal("wait_ms" in calls[0].body, false);
  assertSentCommand(calls[0].body.command, "uname");
});

test("run wait_ms returns the full result when get_result finishes", async () => {
  const time = clock();
  let peeks = 0;
  const { rpc } = mockRpc({
    "/v1/run": () => ({ corr: "c2", status: "running" }),
    "/v1/get_result": () => {
      peeks += 1;
      if (peeks < 3) return { status: "pending", corr: "c2" };
      return { status: "done", corr: "c2", ok: true, exit_code: 0, stdout: "hi" };
    },
  });
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep });
  const out = await op.callTool("run", { device_id: "mac-1", command: "echo hi", wait_ms: 5000 });
  assert.equal(out.status, "done");
  assert.equal(out.stdout, "hi");
  assert.equal(out.ok, true);
  assert.equal(out.device_id, "mac-1");
  assert.equal(out.corr, "c2");
  assert.ok(peeks >= 3);
});

test("finished /v1/run skips get_result", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": (body) => {
      assert.equal("wait_ms" in body, false);
      return { status: "done", corr: "c-fast", ok: true, exit_code: 0, stdout: "hi" };
    },
  });
  const out = await createOperator({ rpc }).callTool("run", { device_id: "mac-1", command: "pwd" });
  assert.equal(out.status, "done");
  assert.equal(out.stdout, "hi");
  assert.equal(out.ok, true);
  assert.equal(out.corr, "c-fast");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v1/run"],
  );
});

test("running /v1/run still polls get_result", async () => {
  const time = clock();
  let peeks = 0;
  const { rpc, calls } = mockRpc({
    "/v1/run": (body) => {
      assert.equal("wait_ms" in body, false);
      return { corr: "c-old", status: "running" };
    },
    "/v1/get_result": () => {
      peeks += 1;
      if (peeks < 2) return { status: "pending", corr: "c-old" };
      return { status: "done", corr: "c-old", ok: true, exit_code: 0, stdout: "later" };
    },
  });
  const out = await createOperator({ rpc, now: time.now, sleep: time.sleep }).callTool("run", {
    device_id: "mac-1",
    command: "pwd",
    wait_ms: 2000,
  });
  assert.equal(out.stdout, "later");
  assert.ok(peeks >= 2);
  assert.ok(calls.some((c) => c.path === "/v1/get_result"));
});

test("run wait_ms timeout keeps the job and returns running plus snapshot", async () => {
  const time = clock();
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c3", status: "running" }),
    "/v1/get_result": () => ({ status: "running", corr: "c3", pane_id: "p9" }),
  });
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep });
  const out = await op.callTool("run", { device_id: "mac-1", command: "sleep 30", wait_ms: 1500 });
  assert.equal(out.status, "running");
  assert.equal(out.corr, "c3");
  assert.equal(out.device_id, "mac-1");
  assert.equal(out.pane_id, "p9");
  assert.equal(calls.filter((c) => c.path === "/v1/run").length, 1);
  assert.ok(calls.some((c) => c.path === "/v1/get_result"));
  assert.ok(time.t >= 1500);
  assert.equal("isError" in out, false);
});

test("wait cancel returns still-running without killing", async () => {
  const time = clock();
  let cancelled = false;
  const { rpc, calls } = mockRpc({
    "/v1/get_result": () => ({ status: "running", pane_id: "p" }),
  });
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep });
  const pending = op.callTool("wait", { device_id: "mac-1", wait_ms: 5000 }, {
    isCancelled: () => cancelled,
  });
  cancelled = true;
  const out = await pending;
  assert.equal(out.status, "running");
  assert.equal("isError" in out, false);
  assert.ok(calls.every((c) => c.path === "/v1/get_result"));
  assert.ok(calls.every((c) => !("wait_ms" in c.body)));
});

test("wait tool polls get_result; omitted wait_ms uses the 30s cap", async () => {
  const time = clock();
  const { rpc, calls } = mockRpc({
    "/v1/get_result": () => ({ status: "running", pane_id: "p" }),
  });
  const op = createOperator({ rpc, env: { FLEET_DEVICE_ID: "env-1" }, now: time.now, sleep: time.sleep });
  const out = await op.callTool("wait", {});
  assert.equal(out.status, "running");
  assert.equal(out.device_id, "env-1");
  assert.equal("isError" in out, false);
  assert.ok(time.t >= WAIT_MAX_MS);
  assert.ok(time.t <= WAIT_TOOL_DEFAULT_MS + WAIT_POLL_MS);
  assert.ok(calls.every((c) => c.path === "/v1/get_result"));
  assert.ok(calls.every((c) => !("corr" in c.body)));
});

test("get_result wait_ms omitted is a single snapshot; wait_ms long-polls", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/get_result": () => ({ status: "pending" }),
  });
  const op = createOperator({ rpc });
  const out = await op.callTool("get_result", { device_id: "mac-1" });
  assert.equal(out.status, "pending");
  assert.equal(out.device_id, "mac-1");
  assert.equal(calls.length, 1);
  assert.equal("corr" in calls[0].body, false);

  const zero = await op.callTool("get_result", { device_id: "mac-1", wait_ms: 0 });
  assert.equal(zero.status, "pending");
  assert.equal(calls.length, 2);

  const time = clock();
  let peeks = 0;
  const { rpc: rpcW } = mockRpc({
    "/v1/get_result": () => {
      peeks += 1;
      if (peeks < 3) return { status: "pending", corr: "c5b" };
      return { status: "done", corr: "c5b", ok: true, exit_code: 0, stdout: "ok" };
    },
  });
  const blocked = await createOperator({ rpc: rpcW, now: time.now, sleep: time.sleep }).callTool("get_result", {
    device_id: "mac-1",
    wait_ms: 5000,
  });
  assert.equal(blocked.status, "done");
  assert.equal(blocked.stdout, "ok");
  assert.ok(peeks >= 3);
});

test("explicit device_id updates last-used; later calls can omit it", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": (_b, all) => ({ corr: `c-${all.length}`, status: "running" }),
    "/v1/type": () => ({ ok: true, status: "typed" }),
    "/v1/read_screen": () => ({ status: "empty", screen: null }),
    "/v1/get_result": (body) => ({ status: "pending", corr: body.corr }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "mac-1", command: "true", wait_ms: 0 });
  assert.equal((await op.callTool("get_current_computer")).device_id, "mac-1");
  assert.equal((await op.callTool("get_current_computer")).source, "last_used");

  const typed = await op.callTool("type", { keys: "q\n" });
  assert.equal(typed.device_id, "mac-1");
  await op.callTool("type", { key: "enter" });
  const typeBodies = calls.filter((c) => c.path === "/v1/type").map((c) => c.body);
  assert.equal(typeBodies[0].keys, "q\n");
  assert.equal(typeBodies[1].key, "enter");
  assert.equal(typeBodies[1].keys, "enter");
  const screen = await op.callTool("read_screen", {});
  assert.equal(screen.device_id, "mac-1");
  const peek = await op.callTool("get_result", {});
  assert.equal(peek.device_id, "mac-1");

  const runBodies = calls.filter((c) => c.path === "/v1/run" || c.path === "/v1/type" || c.path === "/v1/read_screen");
  assert.ok(runBodies.every((c) => c.body.device_id === "mac-1"));
});

test("set_computer and get_current_computer are process memory only", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c6", status: "running" }),
    "/v1/list_computers": () => ({ computers: [{ id: "solo", online: true }] }),
  });
  const op = createOperator({ rpc });
  const none = await op.callTool("get_current_computer");
  assert.equal(none.device_id, null);
  assert.equal(none.source, "none");

  const set = await op.callTool("set_computer", { device_id: "mac-1" });
  assert.equal(set.ok, true);
  assert.equal(set.device_id, "mac-1");
  assert.ok(!calls.some((c) => c.path === "/v1/select_computer"));

  const run = await op.callTool("run", { command: "uname", wait_ms: 0 });
  assert.equal(run.device_id, "mac-1");
  const sent = calls.find((c) => c.path === "/v1/run").body;
  assert.equal(sent.device_id, "mac-1");
  assertSentCommand(sent.command, "uname");
});

test("FLEET_DEVICE_ID is a start default and is not written back", async () => {
  const { rpc } = mockRpc({
    "/v1/run": () => ({ corr: "c7", status: "running" }),
  });
  const env = { FLEET_DEVICE_ID: "env-box" };
  const op = createOperator({ rpc, env });
  const before = await op.callTool("get_current_computer");
  assert.equal(before.device_id, "env-box");
  assert.equal(before.source, "env");
  assert.equal(before.last_used, null);
  assert.equal(before.env_default, "env-box");

  await op.callTool("run", { command: "true", wait_ms: 0 });
  const still = await op.callTool("get_current_computer");
  assert.equal(still.last_used, null);
  assert.equal(still.env_default, "env-box");
  assert.equal(still.source, "env");

  await op.callTool("run", { device_id: "mac-2", command: "true", wait_ms: 0 });
  const after = await op.callTool("get_current_computer");
  assert.equal(after.device_id, "mac-2");
  assert.equal(after.last_used, "mac-2");
  assert.equal(after.env_default, "env-box");
  assert.equal(env.FLEET_DEVICE_ID, "env-box");
});

test("no last-used and no env fails closed; does not auto-pick the only online machine", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/list_computers": () => ({ computers: [{ id: "only", online: true }] }),
    "/v1/run": () => ({ corr: "nope", status: "running" }),
  });
  const op = createOperator({ rpc });
  await assert.rejects(() => op.callTool("run", { command: "uname" }), (err) => {
    assert.match(String(err.message), /device_id required/);
    assert.match(String(err.message), /set_computer/);
    return true;
  });
  assert.ok(!calls.some((c) => c.path === "/v1/run"));
  assert.ok(!calls.some((c) => c.path === "/v1/list_computers"));
  assert.equal(MISSING_DEVICE_MESSAGE.includes("set_computer"), true);
});

test("remembered device offline fails explicitly with no fallback", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": (body) => {
      if (body.device_id === "dead") throw new Error("offline");
      return { corr: "other", status: "running" };
    },
    "/v1/list_computers": () => ({
      computers: [
        { id: "dead", online: false },
        { id: "live", online: true },
      ],
    }),
  });
  const op = createOperator({ rpc });
  await op.callTool("set_computer", { device_id: "dead" });
  await assert.rejects(() => op.callTool("run", { command: "uname" }), /offline/);
  const runs = calls.filter((c) => c.path === "/v1/run");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].body.device_id, "dead");
});

test("type, result, and screen use the internally issued corr, never a model-supplied corr", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "job-a", status: "running" }),
    "/v1/type": () => ({ ok: true, status: "typed" }),
    "/v1/get_result": () => ({ status: "pending" }),
    "/v1/read_screen": () => ({ status: "empty", screen: null }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "host-a", command: "one", wait_ms: 0 });
  await op.callTool("type", { corr: "job-a", keys: "x" });
  await op.callTool("get_result", { corr: "job-a" });
  await op.callTool("read_screen", { corr: "job-a" });
  const bodies = calls.filter((c) => c.path !== "/v1/run").map((c) => c.body);
  assert.ok(bodies.length >= 3);
  assert.ok(bodies.every((b) => b.corr === "job-a"));
  assert.ok(bodies.every((b) => !("fingerprint" in b)));
  assert.ok(bodies.every((b) => !("operator" in b)));
});

test("concurrent runs on one device poll only their own corr", async () => {
  const calls = [];
  const rpc = async (path, body) => {
    calls.push({ path, body: { ...body } });
    if (path === "/v1/run") {
      if (body.command === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { corr: "job-slow", status: "running" };
      }
      return { corr: "job-fast", status: "running" };
    }
    if (path === "/v1/get_result") {
      assert.ok(["job-slow", "job-fast"].includes(body.corr));
      return {
        corr: body.corr,
        status: "done",
        ok: true,
        exit_code: 0,
        stdout: body.corr === "job-slow" ? "slow-only" : "fast-only",
      };
    }
    throw new Error(`unexpected ${path}`);
  };
  const op = createOperator({ rpc });
  const [slow, fast] = await Promise.all([
    op.callTool("run", { device_id: "host-a", command: "slow" }),
    op.callTool("run", { device_id: "host-a", command: "fast" }),
  ]);
  assert.equal(slow.stdout, "slow-only");
  assert.equal(fast.stdout, "fast-only");
  assert.deepEqual(
    calls.filter((call) => call.path === "/v1/get_result").map((call) => call.body.corr).sort(),
    ["job-fast", "job-slow"],
  );
});

test("two operator processes on one device receive only their own results", async () => {
  const sessions = createSessionBook();
  const results = new Map();
  let seq = 0;
  const rpcFor = (fingerprint) => async (path, body) => {
    if (path === "/v1/run") {
      const corr = `job-${++seq}`;
      sessions.claim(fingerprint, corr);
      results.set(corr, {
        corr,
        status: "done",
        ok: true,
        exit_code: 0,
        stdout: `${fingerprint}:${body.command}`,
      });
      return { corr, status: "running" };
    }
    if (path === "/v1/get_result") {
      const resolved = sessions.resolve(fingerprint, body.corr);
      if (resolved.drop || !resolved.corr) return { status: "pending" };
      return results.get(resolved.corr) || { corr: resolved.corr, status: "pending" };
    }
    throw new Error(`unexpected ${path}`);
  };

  const operatorA = createOperator({ rpc: rpcFor("agent-a") });
  const operatorB = createOperator({ rpc: rpcFor("agent-b") });
  const [a, b] = await Promise.all([
    operatorA.callTool("run", { device_id: "shared-host", command: "A" }),
    operatorB.callTool("run", { device_id: "shared-host", command: "B" }),
  ]);

  assert.equal(a.stdout, "agent-a:A");
  assert.equal(b.stdout, "agent-b:B");
  assert.equal(sessions.resolve("agent-a", b.corr).drop, true);
  assert.equal(sessions.resolve("agent-b", a.corr).drop, true);
});

test("get_result after set_computer uses last-used; hub isolates by fingerprint header", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": (body) => ({ corr: String(body.command).includes("one") ? "job-a" : "job-b", status: "running" }),
    "/v1/get_result": (body) => ({ status: "pending", seen: body.device_id }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "host-a", command: "one", wait_ms: 0 });
  await op.callTool("set_computer", { device_id: "host-b" });
  const peek = await op.callTool("get_result", {});
  assert.equal(peek.device_id, "host-b");
  assert.equal(peek.seen, "host-b");
  const getCalls = calls.filter((c) => c.path === "/v1/get_result");
  assert.ok(getCalls.every((c) => c.body.device_id === "host-b"));
  assert.ok(getCalls.every((c) => !("corr" in c.body)));
});

test("get_computer and heartbeat use last-used and never invent a device id", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/get_computer": (body) => ({
      id: body.device_id,
      name: "box",
      os: "windows",
      online: true,
      lastSeen: 1,
      agentVer: "0.2.8",
    }),
    "/v1/heartbeat": (body) => ({
      id: body.device_id,
      name: "box",
      os: "windows",
      online: true,
      lastSeen: 2,
      agentVer: "0.2.8",
    }),
  });
  const op = createOperator({ rpc });
  await assert.rejects(() => op.callTool("get_computer", {}), (err) => {
    assert.match(String(err.message), /device_id required/);
    return true;
  });
  await op.callTool("set_computer", { device_id: "win-1" });
  const status = await op.callTool("get_computer", {});
  assert.equal(status.device_id, "win-1");
  assert.equal(status.agentVer, "0.2.8");
  const beat = await op.callTool("heartbeat", {});
  assert.equal(beat.device_id, "win-1");
  assert.equal(beat.agentVer, "0.2.8");
  assert.ok(calls.every((c) => c.body.device_id === "win-1"));
  assert.ok(calls.every((c) => !("fingerprint" in c.body)));
});

test("list_computers does not touch last-used", async () => {
  const { rpc } = mockRpc({
    "/v1/list_computers": () => ({ computers: [{ id: "z", online: true }] }),
  });
  const op = createOperator({ rpc });
  const listed = await op.callTool("list_computers", {});
  assert.equal(listed.computers[0].id, "z");
  const cur = await op.callTool("get_current_computer");
  assert.equal(cur.device_id, null);
  assert.equal(cur.cwd, null);
});

test("shQuote is POSIX single-quote wrapping", () => {
  assert.equal(shQuote("/tmp"), "'/tmp'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  const wrapped = wrapSessionCommand("pwd", "/tmp/it's");
  assert.ok(wrapped.includes(`cd ${shQuote("/tmp/it's")}`));
  assert.ok(wrapped.includes("pwd"));
  assert.ok(wrapped.includes(CWD_MARK));
});

test("stripSessionMeta removes the trailer and does not leak the marker", () => {
  const raw = `/tmp\n\n${CWD_MARK} 0 /tmp\n`;
  const meta = stripSessionMeta(raw);
  assert.equal(meta.stdout, "/tmp\n");
  assert.equal(meta.cwd, "/tmp");
  assert.equal(meta.exit, 0);
  assert.equal(meta.stdout.includes(CWD_MARK), false);
  const plain = stripSessionMeta("hello");
  assert.equal(plain.stdout, "hello");
  assert.equal(plain.cwd, null);
});

test("run sends the raw command — no __FLEET_META__ wrap", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c-raw", status: "running" }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "mac-1", command: "cd /tmp", wait_ms: 0 });
  await op.callTool("run", { device_id: "mac-1", command: "pwd", wait_ms: 0 });
  const sent = calls.filter((c) => c.path === "/v1/run").map((c) => c.body.command);
  assert.deepEqual(sent, ["cd /tmp", "pwd"]);
  assert.ok(sent.every((c) => !String(c).includes(CWD_MARK)));
});

test("formatMcpText is stdout for a finished ok run, not a JSON envelope", () => {
  const text = formatMcpText("run", {
    corr: "c1",
    status: "done",
    ok: true,
    exit_code: 0,
    error: "",
    stdout: "/Users/bytedance",
    device_id: "mac-1",
    cwd: "/Users/bytedance",
  });
  assert.equal(text, "/Users/bytedance");
  assert.equal(text.includes("{"), false);
  assert.equal(text.includes("device_id"), false);
});

test("formatMcpText empty stdout is empty string, not {}", () => {
  assert.equal(formatMcpText("run", { status: "done", ok: true, exit_code: 0, stdout: "" }), "");
  assert.equal(formatMcpText("get_result", { status: "done", ok: true, exit_code: 0 }), "");
});

test("formatMcpText running is plain text and never emits corr= or other ids", () => {
  const text = formatMcpText("run", { corr: "c-tui", status: "running", device_id: "mac-1", pane_id: "p9" });
  assert.equal(text, "still running");
  assert.equal(text.includes("{"), false);
  assert.equal(text.includes("corr="), false);
  assert.equal(text.includes("c-tui"), false);
  assert.equal(text.includes("pane_id"), false);
  assert.equal(formatMcpText("wait", { status: "pending", corr: "c2" }), "still running");
  const uuid = "6f1d2b3a-4c5e-6789-abcd-ef0123456789";
  const hid = formatMcpText("get_result", { status: "running", corr: uuid, fingerprint: "fp-1", operator: "op" });
  assert.equal(hid, "still running");
  assert.equal(hid.includes(uuid), false);
  assert.equal(hid.includes("fp-1"), false);
  assert.equal(hid.includes("corr"), false);
});

test("formatMcpText success with stderr stays stdout-first", () => {
  const text = formatMcpText("run", {
    status: "done",
    ok: true,
    exit_code: 0,
    stdout: "out\n",
    error: "warn",
  });
  assert.equal(text, "out\nwarn");
  assert.equal(text.includes("exit_code"), false);
  const onlyErr = formatMcpText("run", {
    status: "done",
    ok: true,
    exit_code: 0,
    stdout: "",
    stderr: "note",
  });
  assert.equal(onlyErr, "note");
});

test("formatMcpText finished nonzero exit appends a short trailer", () => {
  const text = formatMcpText("get_result", {
    status: "done",
    ok: false,
    exit_code: 2,
    stdout: "nope\n",
    error: "denied",
  });
  assert.equal(text, "nope\nexit_code: 2\ndenied");
  assert.equal(text.includes("\"ok\""), false);
});

test("formatMcpText does not force list/set/current through the shell formatter", () => {
  const listed = formatMcpText("list_computers", { computers: [{ id: "solo", online: true }] });
  assert.equal(listed, JSON.stringify({ computers: [{ id: "solo", online: true }] }));
  const set = formatMcpText("set_computer", { ok: true, device_id: "mac-1" });
  assert.equal(set, JSON.stringify({ ok: true, device_id: "mac-1" }));
  const cur = formatMcpText("get_current_computer", { device_id: "mac-1", source: "last_used" });
  assert.match(cur, /mac-1/);
  assert.match(cur, /last_used/);
});

test("isFleetDev accepts 1/true/yes and is off by default", () => {
  assert.equal(isFleetDev({}), false);
  assert.equal(isFleetDev({ FLEET_DEV: "0" }), false);
  assert.equal(isFleetDev({ FLEET_DEV: "1" }), true);
  assert.equal(isFleetDev({ FLEET_DEV: "true" }), true);
  assert.equal(isFleetDev({ FLEET_DEV: "YES" }), true);
});

function assertHopFields(h, extras = {}) {
  assert.equal(typeof h.path, "string");
  assert.equal(typeof h.t_out, "number");
  assert.equal(typeof h.t_in, "number");
  assert.equal(typeof h.send_ms, "number");
  assert.equal(typeof h.wait_ms, "number");
  assert.equal(typeof h.recv_ms, "number");
  assert.equal(typeof h.total_ms, "number");
  assert.equal(h.gap_ms, h.wait_ms);
  assert.match(h.t_out_iso, /Z$/);
  assert.match(h.t_in_iso, /Z$/);
  for (const [k, v] of Object.entries(extras)) assert.equal(h[k], v);
}

test("FLEET_DEV off leaves formatMcpText unchanged and records no timing", async () => {
  const time = clock();
  const { rpc, calls } = mockRpc({
    "/v1/run": async () => {
      await time.sleep(10);
      return { corr: "c-off", status: "running" };
    },
    "/v1/get_result": async () => {
      await time.sleep(20);
      return { status: "done", corr: "c-off", ok: true, exit_code: 0, stdout: "hi" };
    },
  });
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep });
  const out = await op.callTool("run", { device_id: "mac-1", command: "pwd" });
  assert.equal(out.timing, undefined);
  assert.equal(out.dev, undefined);
  assert.equal(calls[0].body.dev, undefined);
  const text = formatMcpText("run", out);
  assert.equal(text, "hi");
  assert.equal(text.includes("fleet-dev"), false);
});

test("FLEET_DEV on records hop wall times and appends trailer after stdout", async () => {
  const time = clock();
  const { rpc, calls } = mockRpc({
    "/v1/run": async () => {
      await time.sleep(336);
      return { corr: "c-dev", status: "running", t: 1000 };
    },
    "/v1/get_result": async () => {
      await time.sleep(323);
      return { status: "done", corr: "c-dev", ok: true, exit_code: 0, stdout: "hi", t: 1012 };
    },
  });
  const env = { FLEET_DEV: "1" };
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep, env });
  const out = await op.callTool("run", { device_id: "mac-1", command: "pwd" });
  assert.equal(out.timing, undefined);
  assert.ok(out.dev);
  assert.equal(out.dev.poll_count, 1);
  assert.equal(out.dev.sleep_ms, 0);
  assert.equal(out.dev.run_ms, 12);
  assert.equal(out.dev.client_run_gap_ms, 659);
  assert.ok(out.dev.total_ms >= 336 + 323);
  assert.equal(out.dev.hub_recv_t, null);
  assert.equal(out.dev.hub_reply_t, null);
  assert.equal(out.dev.hub_ms, null);
  assert.equal(out.dev.device_enqueue_t, 1000);
  assert.equal(out.dev.device_done_t, 1012);
  assert.equal(out.dev.device_run_ms, 12);
  const runHop = out.dev.hops.find((h) => h.path === "/v1/run");
  const getHop = out.dev.hops.find((h) => h.path === "/v1/get_result");
  assertHopFields(runHop, { send_ms: 0, wait_ms: 336, recv_ms: 0, total_ms: 336, split: "body", http_status: null });
  assertHopFields(getHop, { send_ms: 0, wait_ms: 323, recv_ms: 0, total_ms: 323, split: "body", http_status: null });
  assert.equal(calls.find((c) => c.path === "/v1/run")?.body.dev, true);
  const text = formatMcpText("run", out, env);
  assert.ok(text.startsWith("hi\n# fleet-dev\n"));
  assert.match(text, /# hop \/v1\/run\s+out=\d+ in=\d+ send=0ms wait=336ms recv=0ms total=336ms/);
  assert.match(text, /# hop \/v1\/get_result\s+out=\d+ in=\d+ send=0ms wait=323ms recv=0ms total=323ms/);
  assert.match(text, /# run_ms=12 client_gap=659ms poll=1 total=\d+ms/);
  assert.equal(text.includes("{"), false);
});

test("FLEET_DEV still-running reply is plain text plus trailer", async () => {
  const time = clock();
  const { rpc } = mockRpc({
    "/v1/run": async () => {
      await time.sleep(40);
      return { corr: "c-tui", status: "running" };
    },
  });
  const env = { FLEET_DEV: "1" };
  const op = createOperator({ rpc, now: time.now, sleep: time.sleep, env });
  const out = await op.callTool("run", { device_id: "mac-1", command: "htop", wait_ms: 0 });
  assert.equal(out.status, "running");
  assert.equal(out.dev.poll_count, 0);
  assert.equal(out.dev.hops.length, 1);
  assertHopFields(out.dev.hops[0], { path: "/v1/run", wait_ms: 40, split: "body" });
  const text = formatMcpText("run", out, env);
  const lines = text.split("\n");
  assert.equal(lines[0], "still running");
  assert.equal(text.includes("corr="), false);
  assert.equal(text.includes("c-tui"), false);
  assert.equal(lines[1], "# fleet-dev");
  assert.match(lines[2], /# hop \/v1\/run\s+out=\d+ in=\d+ send=0ms wait=40ms recv=0ms total=40ms/);
  assert.match(text, /# poll=0 total=\d+ms/);
});

test("measureHubFetch splits send/wait/recv at headers", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise((r) => setTimeout(r, 8));
    return {
      ok: true,
      status: 200,
      json: async () => {
        await new Promise((r) => setTimeout(r, 8));
        return { corr: "c1", status: "running" };
      },
    };
  };
  try {
    const measured = await measureHubFetch("http://example.test/v1/run", {
      method: "POST",
      body: { command: "pwd" },
    });
    assert.equal(measured.ok, true);
    assert.equal(measured.hop.split, "headers");
    assert.equal(measured.hop.http_status, 200);
    assert.ok(measured.hop.send_ms >= 0);
    assert.ok(measured.hop.wait_ms >= 0);
    assert.ok(measured.hop.recv_ms >= 0);
    assert.equal(measured.hop.gap_ms, measured.hop.wait_ms);
    assert.ok(measured.hop.t_in >= measured.hop.t_out);
  } finally {
    globalThis.fetch = orig;
  }
});

test("timed rpc hop keeps the headers split", async () => {
  const { rpc } = mockRpc({
    "/v1/run": () => ({
      __fleetTimed: true,
      json: { corr: "c-hdr", status: "running" },
      hop: {
        t_out: 1_700_000_000_000,
        t_in: 1_700_000_000_100,
        send_ms: 1,
        wait_ms: 80,
        recv_ms: 19,
        total_ms: 100,
        http_status: 200,
        split: "headers",
      },
    }),
  });
  const env = { FLEET_DEV: "1" };
  const op = createOperator({ rpc, env });
  const out = await op.callTool("run", { device_id: "mac-1", command: "pwd", wait_ms: 0 });
  assertHopFields(out.dev.hops[0], {
    path: "/v1/run",
    send_ms: 1,
    wait_ms: 80,
    recv_ms: 19,
    total_ms: 100,
    http_status: 200,
    split: "headers",
  });
});

test("transport wrappers preserve timed hops without leaking into business JSON", () => {
  const business = { corr: "c-transport", status: "running" };
  const wrapped = wrapTransportRpc({
    __fleetTimed: true,
    json: business,
    hop: { total_ms: 12, split: "headers" },
  }, "rtc");
  assert.deepEqual(unwrapTimedRpc(wrapped), {
    json: business,
    hop: { total_ms: 12, split: "headers" },
    transport: "rtc",
  });
  assert.deepEqual(business, { corr: "c-transport", status: "running" });
});

test("MCP result transport is per invocation and absent from default text", async () => {
  const rpc = async (path, body) => {
    assert.equal(path, "/v1/run");
    if (body.device_id === "slow-rtc") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return wrapTransportRpc({ corr: "rtc-corr", status: "running" }, "rtc");
    }
    return wrapTransportRpc({ corr: "ws-corr", status: "running" }, "ws");
  };
  const op = createOperator({ rpc });
  const [rtc, ws] = await Promise.all([
    op.callTool("run", { device_id: "slow-rtc", command: "pwd", wait_ms: 0 }),
    op.callTool("run", { device_id: "fast-ws", command: "pwd", wait_ms: 0 }),
  ]);

  assert.equal(resultTransport(rtc), "rtc");
  assert.equal(resultTransport(ws), "ws");
  assert.deepEqual(fleetResultMeta(rtc), { fleet_transport: "rtc" });
  assert.deepEqual(fleetResultMeta(ws), { fleet_transport: "ws" });
  assert.equal(formatMcpText("run", rtc), "still running");
  assert.equal(JSON.stringify(rtc).includes("fleet_transport"), false);
});

test("the final device reply decides transport after RTC falls back to WSS", async () => {
  const { rpc } = mockRpc({
    "/v1/run": () => wrapTransportRpc({ corr: "c-fallback", status: "running" }, "rtc"),
    "/v1/get_result": () => wrapTransportRpc({
      corr: "c-fallback",
      status: "done",
      ok: true,
      exit_code: 0,
      stdout: "done\n",
    }, "ws"),
  });
  const out = await createOperator({ rpc }).callTool("run", {
    device_id: "mac-1",
    command: "pwd",
  });
  assert.deepEqual(fleetResultMeta(out), { fleet_transport: "ws" });
  assert.equal(formatMcpText("run", out), "done\n");
});

test("catalog calls have no device transport, heartbeat remains WSS", async () => {
  const { rpc } = mockRpc({
    "/v1/list_computers": () => ({ computers: [] }),
    "/v1/heartbeat": () => wrapTransportRpc({ ok: true, online: true }, "ws"),
  });
  const op = createOperator({ rpc });
  const list = await op.callTool("list_computers", {});
  const heartbeat = await op.callTool("heartbeat", { device_id: "mac-1" });
  assert.equal(fleetResultMeta(list), null);
  assert.deepEqual(fleetResultMeta(heartbeat), { fleet_transport: "ws" });
});

test("applyCliDevFlag sets FLEET_DEV and strips --dev", () => {
  const env = {};
  assert.deepEqual(applyCliDevFlag(["--dev", "list"], env), ["list"]);
  assert.equal(env.FLEET_DEV, "1");
  assert.deepEqual(applyCliDevFlag(["list"], {}), ["list"]);
  assert.equal(isFleetDev({}), false);
});

test("MCP version is 0.5.2", () => {
  assert.equal(FLEET_VERSION, "0.5.2");
});

test("official plugin registry pins every platform artifact to SHA-256", () => {
  const acp = officialPlugin("fleet.acp");
  assert.equal(acp.publisher, "Fleet Official");
  assert.equal(acp.artifacts.length, 6);
  for (const artifact of acp.artifacts) {
    assert.match(artifact.url, /^https:\/\/github\.com\/TITOCHAN2023\/fleet-acp-plugin\/releases\/download\//);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(publicOfficialPlugins()[0].artifacts, undefined);
  assert.equal(publicOfficialPlugins()[0].installable, true);
  assert.equal(publicOfficialPlugins()[0].descriptions.zh.includes("Agent"), true);
});

test("plugin tools send ids and actions but never client-supplied artifact URLs", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/plugin": (body) => ({ corr: "p1", status: "pending", body }),
    "/v1/plugin_result": () => ({ corr: "p1", status: "done", ok: true }),
  });
  const op = createOperator({ rpc });
  await op.callTool("install_plugin", { device_id: "mac-1", plugin_id: "fleet.acp", url: "https://evil.test/x" });
  assert.deepEqual(calls[0], {
    path: "/v1/plugin",
    body: { device_id: "mac-1", operation: "install", plugin_id: "fleet.acp" },
  });
  await op.callTool("get_plugin_task", { corr: "p1" });
  assert.deepEqual(calls[1], { path: "/v1/plugin_result", body: { device_id: "mac-1", corr: "p1" } });
});

test("desktop_screenshot success keeps image_b64; formatMcpText strips it", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const { rpc } = mockRpc({
    "/v1/desktop_screenshot": () => ({
      ok: true,
      width: 1280,
      height: 720,
      image_b64: jpeg,
      mime: "image/jpeg",
    }),
  });
  const op = createOperator({ rpc });
  op.resolveDevice({ device_id: "pc1" });
  const row = await op.callTool("desktop_screenshot", {});
  assert.equal(row.ok, true);
  assert.equal(row.image_b64, jpeg);
  const text = formatMcpText("desktop_screenshot", row);
  assert.equal(text.includes("image_b64"), false);
  assert.equal(text.includes(jpeg), false);
});

test("desktop_screenshot consent is isError and has no image", async () => {
  const { rpc } = mockRpc({
    "/v1/desktop_screenshot": () => ({
      ok: false,
      status: "consent",
      code: "consent",
      error: "fleet: waiting for consent at the machine",
    }),
  });
  const op = createOperator({ rpc });
  const row = await op.callTool("desktop_screenshot", { device_id: "pc1" });
  assert.equal(row.ok, false);
  assert.equal(row.isError, true);
  assert.equal(row.image_b64, undefined);
});

test("desktop_action 409 unsupported cap is isError with code", async () => {
  const err = new Error("unsupported");
  err.status = 409;
  err.json = { error: "unsupported", code: "UNSUPPORTED_CAP", missing: "computer_use", os: "linux", agentVer: "0.2.10" };
  const { rpc, calls } = mockRpc({
    "/v1/desktop_action": () => {
      throw err;
    },
  });
  const op = createOperator({ rpc });
  const row = await op.callTool("desktop_action", { device_id: "old", action: "left_click", x: 1, y: 1 });
  assert.equal(row.isError, true);
  assert.equal(row.code, "UNSUPPORTED_CAP");
  assert.equal(row.os, "linux");
  assert.equal(calls.length, 1);
});

test("buildTools ships desktop_screenshot and desktop_action", () => {
  const names = buildTools().map((t) => t.name);
  assert.ok(names.includes("desktop_screenshot"));
  assert.ok(names.includes("desktop_action"));
  assert.equal(names.filter((n) => n === "read_screen").length, 1);
});

test("file transfer tools expose one generic endpoint model", () => {
  const tools = buildTools();
  for (const name of ["start_file_transfer", "get_file_transfer", "cancel_file_transfer"]) {
    assert.ok(tools.some((tool) => tool.name === name), name);
  }
  const start = tools.find((tool) => tool.name === "start_file_transfer");
  assert.deepEqual(start.inputSchema.required, ["source", "target"]);
  assert.deepEqual(start.inputSchema.properties.source.properties.kind.enum, ["tool", "device"]);
  assert.match(start.description, /never falls back/i);
});

test("local file endpoints delegate to the local streaming manager", async () => {
  const calls = [];
  const fileTransfer = {
    start: async (input) => {
      calls.push(["start", input]);
      return { transfer_id: "t-1", phase: "preparing_source" };
    },
    status: async (id) => {
      calls.push(["status", id]);
      return { transfer_id: id, phase: "transferring" };
    },
    cancel: async (id) => {
      calls.push(["cancel", id]);
      return { transfer_id: id, phase: "cancelled" };
    },
  };
  const op = createOperator({ rpc: async () => assert.fail("Hub rpc should stay inside the transfer manager"), fileTransfer });
  const source = { kind: "tool", path: "/tmp/source.bin" };
  const target = { kind: "device", device_id: "device-a", directory: "/tmp/incoming" };
  assert.equal((await op.callTool("start_file_transfer", { source, target })).transfer_id, "t-1");
  assert.equal((await op.callTool("get_file_transfer", { transfer_id: "t-1" })).phase, "transferring");
  assert.equal((await op.callTool("cancel_file_transfer", { transfer_id: "t-1" })).phase, "cancelled");
  assert.deepEqual(calls, [["start", { source, target }], ["status", "t-1"], ["cancel", "t-1"]]);
});

test("remote MCP can coordinate device-to-device but cannot claim a Tool disk", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/transfer/create": (body) => ({ transfer: { transfer_id: "t-2", phase: "pending", body } }),
  });
  const op = createOperator({ rpc });
  const row = await op.callTool("start_file_transfer", {
    source: { kind: "device", device_id: "source-a", path: "/srv/a.bin" },
    target: { kind: "device", device_id: "target-b", directory: "/srv/incoming" },
  });
  assert.equal(row.transfer_id, "t-2");
  assert.equal(calls[0].path, "/v1/transfer/create");
  assert.deepEqual(calls[0].body.source, { kind: "device", id: "source-a" });
  await assert.rejects(
    () =>
      op.callTool("start_file_transfer", {
        source: { kind: "tool", path: "/tmp/a" },
        target: { kind: "device", device_id: "target-b", directory: "/srv/incoming" },
      }),
    /local Fleet Tool/i,
  );
});

test("newOperatorFingerprint is a UUID and is not read from FLEET_OPERATOR", () => {
  const prev = process.env.FLEET_OPERATOR;
  process.env.FLEET_OPERATOR = "model-filled-id";
  try {
    const a = newOperatorFingerprint();
    const b = newOperatorFingerprint();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(a, b);
    assert.notEqual(a, "model-filled-id");
  } finally {
    if (prev == null) delete process.env.FLEET_OPERATOR;
    else process.env.FLEET_OPERATOR = prev;
  }
});

test("fleetHubHeaders attaches X-Fleet-Operator and never a tool-shaped field", () => {
  const fp = "11111111-2222-4333-8444-555555555555";
  const headers = fleetHubHeaders({ token: "flt_test", fingerprint: fp });
  assert.equal(headers[FLEET_OPERATOR_HEADER], fp);
  assert.equal(headers.authorization, "Bearer flt_test");
  assert.equal(headers["content-type"], "application/json");
  assert.equal("corr" in headers, false);
  const none = fleetHubHeaders({ token: "flt_test" });
  assert.equal(none[FLEET_OPERATOR_HEADER], undefined);
  const oaep = fleetHubHeaders({ authorization: "Fleet-OAEP kid.wrap" });
  assert.equal(oaep.authorization, "Fleet-OAEP kid.wrap");
});

test("measureHubFetch sends the operator fingerprint header", async () => {
  const orig = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.headers;
    return { ok: true, status: 200, json: async () => ({ status: "running" }) };
  };
  try {
    const fp = newOperatorFingerprint();
    await measureHubFetch("http://example.test/v1/run", {
      method: "POST",
      headers: fleetHubHeaders({ token: "flt_x", fingerprint: fp }),
      body: { command: "pwd" },
    });
    assert.equal(seen[FLEET_OPERATOR_HEADER], fp);
    assert.equal(seen.authorization, "Bearer flt_x");
  } finally {
    globalThis.fetch = orig;
  }
});
