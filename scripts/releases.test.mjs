import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dl = join(root, "public/dl");

function tarText(block, start, length) {
  const nul = block.indexOf(0, start);
  const end = nul < 0 || nul > start + length ? start + length : nul;
  return block.subarray(start, end).toString("utf8");
}

function tarOctal(block, start, length) {
  const value = tarText(block, start, length).trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function tarEntries(path) {
  const archive = gunzipSync(readFileSync(path));
  const entries = [];
  let ended = false;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(offset + 1024 <= archive.length, `${path}: missing second end block`);
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        `${path}: non-zero data after end blocks`,
      );
      ended = true;
      break;
    }
    assert.equal(tarText(header, 257, 6), "ustar", `${path}: format`);
    const wantChecksum = tarOctal(header, 148, 8);
    const gotChecksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    assert.equal(gotChecksum, wantChecksum, `${path}: header checksum`);
    const size = tarOctal(header, 124, 12);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `${path}: invalid entry size`);
    entries.push({
      name: tarText(header, 0, 100),
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      type: header[156],
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(ended, `${path}: missing end blocks`);
  return entries;
}

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

test("linux tarballs are clean root-owned ustar archives", () => {
  for (const arch of ["amd64", "arm64"]) {
    const path = join(dl, `fleet-agent-linux-${arch}.tar.gz`);
    assert.ok(statSync(path).size > 100_000);
    const entries = tarEntries(path);
    assert.deepEqual(entries.map(({ name }) => name), ["fleet-agent", "fleet"]);
    for (const entry of entries) {
      assert.equal(entry.type, 0x30, `${arch}: ${entry.name} is not a regular file`);
      assert.equal(entry.mode, 0o755, `${arch}: ${entry.name} mode`);
      assert.equal(entry.uid, 0, `${arch}: ${entry.name} uid`);
      assert.equal(entry.gid, 0, `${arch}: ${entry.name} gid`);
    }
  }
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
