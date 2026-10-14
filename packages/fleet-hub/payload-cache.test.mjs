import assert from "node:assert/strict";
import test from "node:test";
import { PayloadCache, HubPayloads } from "./payload-cache.mjs";

test("payload byte and entry budgets, replacement accounting and TTL are bounded", () => {
  let now = 0;
  const cache = new PayloadCache({ maxBytes: 300, maxEntries: 3, ttlMs: 100, now: () => now });
  for (let i = 0; i < 1000; i++) {
    cache.set(String(i), { output: "界".repeat(20) });
    assert.ok(cache.bytes <= 300); assert.ok(cache.rows.size <= 3);
  }
  cache.set("999", { output: "x" });
  assert.equal(cache.get("999").output, "x");
  now = 101;
  assert.equal(cache.get("999"), undefined);
  cache.sweep(); assert.equal(cache.bytes, 0); assert.equal(cache.rows.size, 0);
});

test("result eviction retains bounded unknown summary, not invented success or another pane", () => {
  let now = 0;
  const hub = new HubPayloads({ maxBytes: 200, maxEntries: 3, ttlMs: 100, summaryTtlMs: 200, now: () => now });
  hub.putResult("one", "a", { ok: true, stdout: "x".repeat(300) });
  assert.equal(hub.getResult("one", "a").status, "unknown");
  assert.equal(hub.getResult("one", "a").ok, undefined);
  hub.putScreen("one", "a", { text: "first" });
  hub.putScreen("one", "b", { text: "other" });
  assert.equal(hub.getScreen("one", "missing"), undefined);
  assert.equal(hub.getScreen("two", "a"), undefined);
  now = 101;
  assert.equal(hub.getScreen("one", "b"), undefined);
  assert.equal(hub.getResult("one", "a").code, "RESULT_NOT_RETAINED");
  hub.putResult("one", "a", { status: "running" });
  assert.equal(hub.getResult("one", "a").status, "unknown", "late accepted cannot demote completion");
  now = 201;
  assert.equal(hub.getResult("one", "a"), undefined);
});
