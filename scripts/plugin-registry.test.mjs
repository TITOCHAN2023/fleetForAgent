import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  OFFICIAL_PLUGIN_CATALOG,
  PLUGIN_REGISTRY_SOURCE,
} from "../packages/fleet-tool/official-plugins.generated.mjs";
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

  const decoratedArtifact = structuredClone(source);
  decoratedArtifact.plugins[0].artifacts[0].url += "?download=1";
  assert.throws(() => validateRegistry(decoratedArtifact), /this plugin repository/);

  const nestedArtifact = structuredClone(source);
  nestedArtifact.plugins[0].artifacts[0].url =
    "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v0.1.0/bin/payload";
  assert.throws(() => validateRegistry(nestedArtifact), /this plugin repository/);
});

test("actions are lowercase ASCII and action_specs cannot poison __proto__", () => {
  for (const action of ["Run", "run/task", "run task", "运行", "__proto__"]) {
    const tampered = structuredClone(source);
    tampered.plugins[0].actions = [action];
    tampered.plugins[0].approval_actions = [];
    assert.throws(() => validateRegistry(tampered), /lowercase ASCII|__proto__/);
  }

  const polluted = structuredClone(source);
  polluted.plugins[0].action_specs = JSON.parse(
    '{"__proto__":{"runtime":"task"}}',
  );
  assert.throws(() => validateRegistry(polluted), /__proto__/);
});

test("repository is one exact Fleet-owned GitHub path without query or fragment", () => {
  for (const repository of [
    "https://github.com/TITOCHAN2023/fleet-acp-plugin?ref=main",
    "https://github.com/TITOCHAN2023/fleet-acp-plugin#readme",
    "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases",
    "https://github.com/TITOCHAN2023/fleet-acp-plugin/",
    "https://github.com/TITOCHAN2023/_invalid",
  ]) {
    const tampered = structuredClone(source);
    tampered.plugins[0].repository = repository;
    assert.throws(() => validateRegistry(tampered), /repository must be exactly/);
  }
});

test("entrypoint is a real basename and version uses the Agent character set", () => {
  for (const entrypoint of ["", ".", "..", "bin/plugin", "bin\\plugin"]) {
    const tampered = structuredClone(source);
    tampered.plugins[0].artifacts[0].entrypoint = entrypoint;
    assert.throws(
      () => validateRegistry(tampered),
      /non-empty string|non-empty basename/,
    );
  }

  const valid = structuredClone(source);
  valid.plugins[0].version = "1.0.0_RC+1";
  valid.plugins[0].artifacts[0].url =
    "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v1.0.0_RC+1/payload";
  assert.equal(validateRegistry(valid).plugins[0].version, "1.0.0_RC+1");

  for (const version of ["1/2", "1 2", "版本1"]) {
    const tampered = structuredClone(source);
    tampered.plugins[0].version = version;
    assert.throws(() => validateRegistry(tampered), /version must use/);
  }
});

test("peer runtime is generic, closed over declared actions, and uses the fixed ABI", () => {
  const peer = structuredClone(source);
  peer.plugins[0].runtime = "peer";
  peer.plugins[0].actions = ["prepare_source", "prepare_target"];
  peer.plugins[0].approval_actions = ["prepare_source", "prepare_target"];
  peer.plugins[0].action_specs = {
    prepare_source: { runtime: "peer", role: "source" },
    prepare_target: { runtime: "peer", role: "target" },
  };
  peer.plugins[0].peer_protocols = [{
    id: "fleet.transfer.v2",
    abi: "fleet.plugin.peer.v1",
    transport: "direct_ordered",
    approval: "both_once",
    roles: { source: "prepare_source", target: "prepare_target" },
  }];
  const checked = validateRegistry(peer).plugins[0];
  assert.equal(checked.runtime, "peer");
  assert.equal(checked.peer_protocols[0].abi, "fleet.plugin.peer.v1");
  assert.equal(checked.peer_protocols[0].roles.target, "prepare_target");

  const undeclared = structuredClone(peer);
  undeclared.plugins[0].peer_protocols[0].roles.target = "write_anywhere";
  assert.throws(() => validateRegistry(undeclared), /undeclared action/);

  const mismatchedRole = structuredClone(peer);
  mismatchedRole.plugins[0].action_specs.prepare_target.role = "sink";
  assert.throws(() => validateRegistry(mismatchedRole), /match a peer action_spec/);

  const unsupportedABI = structuredClone(peer);
  unsupportedABI.plugins[0].peer_protocols[0].abi = "plugin-specific-stream";
  assert.throws(() => validateRegistry(unsupportedABI), /abi is unsupported/);

  const inventedProtocolField = structuredClone(peer);
  inventedProtocolField.plugins[0].peer_protocols[0].file_chunk_size = 1024;
  assert.throws(() => validateRegistry(inventedProtocolField), /unsupported field file_chunk_size/);

  const missingRole = structuredClone(peer);
  delete missingRole.plugins[0].peer_protocols[0].roles.target;
  assert.throws(() => validateRegistry(missingRole), /exactly source and target/);

  const extraRole = structuredClone(peer);
  extraRole.plugins[0].peer_protocols[0].roles.observer = "prepare_source";
  assert.throws(() => validateRegistry(extraRole), /exactly source and target/);
});

test("top-level peer runtime is the explicit capability envelope for hybrid actions", () => {
  const hybrid = structuredClone(source);
  hybrid.plugins[0].runtime = "peer";
  hybrid.plugins[0].actions = ["delegate", "prepare_source", "prepare_target"];
  hybrid.plugins[0].action_specs = {
    delegate: { runtime: "task" },
    prepare_source: { runtime: "peer", role: "source" },
    prepare_target: { runtime: "peer", role: "target" },
  };
  hybrid.plugins[0].peer_protocols = [{
    id: "fleet.transfer.v2",
    abi: "fleet.plugin.peer.v1",
    transport: "direct_ordered",
    approval: "both_once",
    roles: { source: "prepare_source", target: "prepare_target" },
  }];
  const checked = validateRegistry(hybrid).plugins[0];
  assert.equal(checked.runtime, "peer");
  assert.deepEqual(checked.action_specs.delegate, { runtime: "task" });

  const mislabeled = structuredClone(hybrid);
  mislabeled.plugins[0].runtime = "task";
  assert.throws(() => validateRegistry(mislabeled), /task runtime cannot declare peer/);
});

test("legacy registry entries remain task plugins without new fields", () => {
  const checked = validateRegistry(source).plugins[0];
  assert.equal(checked.runtime, "task");
  assert.deepEqual(checked.action_specs, {});
  assert.deepEqual(checked.peer_protocols, []);
});

test("committed Tool and Worker snapshots pin the release-candidate plugin contract", async () => {
  const publicRegistry = JSON.parse(
    await readFile(new URL("../packages/fleet-worker/public/plugin-registry.json", import.meta.url)),
  );
  assert.deepEqual(publicRegistry.source, PLUGIN_REGISTRY_SOURCE);

  const toolById = new Map(OFFICIAL_PLUGIN_CATALOG.map((plugin) => [plugin.id, plugin]));
  const publicById = new Map(publicRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  for (const [id, version] of [["fleet.acp", "0.1.2"], ["fleet.transfer", "0.2.1"]]) {
    assert.equal(toolById.get(id)?.version, version, `Tool snapshot ${id}`);
    assert.equal(publicById.get(id)?.version, version, `Worker snapshot ${id}`);
  }

  const transfer = toolById.get("fleet.transfer");
  assert.equal(transfer?.runtime, "peer");
  assert.deepEqual(transfer?.approval_actions, ["prepare_source", "prepare_target"]);
  assert.deepEqual(transfer?.peer_protocols, [{
    id: "fleet.transfer.v2",
    abi: "fleet.plugin.peer.v1",
    transport: "direct_ordered",
    approval: "both_once",
    roles: { source: "prepare_source", target: "prepare_target" },
  }]);
});
