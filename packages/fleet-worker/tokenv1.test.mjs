import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHALLENGE_MAX_LIVE,
  HIGH_SEC_KEY_MISMATCH,
  HIGH_SEC_UPGRADE,
  audMismatch,
  createChallengeBook,
  fleetOaepValue,
  hashHubToken,
  highSecAuthorization,
  hubOrigin,
  isLegacyFlt,
  isTokenV1,
  mintTokenV1,
  nextChallengeList,
  parseAuthorization,
  signChallenge,
  unwrapAuth,
  verifyChallenge,
  verifyTokenV1,
  wrapAuth,
} from "./src/tokenv1.mjs";

const AUD = "https://fleet.ginfo.cc";

test("challenge list caps live nonces and drops the oldest", () => {
  let live = [];
  const dropped = [];
  for (let i = 0; i < CHALLENGE_MAX_LIVE + 3; i++) {
    const next = nextChallengeList(live, `n${i}`);
    live = next.list;
    dropped.push(...next.dropped);
  }
  assert.equal(live.length, CHALLENGE_MAX_LIVE);
  assert.deepEqual(dropped, ["n0", "n1", "n2"]);
  assert.deepEqual(live, ["n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10"]);
  const book = createChallengeBook({ max: 2 });
  book.put("kid", "a", { userId: "u" });
  book.put("kid", "b", { userId: "u" });
  book.put("kid", "c", { userId: "u" });
  assert.equal(book.take("a"), undefined);
  assert.equal(book.take("b")?.kid, "kid");
  assert.equal(book.take("c")?.kid, "kid");
});

test("payload JSON uses a stable field order", () => {
  assert.equal(
    JSON.stringify({
      v: 1,
      aud: "https://fleet.ginfo.cc",
      kid: "kid",
      pub: "pub",
      iat: 1,
      sec: "sec",
    }),
    '{"v":1,"aud":"https://fleet.ginfo.cc","kid":"kid","pub":"pub","iat":1,"sec":"sec"}',
  );
});

test("hubOrigin normalizes scheme, host case, and strips path", () => {
  assert.equal(hubOrigin("https://fleet.ginfo.cc"), AUD);
  assert.equal(hubOrigin("https://Fleet.Ginfo.CC/v1/device"), AUD);
  assert.equal(hubOrigin("wss://fleet.ginfo.cc/v1/device"), AUD);
  assert.equal(hubOrigin("fleet.ginfo.cc"), AUD);
  assert.equal(hubOrigin("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.equal(hubOrigin(""), "");
});

test("legacy flt_ hex is rejected; flt_1 is the high-sec form", () => {
  assert.equal(isLegacyFlt("flt_" + "ab".repeat(32)), true);
  assert.equal(isTokenV1("flt_" + "ab".repeat(32)), false);
  assert.equal(isTokenV1("flt_1.aaa.bbb"), true);
  assert.equal(isLegacyFlt("flt_1.aaa.bbb"), false);
});

test("parseAuthorization reads Fleet-OAEP and Bearer", () => {
  assert.deepEqual(parseAuthorization("Fleet-OAEP kid.wrap"), { kind: "oaep", kid: "kid", wrap: "wrap" });
  assert.deepEqual(parseAuthorization("Bearer flt_old"), { kind: "bearer", token: "flt_old" });
  assert.equal(parseAuthorization("").kind, "none");
  assert.equal(fleetOaepValue("k", "w"), "Fleet-OAEP k.w");
});

test("minted token verifies, wraps, and binds aud", async () => {
  const minted = await mintTokenV1({ aud: AUD });
  assert.equal(isTokenV1(minted.raw), true);
  assert.equal(minted.aud, AUD);
  assert.equal(minted.hash, await hashHubToken(minted.sec));
  assert.match(minted.prefix, /^flt_1\./);
  const claims = await verifyTokenV1(minted.raw);
  assert.equal(claims.kid, minted.kid);
  assert.equal(claims.sec, minted.sec);
  assert.equal(claims.aud, AUD);

  const nonce = "aa".repeat(32);
  const wrap = await wrapAuth({ publicSpkiB64: minted.pub, sec: minted.sec, nonce });
  const opened = await unwrapAuth({ privatePkcs8B64: minted.priv, wrapB64: wrap });
  assert.deepEqual(opened, { sec: minted.sec, nonce });

  const sig = await signChallenge({
    privatePkcs8B64: minted.priv,
    aud: AUD,
    kid: minted.kid,
    nonce,
  });
  assert.equal(
    await verifyChallenge({ publicSpkiB64: minted.pub, aud: AUD, kid: minted.kid, nonce, sig }),
    true,
  );
  assert.equal(
    await verifyChallenge({
      publicSpkiB64: minted.pub,
      aud: "https://evil.example",
      kid: minted.kid,
      nonce,
      sig,
    }),
    false,
  );
});

test("reset keypair cannot unwrap a wrap for the old token", async () => {
  const oldTok = await mintTokenV1({ aud: AUD });
  const next = await mintTokenV1({ aud: AUD });
  const wrap = await wrapAuth({
    publicSpkiB64: oldTok.pub,
    sec: oldTok.sec,
    nonce: "bb".repeat(32),
  });
  await assert.rejects(
    () => unwrapAuth({ privatePkcs8B64: next.priv, wrapB64: wrap }),
    /HIGH_SEC|OperationError|DOMException/,
  );
  const claims = await verifyTokenV1(oldTok.raw);
  assert.notEqual(claims.kid, next.kid);
});

test("highSecAuthorization challenges then returns Fleet-OAEP", async () => {
  const minted = await mintTokenV1({ aud: AUD });
  const nonce = "cc".repeat(32);
  const sig = await signChallenge({
    privatePkcs8B64: minted.priv,
    aud: AUD,
    kid: minted.kid,
    nonce,
  });
  const fetchImpl = async (url) => {
    assert.match(url, /\/v1\/challenge\?kid=/);
    assert.match(url, new RegExp(minted.kid));
    return {
      ok: true,
      json: async () => ({ nonce, kid: minted.kid, aud: AUD, sig }),
    };
  };
  const header = await highSecAuthorization(minted.raw, AUD, fetchImpl);
  assert.match(header, /^Fleet-OAEP /);
  const parsed = parseAuthorization(header);
  assert.equal(parsed.kind, "oaep");
  assert.equal(parsed.kid, minted.kid);
  const opened = await unwrapAuth({ privatePkcs8B64: minted.priv, wrapB64: parsed.wrap });
  assert.equal(opened.sec, minted.sec);
  assert.equal(opened.nonce, nonce);
});

test("legacy Bearer and aud mismatch fail in English", async () => {
  await assert.rejects(() => highSecAuthorization("flt_" + "ab".repeat(32), AUD), {
    message: HIGH_SEC_UPGRADE,
  });
  const minted = await mintTokenV1({ aud: AUD });
  await assert.rejects(() => highSecAuthorization(minted.raw, "https://evil.example"), {
    message: audMismatch(AUD, "https://evil.example"),
  });
  assert.match(HIGH_SEC_KEY_MISMATCH, /^HIGH_SEC:/);
});
