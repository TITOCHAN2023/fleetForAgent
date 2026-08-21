import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, hashHubToken, isHubToken, mintHubToken } from "./token";

test("minted tokens look like flt_ + 32-byte hex", () => {
  const t = mintHubToken();
  assert.equal(isHubToken(t.raw), true);
  assert.equal(t.hash, hashHubToken(t.raw));
  assert.equal(t.prefix, t.raw.slice(0, 12));
  assert.notEqual(t.hash, t.raw);
});

test("reset mints a different hash", () => {
  const a = mintHubToken();
  const b = mintHubToken();
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});

test("hash is stable and does not leak the secret", () => {
  const raw = mintHubToken().raw;
  assert.equal(hashHubToken(raw), hashHubToken(raw));
  assert.equal(hashHubToken(raw).includes(raw.slice(4)), false);
});

test("session-looking bearers are not hub tokens", () => {
  assert.equal(isHubToken("session-abc"), false);
  assert.equal(isHubToken("flt_short"), false);
  assert.equal(bearerToken("Bearer flt_x"), "flt_x");
  assert.equal(bearerToken("nope"), "");
});
