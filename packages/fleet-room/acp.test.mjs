import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { AcpSession } from "./acp.mjs";
const fixture = fileURLToPath(new URL("./tests/fixtures/acp-agent.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function session(t, mode = "normal", options = {}) {
  const s = new AcpSession({ command: process.execPath, args: [fixture, mode], cwd: "/tmp", openTimeoutMs: 2000,
    promptTimeoutMs: 2000, cancelTimeoutMs: 80, killTimeoutMs: 30, ...options });
  t.after(() => s.close());
  return s;
}

test("real child: fragmented UTF-8, unrelated responses and notifications, scoped MCP configuration", async (t) => {
  const updates = [];
  const s = session(t, "mcp", { mcpServers: [{ name: "room", command: "fake", args: [], env: [] }], onUpdate: (u) => updates.push(u) });
  await s.open();
  assert.deepEqual(await s.prompt("hello"), { stopReason: "end_turn", text: "你好" });
  assert.equal(updates.length, 1);
  assert.equal((await s.prompt("second turn")).text, "你好");
});

test("one session rejects concurrent turns; separate sessions proceed concurrently", async (t) => {
  const a = session(t, "cancel"), b = session(t);
  await Promise.all([a.open(), b.open()]);
  const abort = new AbortController();
  const first = a.prompt("wait", { signal: abort.signal });
  await assert.rejects(a.prompt("duplicate"), { code: "acp_busy" });
  assert.equal((await b.prompt("other room")).stopReason, "end_turn");
  abort.abort();
  assert.equal((await first).stopReason, "cancelled");
  assert.equal(a.state, "ready");
});

test("permission is denied by default; only explicit allow_once is accepted", async (t) => {
  for (const [handler, expected] of [[undefined, "no"], [() => "always", "no"], [() => "yes", "yes"]]) {
    const s = session(t, "permission", { onPermission: handler });
    await s.open();
    assert.equal((await s.prompt("request write")).text, expected);
  }
});

test("cancel closes permission gate even if approval handler resolves later", async (t) => {
  let grant;
  const abort = new AbortController();
  let asked;
  const request = new Promise((resolve) => { asked = resolve; });
  const s = session(t, "permission-cancel", { onPermission: () => { asked(); return new Promise((resolve) => { grant = resolve; }); } });
  await s.open();
  const p = s.prompt("write", { signal: abort.signal });
  await request;
  abort.abort();
  grant("yes");
  assert.equal((await p).stopReason, "cancelled");
});

test("unconfirmed cancellation closes owned process and reports unknown", async (t) => {
  const s = session(t, "hang");
  await s.open();
  await assert.rejects(s.prompt("wait", { signal: AbortSignal.timeout(30) }), { code: "acp_cancel_unconfirmed", outcome: "unknown" });
  assert.equal(s.state, "closed");
  assert.throws(() => process.kill(s.child.pid, 0), { code: "ESRCH" });
});

test("prompt deadline sends cancellation; an already aborted prompt never starts", async (t) => {
  const s = session(t, "cancel", { promptTimeoutMs: 20 });
  await s.open();
  await assert.rejects(s.prompt("skip", { signal: AbortSignal.abort() }), { outcome: "not_started" });
  assert.equal((await s.prompt("timeout")).stopReason, "cancelled");
});

test("process crash is unknown and stderr credentials are not surfaced", async (t) => {
  const s = session(t, "crash");
  await s.open();
  await assert.rejects(s.prompt("crash"), (e) => e.code === "acp_exit" && e.outcome === "unknown" && !String(e).includes("SECRET"));
});

test("malformed frames and bounded output close the process", async (t) => {
  for (const [mode, code] of [["bad-frame", "acp_protocol"], ["large-frame", "acp_limit"], ["large-output", "acp_limit"]]) {
    const s = session(t, mode, { maxFrameBytes: 1024, maxOutputBytes: 3000 });
    await s.open();
    await assert.rejects(s.prompt("flood"), { code });
    assert.equal(s.state, "closed");
  }
});

test("initialization timeout and spawn failure settle and clean up", async (t) => {
  const a = session(t, "hang-open", { openTimeoutMs: 60 });
  await assert.rejects(a.open(), { code: "acp_timeout" });
  const b = session(t, "normal", { command: "/does-not-exist/fleet-acp" });
  await assert.rejects(b.open(), { code: "acp_spawn" });
});

test("forced shutdown kills descendants in the owned process group", async (t) => {
  let childPid;
  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const s = session(t, "descendant", { onUpdate: (u) => { childPid = Number(u.content.text); childReady(); } });
  await s.open();
  const p = s.prompt("start child");
  const rejected = assert.rejects(p, { code: "acp_cancel_unconfirmed" });
  await ready;
  await s.close();
  await rejected;
  for (let i = 0; i < 30; i++) {
    try {
      const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
      if (stat.split(" ")[2] === "Z") return; // Reaping belongs to the container's init; it is no longer executing.
    } catch (e) { if (e.code === "ENOENT") return; throw e; }
    await delay(10);
  }
  assert.fail("descendant remains alive");
});
