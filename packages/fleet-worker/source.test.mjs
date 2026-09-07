import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DEFAULT_SOURCE_REPO,
  isSourcePath,
  isTrustPath,
  publicSource,
  sourceIdentity,
  trustPage,
} from "./src/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("sourceIdentity requires a 40-hex commit to be verified", () => {
  assert.equal(sourceIdentity({}).verified, false);
  assert.equal(sourceIdentity({ SOURCE_COMMIT: "main" }).verified, false);
  assert.equal(sourceIdentity({ SOURCE_COMMIT: "0123456789abcdef" }).verified, false);
  assert.equal(sourceIdentity({ SOURCE_COMMIT: COMMIT.toUpperCase() }).verified, true);
  const id = sourceIdentity({
    SOURCE_COMMIT: COMMIT,
    SOURCE_TAG: "v0.6.6",
    SOURCE_WORKFLOW_RUN: "https://github.com/TITOCHAN2023/fleetForAgent/actions/runs/1",
    SOURCE_BUNDLE_SHA256: "a".repeat(64),
  });
  assert.equal(id.source_repo, DEFAULT_SOURCE_REPO);
  assert.equal(id.source_commit, COMMIT);
  assert.equal(id.source_commit_url, `${DEFAULT_SOURCE_REPO}/commit/${COMMIT}`);
  assert.equal(id.source_tree, `${DEFAULT_SOURCE_REPO}/tree/${COMMIT}`);
  assert.equal(id.source_archive, `${DEFAULT_SOURCE_REPO}/archive/${COMMIT}.tar.gz`);
  assert.equal(id.source_tag, "v0.6.6");
  assert.equal(id.source_bundle_sha256, "a".repeat(64));
  assert.equal(id.verified, true);
});

test("publicSource is unauthenticated JSON plus backend label", () => {
  const body = publicSource({ SOURCE_COMMIT: COMMIT }, { backend: "worker" });
  assert.equal(body.backend, "worker");
  assert.equal(body.verified, true);
  assert.equal(isSourcePath("/source/"), true);
  assert.equal(isSourcePath("/v1/source"), true);
  assert.equal(isSourcePath("/v1/health"), false);
  assert.equal(isTrustPath("/trust"), true);
  assert.equal(isTrustPath("/help"), false);
});

test("trust page is zero-JS HTML and escapes untrusted fields", () => {
  const html = trustPage(
    sourceIdentity({
      SOURCE_COMMIT: COMMIT,
      SOURCE_REPO: "https://github.com/TITOCHAN2023/fleetForAgent",
    }),
    { origin: "https://fleet.ginfo.cc" },
  );
  assert.match(html, /<!doctype html>/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, new RegExp(COMMIT));
  assert.match(html, /verified/);
  assert.match(html, /curl -sS https:\/\/fleet\.ginfo\.cc\/source/);
  const dirty = trustPage(
    sourceIdentity({ SOURCE_COMMIT: COMMIT, SOURCE_TAG: "<script>alert(1)</script>" }),
  );
  assert.doesNotMatch(dirty, /<script>alert\(1\)<\/script>/);
  assert.match(dirty, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("Worker config intercepts /source and /trust before the SPA", () => {
  const toml = readFileSync(join(here, "wrangler.toml"), "utf8");
  assert.match(toml, /run_worker_first = \["\/source", "\/trust"/);
  assert.match(toml, /SOURCE_REPO = "https:\/\/github\.com\/TITOCHAN2023\/fleetForAgent"/);
  assert.doesNotMatch(toml, /SOURCE_COMMIT\s*=/);
});
