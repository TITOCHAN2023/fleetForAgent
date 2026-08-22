import assert from "node:assert/strict";
import { test } from "node:test";
import { googleProfileEmail, xAccountEmail } from "./src/oauth-account.mjs";

test("X account is keyed by user id, not username", () => {
  assert.equal(xAccountEmail("12345"), "12345@x.oauth.fleet");
  assert.equal(xAccountEmail(" 99 "), "99@x.oauth.fleet");
  assert.equal(xAccountEmail(""), "");
  assert.equal(xAccountEmail(null), "");
});

test("Google requires a verified email", () => {
  assert.deepEqual(googleProfileEmail({ email: "A@X.COM", verified_email: true }), {
    ok: true,
    email: "a@x.com",
  });
  assert.equal(googleProfileEmail({ email: "a@x.com" }).ok, false);
  assert.equal(googleProfileEmail({ email: "a@x.com", verified_email: false }).ok, false);
  assert.equal(googleProfileEmail({ verified_email: true }).ok, false);
});
