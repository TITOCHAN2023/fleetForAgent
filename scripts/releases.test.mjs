import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dl = join(root, "public/dl");

test("windows release is a PE executable", () => {
  const p = join(dl, "KeelAgent-windows-amd64.exe");
  const buf = readFileSync(p);
  assert.equal(buf[0], 0x4d);
  assert.equal(buf[1], 0x5a);
  assert.ok(statSync(p).size > 1_000_000);
});

test("mac releases exist for arm64 and amd64", () => {
  for (const name of ["KeelAgent-macos-arm64.dmg", "KeelAgent-macos-amd64.dmg", "KeelAgent-macos-arm64.zip", "KeelAgent-macos-amd64.zip"]) {
    const n = statSync(join(dl, name)).size;
    assert.ok(n > 100_000, name);
  }
});

test("linux tarball exists", () => {
  assert.ok(statSync(join(dl, "keel-agent-linux-amd64.tar.gz")).size > 100_000);
});

test("checksums cover every installer", () => {
  const txt = readFileSync(join(dl, "checksums.txt"), "utf8");
  for (const name of [
    "KeelAgent-windows-amd64.exe",
    "KeelAgent-macos-arm64.dmg",
    "KeelAgent-macos-amd64.dmg",
    "keel-agent-linux-amd64.tar.gz",
  ]) {
    assert.ok(txt.includes(name), name);
  }
});
