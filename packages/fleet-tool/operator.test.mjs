import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSING_DEVICE_MESSAGE,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  WAIT_POLL_MS,
  WAIT_TOOL_DEFAULT_MS,
  buildTools,
  clampWaitMs,
  createOperator,
  deviceMismatchMessage,
  isFinishedResult,
} from "./operator.mjs";

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
  assert.equal(WAIT_MAX_MS, 30_000);
  assert.equal(clampWaitMs(0), 0);
  assert.equal(clampWaitMs(-5), 0);
  assert.equal(clampWaitMs(500), 500);
  assert.equal(clampWaitMs(30_000), 30_000);
  assert.equal(clampWaitMs(60_000), WAIT_MAX_MS);
  assert.equal(clampWaitMs(5 * 60 * 1000), WAIT_MAX_MS);
  assert.equal(clampWaitMs("nope"), 0);
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
  for (const n of ["list_computers", "run", "get_result", "read_screen", "type"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(names.includes("wait"));
  assert.ok(names.includes("set_computer"));
  assert.ok(names.includes("get_current_computer"));

  for (const n of ["run", "get_result", "wait", "read_screen", "type"]) {
    const t = tools.find((x) => x.name === n);
    assert.equal(typeof t.inputSchema.properties.device_id, "object", n);
    assert.equal((t.inputSchema.required ?? []).includes("device_id"), false, n);
  }
  const set = tools.find((x) => x.name === "set_computer");
  assert.deepEqual(set.inputSchema.required, ["device_id"]);
  assert.ok(set.inputSchema.properties.device_id);
  assert.deepEqual(tools.find((x) => x.name === "run").inputSchema.required, ["command"]);

  for (const n of ["run", "get_result", "wait"]) {
    const w = tools.find((x) => x.name === n).inputSchema.properties.wait_ms;
    assert.equal(w.maximum, WAIT_MAX_MS, n);
    assert.equal(w.minimum, 0, n);
    assert.match(w.description, /30000|30s/, n);
    assert.match(w.description, /never kills/i, n);
  }
  assert.equal(tools.find((x) => x.name === "run").inputSchema.properties.wait_ms.default, 0);
  assert.equal(tools.find((x) => x.name === "get_result").inputSchema.properties.wait_ms.default, 0);
  assert.equal(tools.find((x) => x.name === "wait").inputSchema.properties.wait_ms.default, WAIT_TOOL_DEFAULT_MS);
});

test("run wait_ms omitted or 0 is immediate corr and does not poll get_result", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": () => ({ corr: "c1", status: "running" }),
  });
  const op = createOperator({ rpc });
  const t0 = Date.now();
  const out = await op.callTool("run", { device_id: "mac-1", command: "uname" });
  assert.ok(Date.now() - t0 < 50);
  assert.equal(out.corr, "c1");
  assert.equal(out.status, "running");
  assert.equal(out.device_id, "mac-1");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v1/run"],
  );
  assert.deepEqual(calls[0].body, { device_id: "mac-1", command: "uname" });
  assert.equal("wait_ms" in calls[0].body, false);

  const { rpc: rpc0, calls: calls0 } = mockRpc({
    "/v1/run": () => ({ corr: "c1b", status: "running" }),
  });
  const zero = await createOperator({ rpc: rpc0 }).callTool("run", {
    device_id: "mac-1",
    command: "uname",
    wait_ms: 0,
  });
  assert.equal(zero.status, "running");
  assert.deepEqual(
    calls0.map((c) => c.path),
    ["/v1/run"],
  );
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

test("wait tool polls get_result; omitted wait_ms uses the 30s cap", async () => {
  const time = clock();
  const { rpc, calls } = mockRpc({
    "/v1/get_result": () => ({ status: "running", corr: "c4", pane_id: "p" }),
  });
  const op = createOperator({ rpc, env: { FLEET_DEVICE_ID: "env-1" }, now: time.now, sleep: time.sleep });
  const out = await op.callTool("wait", { corr: "c4" });
  assert.equal(out.status, "running");
  assert.equal(out.device_id, "env-1");
  assert.equal("isError" in out, false);
  assert.ok(time.t >= WAIT_MAX_MS);
  assert.ok(time.t <= WAIT_TOOL_DEFAULT_MS + WAIT_POLL_MS);
  assert.ok(calls.every((c) => c.path === "/v1/get_result"));
});

test("get_result wait_ms omitted is a single snapshot; wait_ms long-polls", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/get_result": () => ({ status: "pending", corr: "c5" }),
  });
  const op = createOperator({ rpc });
  const out = await op.callTool("get_result", { device_id: "mac-1", corr: "c5" });
  assert.equal(out.status, "pending");
  assert.equal(out.device_id, "mac-1");
  assert.equal(calls.length, 1);

  const zero = await op.callTool("get_result", { device_id: "mac-1", corr: "c5", wait_ms: 0 });
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
    corr: "c5b",
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
  await op.callTool("run", { device_id: "mac-1", command: "true" });
  assert.equal((await op.callTool("get_current_computer")).device_id, "mac-1");
  assert.equal((await op.callTool("get_current_computer")).source, "last_used");

  const typed = await op.callTool("type", { keys: "q\n" });
  assert.equal(typed.device_id, "mac-1");
  const screen = await op.callTool("read_screen", {});
  assert.equal(screen.device_id, "mac-1");
  const peek = await op.callTool("get_result", { corr: "c-1" });
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

  const run = await op.callTool("run", { command: "uname" });
  assert.equal(run.device_id, "mac-1");
  assert.deepEqual(calls.find((c) => c.path === "/v1/run").body, { device_id: "mac-1", command: "uname" });
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

  await op.callTool("run", { command: "true" });
  const still = await op.callTool("get_current_computer");
  assert.equal(still.last_used, null);
  assert.equal(still.env_default, "env-box");
  assert.equal(still.source, "env");

  await op.callTool("run", { device_id: "mac-2", command: "true" });
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

test("get_result / wait / read_screen refuse a different device than the job owner", async () => {
  const { rpc } = mockRpc({
    "/v1/run": () => ({ corr: "job-1", status: "running" }),
    "/v1/get_result": () => ({ status: "pending", corr: "job-1" }),
    "/v1/read_screen": () => ({ status: "ok", screen: { text: "x" } }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "mac-1", command: "sleep 1" });

  await assert.rejects(
    () => op.callTool("get_result", { device_id: "mac-2", corr: "job-1" }),
    (err) => {
      assert.equal(err.message, deviceMismatchMessage("job-1", "mac-1", "mac-2"));
      return true;
    },
  );
  await assert.rejects(() => op.callTool("wait", { device_id: "mac-2", corr: "job-1", wait_ms: 1000 }), /belongs to device/);
  await assert.rejects(() => op.callTool("read_screen", { device_id: "mac-2", corr: "job-1" }), /belongs to device/);

  const peek = await op.callTool("get_result", { corr: "job-1" });
  assert.equal(peek.device_id, "mac-1");
});

test("corr owner wins over a later last-used so the job is not peeked on the wrong host", async () => {
  const { rpc, calls } = mockRpc({
    "/v1/run": (body) => ({ corr: body.command === "one" ? "job-a" : "job-b", status: "running" }),
    "/v1/get_result": (body) => ({ status: "pending", corr: body.corr, seen: body.device_id }),
  });
  const op = createOperator({ rpc });
  await op.callTool("run", { device_id: "host-a", command: "one" });
  await op.callTool("set_computer", { device_id: "host-b" });
  const peek = await op.callTool("get_result", { corr: "job-a" });
  assert.equal(peek.device_id, "host-a");
  assert.equal(peek.seen, "host-a");
  const getCalls = calls.filter((c) => c.path === "/v1/get_result");
  assert.ok(getCalls.every((c) => c.body.device_id === "host-a"));
});

test("list_computers does not touch last-used", async () => {
  const { rpc } = mockRpc({
    "/v1/list_computers": () => ({ computers: [{ id: "z", online: true }] }),
  });
  const op = createOperator({ rpc });
  const listed = await op.callTool("list_computers", {});
  assert.equal(listed.computers[0].id, "z");
  assert.equal((await op.callTool("get_current_computer")).device_id, null);
});
