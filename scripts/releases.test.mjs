import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dl = join(root, "public/dl");

test("windows release is a PE executable", () => {
  const p = join(dl, "FleetAgent-windows-amd64.exe");
  const buf = readFileSync(p);
  assert.equal(buf[0], 0x4d);
  assert.equal(buf[1], 0x5a);
  assert.ok(statSync(p).size > 1_000_000);
});

test("mac releases exist for arm64 and amd64", () => {
  for (const name of ["FleetAgent-macos-arm64.dmg", "FleetAgent-macos-amd64.dmg", "FleetAgent-macos-arm64.zip", "FleetAgent-macos-amd64.zip"]) {
    const n = statSync(join(dl, name)).size;
    assert.ok(n > 100_000, name);
  }
});

test("mac dmg is a disk image, not a renamed zip", () => {
  for (const name of ["FleetAgent-macos-arm64.dmg", "FleetAgent-macos-amd64.dmg"]) {
    const buf = readFileSync(join(dl, name));
    assert.notEqual(buf[0], 0x50, `${name} starts with P (zip PK header) — do not copy zip to .dmg`);
    assert.notEqual(buf[1], 0x4b, `${name} looks like zip`);
  }
});

test("mac zip is actually zip", () => {
  for (const name of ["FleetAgent-macos-arm64.zip", "FleetAgent-macos-amd64.zip"]) {
    const buf = readFileSync(join(dl, name));
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  }
});

test("linux tarball exists", () => {
  assert.ok(statSync(join(dl, "fleet-agent-linux-amd64.tar.gz")).size > 100_000);
  assert.ok(statSync(join(dl, "fleet-agent-linux-arm64.tar.gz")).size > 100_000);
});

test("checksums cover every installer", () => {
  const txt = readFileSync(join(dl, "checksums.txt"), "utf8");
  for (const name of [
    "FleetAgent-windows-amd64.exe",
    "FleetAgent-macos-arm64.dmg",
    "FleetAgent-macos-amd64.dmg",
    "fleet-agent-linux-amd64.tar.gz",
    "fleet-agent-linux-arm64.tar.gz",
  ]) {
    assert.ok(txt.includes(name), name);
  }
});
