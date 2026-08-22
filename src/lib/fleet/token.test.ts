import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HIGH_SEC_UPGRADE,
  bearerToken,
  hashHubToken,
  isHubToken,
  isLegacyFlt,
  mintHubToken,
  verifyTokenV1,
} from "./token";

test("minted tokens are flt_1 and hash the secret", async () => {
  const t = await mintHubToken("https://fleet.ginfo.cc");
  assert.equal(isHubToken(t.raw), true);
  assert.equal(isLegacyFlt(t.raw), false);
  assert.equal(t.hash, await hashHubToken(t.sec));
  assert.equal(t.prefix.startsWith("flt_1."), true);
  assert.notEqual(t.hash, t.raw);
  const claims = await verifyTokenV1(t.raw);
  assert.equal(claims.aud, "https://fleet.ginfo.cc");
  assert.equal(claims.kid, t.kid);
});

test("reset mints a different keypair", async () => {
  const a = await mintHubToken("https://fleet.ginfo.cc");
  const b = await mintHubToken("https://fleet.ginfo.cc");
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.kid, b.kid);
  assert.notEqual(a.priv, b.priv);
});

test("legacy hex bearers are not hub tokens", () => {
  assert.equal(isHubToken("session-abc"), false);
  assert.equal(isHubToken("flt_short"), false);
  assert.equal(isLegacyFlt("flt_" + "ab".repeat(32)), true);
  assert.equal(bearerToken("Bearer flt_x"), "flt_x");
  assert.equal(bearerToken("nope"), "");
  assert.match(HIGH_SEC_UPGRADE, /^HIGH_SEC:/);
});
