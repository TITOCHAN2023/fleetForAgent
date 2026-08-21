import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCanAddDevice, FLEET_CAP, makeDeviceSlug } from "./cap";
import { resolveNode } from "./world";
import { runSimulated } from "./shell";

test("fleet has no machine cap", () => {
  assert.equal(FLEET_CAP, null);
  for (const n of [0, 3, 30, 300, 3000]) {
    assert.doesNotThrow(() => assertCanAddDevice(n));
  }
});

test("slugs stay unique across many names", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const slug = makeDeviceSlug(`studio pc ${i}`);
    assert.equal(seen.has(slug), false);
    seen.add(slug);
  }
  assert.equal(seen.size, 40);
});

test("machines past the three demo pods still get isolated egress", () => {
  const extra = resolveNode({
    slug: "office-nuc-aa12",
    name: "办公室 NUC",
    os: "linux",
    arch: "x86_64",
    locationTag: "home",
  });
  assert.equal(extra.podId.startsWith("pod-"), true);
  const sh = runSimulated(
    { name: extra.name, slug: extra.slug, os: extra.os, arch: extra.arch, locationTag: extra.locationTag },
    "ip addr",
  );
  assert.match(sh.stdout, /inet none/);
  assert.doesNotMatch(sh.stdout, /10\.20\.0\./);
});
