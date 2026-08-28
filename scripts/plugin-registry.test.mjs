import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOutputs, validateRegistry } from "./sync-plugin-registry.mjs";

const revision = "b10eb52ac817e500f459c3fa9e31ddc093aa5b25";
const source = {
  schema_version: 1,
  plugins: [{
    schema_version: 1,
    id: "fleet.acp",
    order: 10,
    name: "Fleet ACP",
    version: "0.1.0",
    publisher: "Fleet Official",
    license: "MIT",
    repository: "https://github.com/TITOCHAN2023/fleet-acp-plugin",
    homepage: "https://github.com/TITOCHAN2023/fleet-acp-plugin",
    categories: ["Agent", "ACP"],
    description: { en: "Delegate to an ACP agent.", zh: "把任务交给 ACP Agent。" },
    installable: true,
    actions: ["delegate"],
    approval_actions: ["delegate"],
    artifacts: [{
      os: "darwin",
      arch: "amd64",
      url: "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v0.1.0/fleet-acp-plugin-darwin-amd64",
      sha256: "f1ca6f8db552703dc86965bddccfcfe95f6a8fb60700cc58940668e26a641f48",
      entrypoint: "fleet-acp-plugin",
    }],
    source_file: "plugins/fleet-acp.md",
    body: "# Fleet ACP",
  }],
};

test("plugin registry validates curated Markdown output", () => {
  const registry = validateRegistry(source);
  assert.equal(registry.plugins.length, 1);
  assert.equal(registry.plugins[0].id, "fleet.acp");
  assert.equal(registry.plugins[0].artifacts.length, 1);
  assert.deepEqual(registry.plugins[0].approval_actions, ["delegate"]);
});

test("public plugin registry omits download URLs but records its source commit", () => {
  const output = buildOutputs(source, revision);
  const publicRegistry = JSON.parse(output.publicRegistry);
  assert.equal(publicRegistry.source.commit, revision);
  assert.equal(publicRegistry.plugins[0].artifacts, undefined);
  assert.deepEqual(publicRegistry.plugins[0].platforms[0], { os: "darwin", arch: "amd64" });
  assert.match(output.module, /OFFICIAL_PLUGIN_CATALOG/);
  assert.match(output.module, new RegExp(revision));
});

test("installable registry entries cannot escape the Fleet release trust root", () => {
  const tampered = structuredClone(source);
  tampered.plugins[0].artifacts[0].url = "https://github.com/evil/example/releases/download/v1/payload";
  assert.throws(() => validateRegistry(tampered), /must come from this plugin repository/);
});

test("artifact repository, release version, and approval actions are exact", () => {
  const wrongRepository = structuredClone(source);
  wrongRepository.plugins[0].artifacts[0].url =
    "https://github.com/TITOCHAN2023/another-plugin/releases/download/v0.1.0/payload";
  assert.throws(() => validateRegistry(wrongRepository), /this plugin repository/);

  const wrongVersion = structuredClone(source);
  wrongVersion.plugins[0].artifacts[0].url =
    "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v9.9.9/payload";
  assert.throws(() => validateRegistry(wrongVersion), /v0.1.0/);

  const undeclaredApproval = structuredClone(source);
  undeclaredApproval.plugins[0].approval_actions = ["delete_everything"];
  assert.throws(() => validateRegistry(undeclaredApproval), /members of actions/);
});
