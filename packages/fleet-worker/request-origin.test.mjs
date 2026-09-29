import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieMutationAllowed } from "./src/request-origin.mjs";

const origin = "https://fleet.example.test";
const cookie = "fleet_session=test-session";
function allowed(headers, method = "POST") {
  return cookieMutationAllowed(new Request(`${origin}/v1/hub_token`, { method, headers }), origin);
}

test("cookie writes reject sibling, foreign, null and absent origins", () => {
  for (const value of [
    "https://evil.example.test",
    "https://evil.test",
    "null",
    `${origin}.evil.test`,
  ]) {
    assert.equal(allowed({ cookie, origin: value }), false);
  }
  assert.equal(allowed({ cookie }), false);
  assert.equal(allowed({ cookie, origin, "sec-fetch-site": "same-site" }), false);
});

test("same-origin browser writes and referer fallback remain usable", () => {
  assert.equal(allowed({ cookie, origin, "sec-fetch-site": "same-origin" }), true);
  assert.equal(allowed({ cookie, referer: `${origin}/settings` }), true);
  assert.equal(allowed({ cookie, origin: "null", referer: `${origin}/settings` }), false);
});

test("native token requests and safe reads do not need browser metadata", () => {
  assert.equal(allowed({ authorization: "Fleet-OAEP test.wrap" }), true);
  assert.equal(allowed({ authorization: "Bearer test" }), true);
  assert.equal(allowed({ cookie }, "GET"), true);
  assert.equal(allowed({ cookie }, "OPTIONS"), true);
  assert.equal(allowed({ cookie, upgrade: "websocket" }, "GET"), false);
});
