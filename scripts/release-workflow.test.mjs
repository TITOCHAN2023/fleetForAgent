import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/release-agent.yml",
  ".github/workflows/windows-plugin-process-tree.yml",
];

test("GitHub Actions are pinned to immutable commits with an exact version comment", () => {
  for (const relative of workflows) {
    const source = readFileSync(join(root, relative), "utf8");
    const uses = [...source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(v\d+\.\d+\.\d+))?\s*$/gm)];
    assert.ok(uses.length > 0, `${relative}: no actions found`);
    for (const [, action, version] of uses) {
      assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${relative}: floating action ${action}`);
      assert.match(version ?? "", /^v\d+\.\d+\.\d+$/, `${relative}: missing exact version comment for ${action}`);
    }
  }
});

test("release publication is rerunnable and verifies every uploaded asset", () => {
  const source = readFileSync(join(root, ".github/workflows/release-agent.yml"), "utf8");
  assert.match(source, /gh release view "\$GITHUB_REF_NAME"/);
  assert.match(source, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(source, /gh release upload "\$GITHUB_REF_NAME" --clobber "\$\{assets\[@\]\}"/);
  assert.match(source, /test "\$\{#tool_archives\[@\]\}" = "1"/);
  assert.match(source, /test "\$\{#tool_checksums\[@\]\}" = "1"/);
  assert.match(source, /"public\/dl\/checksums-\$\{version\}\.txt"/);
  assert.match(source, /for asset in "\$\{assets\[@\]\}"/);
  assert.match(source, /test -f "\$asset"/);
  assert.match(source, /grep -Fxc "\$name" "\$published"/);
});

test("macOS release validation serializes process and PTY packages", () => {
  const source = readFileSync(join(root, ".github/workflows/release-agent.yml"), "utf8");
  assert.match(
    source,
    /- name: Test Agent on macOS[\s\S]*?working-directory: packages\/fleet-agent[\s\S]*?run: go test -p 1 \.\/\.\.\./,
  );
});
