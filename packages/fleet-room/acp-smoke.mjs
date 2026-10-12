// Opt-in: runs real model prompts. Never part of the default test suite.
// node acp-smoke.mjs /absolute/path/to/agent [args...]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession } from "./acp.mjs";
import assert from "node:assert/strict";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Expected ACP command and arguments");
const cwd = await mkdtemp(join(tmpdir(), "fleet-room-acp-smoke-"));
const sessions = [];
try {
  for (let i = 0; i < 2; i++) sessions.push(new AcpSession({ command, args, cwd,
    openTimeoutMs: 30_000, promptTimeoutMs: 60_000, cancelTimeoutMs: 5_000 }));
  await Promise.all(sessions.map((session) => session.open()));
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
  console.log(JSON.stringify({ stage: "opened", count: sessions.length,
    independent: sessions[0].sessionId !== sessions[1].sessionId,
    agentInfo: sessions[0].initialized.agentInfo ?? null }));
  const results = await Promise.all(sessions.map((session) => session.prompt(
    "This is a read-only protocol smoke test. Do not call any tools, read or write files, or perform any external actions. Reply with exactly FLEET_ROOM_ACP_OK and nothing else.")));
  console.log(JSON.stringify({ stage: "completed", results: results.map((r) => ({ stopReason: r.stopReason, matched: r.text.trim() === "FLEET_ROOM_ACP_OK" })) }));
  for (const result of results) {
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.text.trim(), "FLEET_ROOM_ACP_OK");
  }
  const abort = new AbortController();
  const pending = sessions[0].prompt("Read-only cancellation test. Do not call any tools or perform external actions. Write the integers from 1 to 1000 in your answer.", { signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const result = await pending;
    console.log(JSON.stringify({ stage: "cancelled", stopReason: result.stopReason }));
    assert.equal(result.stopReason, "cancelled");
  } finally { clearTimeout(timer); }
} catch (error) {
  console.error(JSON.stringify({ stage: "failed", code: error.code ?? "unknown", outcome: error.outcome ?? null }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(sessions.map((session) => session.close()));
  await rm(cwd, { recursive: true, force: true });
}
