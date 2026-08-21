import assert from "node:assert/strict";
import { test } from "node:test";
import { runLabSuite } from "./lab";
import { LAB_DEVICES, runSimulated } from "./shell";
import { dispatchRun } from "./hub";

test("lab suite: every OS, NAT, and simulated worker check passes", () => {
  const result = runLabSuite();
  const failed = result.checks.filter((c) => !c.ok);
  assert.equal(
    failed.length,
    0,
    failed.map((c) => `${c.id}: ${c.title} :: ${c.detail}`).join("\n"),
  );
  assert.ok(result.passed >= 30, `expected a thick suite, got ${result.passed}`);
});

test("three uname -s strings are mutually exclusive", () => {
  const d = runSimulated(LAB_DEVICES.find((x) => x.os === "darwin")!, "uname -s").stdout.trim();
  const l = runSimulated(LAB_DEVICES.find((x) => x.os === "linux")!, "uname -s").stdout.trim();
  const w = runSimulated(LAB_DEVICES.find((x) => x.os === "windows")!, "uname -s").stdout.trim();
  assert.equal(d, "Darwin");
  assert.equal(l, "Linux");
  assert.equal(w, "Windows_NT");
  assert.notEqual(d, l);
  assert.notEqual(l, w);
});

test("hub offline short-circuits before Windows ver", () => {
  const win = LAB_DEVICES.find((x) => x.os === "windows")!;
  const res = dispatchRun({ device: win, online: false, command: "ver" });
  assert.equal(res.status, "offline");
  assert.equal(res.stdout, "");
});
