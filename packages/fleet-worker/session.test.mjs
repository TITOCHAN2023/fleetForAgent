import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANON_FINGERPRINT,
  FLEET_OPERATOR_HEADER,
  createSessionBook,
  fingerprintFromHeaders,
  resolveTicket,
} from "./src/session.mjs";

test("missing operator header is the anonymous fingerprint", () => {
  assert.equal(fingerprintFromHeaders(undefined), ANON_FINGERPRINT);
  assert.equal(fingerprintFromHeaders({}), ANON_FINGERPRINT);
  assert.equal(fingerprintFromHeaders(new Headers()), ANON_FINGERPRINT);
});

test("X-Fleet-Operator is read from Headers and plain objects", () => {
  const fp = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(fingerprintFromHeaders(new Headers({ [FLEET_OPERATOR_HEADER]: fp })), fp);
  assert.equal(fingerprintFromHeaders({ "x-fleet-operator": fp }), fp);
  assert.equal(fingerprintFromHeaders({ [FLEET_OPERATOR_HEADER]: ` ${fp} ` }), fp);
});

test("resolveTicket drops a ticket owned by another fingerprint", () => {
  const foreign = resolveTicket({
    fingerprint: "fp-a",
    ticket: "corr-b",
    owner: "fp-b",
    live: "corr-a",
  });
  assert.equal(foreign.drop, true);
  assert.equal(foreign.corr, "");

  const mine = resolveTicket({
    fingerprint: "fp-a",
    ticket: "corr-a",
    owner: "fp-a",
    live: "corr-a",
  });
  assert.equal(mine.drop, false);
  assert.equal(mine.corr, "corr-a");
});

test("no ticket uses the live session for this fingerprint", () => {
  const hit = resolveTicket({ fingerprint: "fp-a", ticket: "", owner: undefined, live: "live-a" });
  assert.equal(hit.drop, false);
  assert.equal(hit.corr, "live-a");
});

test("unclaimed ticket is anonymous so 0.2.7 clients keep working", () => {
  const old = resolveTicket({ fingerprint: ANON_FINGERPRINT, ticket: "old-corr", owner: undefined, live: "" });
  assert.equal(old.drop, false);
  assert.equal(old.corr, "old-corr");

  const newbie = resolveTicket({ fingerprint: "fp-new", ticket: "old-corr", owner: undefined, live: "" });
  assert.equal(newbie.drop, true);
});

test("session book claims, isolates, and finishes without leaking", () => {
  const book = createSessionBook();
  book.claim("fp-a", "c-a");
  book.claim("fp-b", "c-b");
  assert.deepEqual(book.aliveOf("fp-a"), ["c-a"]);
  assert.equal(book.liveOf("fp-a"), "c-a");
  assert.equal(book.resolve("fp-a", "c-b").drop, true);
  assert.equal(book.resolve("fp-a", "").corr, "c-a");
  assert.equal(book.resolve("fp-b", "c-a").drop, true);
  book.finish("c-a");
  assert.deepEqual(book.aliveOf("fp-a"), []);
  assert.equal(book.liveOf("fp-a"), "c-a");
  assert.equal(book.resolve("fp-a", "c-a").drop, false);
});
