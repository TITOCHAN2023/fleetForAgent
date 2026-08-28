import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_REPOSITORY = "https://github.com/TITOCHAN2023/fleet-plugins";
const GENERATED_MODULE = join(ROOT, "packages/fleet-tool/official-plugins.generated.mjs");
const PUBLIC_REGISTRY = join(ROOT, "packages/fleet-worker/public/plugin-registry.json");
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ACTION = /^[a-z0-9._-]{1,80}$/;
const VERSION = /^[0-9A-Za-z._+-]{1,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OS = new Set(["darwin", "linux", "windows"]);
const ARCH = new Set(["amd64", "arm64"]);
const RUNTIME = new Set(["task", "peer"]);
const PEER_ABI = new Set(["fleet.plugin.peer.v1"]);
const PEER_TRANSPORT = new Set(["direct_ordered"]);
const PEER_APPROVAL = new Set(["both_once"]);
const PEER_ROLES = new Set(["source", "target"]);

function fail(message) {
  throw new Error(`plugin registry: ${message}`);
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}

function exactKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} contains unsupported field ${key}`);
  }
}

function httpsUrl(value, field, host) {
  const raw = text(value, field);
  let url;
  try { url = new URL(raw); } catch { fail(`${field} must be a valid URL`); }
  if (url.protocol !== "https:" || (host && url.hostname !== host)) fail(`${field} must be HTTPS${host ? ` on ${host}` : ""}`);
  return raw;
}

function actionName(value, field) {
  const action = text(value, field);
  if (!ACTION.test(action) || action === "__proto__") {
    fail(`${field} must use lowercase ASCII [a-z0-9._-] and must not be __proto__`);
  }
  return action;
}

function pluginVersion(value, field) {
  const version = text(value, field);
  if (!VERSION.test(version)) {
    fail(`${field} must use 1-80 ASCII letters, digits, dot, underscore, plus, or hyphen`);
  }
  return version;
}

function officialRepository(value, field) {
  const repository = text(value, field);
  const match = repository.match(
    /^https:\/\/github\.com\/TITOCHAN2023\/([a-z0-9][a-z0-9._-]{0,79})$/,
  );
  if (!match || !ID.test(match[1])) {
    fail(`${field} must be exactly https://github.com/TITOCHAN2023/<valid-id>`);
  }
  return repository;
}

export function validateRegistry(input) {
  if (!input || input.schema_version !== 1 || !Array.isArray(input.plugins)) fail("schema_version 1 and plugins[] are required");
  const ids = new Set();
  const plugins = input.plugins.map((plugin, index) => {
    const field = `plugins.${index}`;
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) fail(`${field} must be an object`);
    if (plugin.schema_version !== 1) fail(`${field}.schema_version must be 1`);
    const id = text(plugin.id, `${field}.id`);
    if (!ID.test(id) || ids.has(id)) fail(`${field}.id is invalid or duplicated`);
    ids.add(id);
    if (!Number.isInteger(plugin.order)) fail(`${field}.order must be an integer`);
    if (!plugin.description || typeof plugin.description !== "object") fail(`${field}.description is required`);
    const description = {
      en: text(plugin.description.en, `${field}.description.en`),
      zh: text(plugin.description.zh, `${field}.description.zh`),
    };
    if (typeof plugin.installable !== "boolean") fail(`${field}.installable must be boolean`);
    if (!Array.isArray(plugin.categories) || !plugin.categories.length) fail(`${field}.categories must be non-empty`);
    if (!Array.isArray(plugin.actions) || !Array.isArray(plugin.artifacts)) fail(`${field}.actions and artifacts must be arrays`);
    const actions = plugin.actions.map((value, actionIndex) => actionName(value, `${field}.actions.${actionIndex}`));
    if (new Set(actions).size !== actions.length) fail(`${field}.actions must be unique`);
    const runtime = plugin.runtime === undefined ? "task" : text(plugin.runtime, `${field}.runtime`);
    if (!RUNTIME.has(runtime)) fail(`${field}.runtime must be task or peer`);
    const rawActionSpecs = plugin.action_specs ?? {};
    if (!rawActionSpecs || typeof rawActionSpecs !== "object" || Array.isArray(rawActionSpecs)) {
      fail(`${field}.action_specs must be an object`);
    }
    const actionSpecs = {};
    const specEntries = Object.entries(rawActionSpecs);
    if (specEntries.length && specEntries.length !== actions.length) {
      fail(`${field}.action_specs must describe every declared action or be omitted`);
    }
    for (const [action, spec] of specEntries) {
      const specField = `${field}.action_specs.${action}`;
      actionName(action, specField);
      if (!actions.includes(action)) fail(`${specField} refers to an undeclared action`);
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail(`${specField} must be an object`);
      exactKeys(spec, ["runtime", "role"], specField);
      const actionRuntime = text(spec.runtime, `${specField}.runtime`);
      if (!RUNTIME.has(actionRuntime)) fail(`${specField}.runtime must be task or peer`);
      if (actionRuntime === "peer") {
        const role = text(spec.role, `${specField}.role`);
        if (!ID.test(role)) fail(`${specField}.role is invalid`);
        actionSpecs[action] = { runtime: actionRuntime, role };
      } else {
        if (spec.role !== undefined) fail(`${specField}.role is only valid for peer actions`);
        actionSpecs[action] = { runtime: actionRuntime };
      }
    }
    const rawPeerProtocols = plugin.peer_protocols ?? [];
    if (!Array.isArray(rawPeerProtocols)) fail(`${field}.peer_protocols must be an array`);
    const protocolIds = new Set();
    const referencedPeerActions = new Set();
    const peerProtocols = rawPeerProtocols.map((protocol, protocolIndex) => {
      const protocolField = `${field}.peer_protocols.${protocolIndex}`;
      if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) fail(`${protocolField} must be an object`);
      exactKeys(protocol, ["id", "abi", "transport", "approval", "roles"], protocolField);
      const id = text(protocol.id, `${protocolField}.id`);
      if (!ID.test(id) || protocolIds.has(id)) fail(`${protocolField}.id is invalid or duplicated`);
      protocolIds.add(id);
      const abi = text(protocol.abi, `${protocolField}.abi`);
      const transport = text(protocol.transport, `${protocolField}.transport`);
      const approval = text(protocol.approval, `${protocolField}.approval`);
      if (!PEER_ABI.has(abi)) fail(`${protocolField}.abi is unsupported`);
      if (!PEER_TRANSPORT.has(transport)) fail(`${protocolField}.transport is unsupported`);
      if (!PEER_APPROVAL.has(approval)) fail(`${protocolField}.approval is unsupported`);
      if (!protocol.roles || typeof protocol.roles !== "object" || Array.isArray(protocol.roles)) {
        fail(`${protocolField}.roles must be an object`);
      }
      const roleEntries = Object.entries(protocol.roles);
      if (
        roleEntries.length !== PEER_ROLES.size ||
        roleEntries.some(([role]) => !PEER_ROLES.has(role))
      ) {
        fail(`${protocolField}.roles must contain exactly source and target`);
      }
      const roles = {};
      for (const [role, actionValue] of roleEntries) {
        const action = text(actionValue, `${protocolField}.roles.${role}`);
        if (!actions.includes(action)) fail(`${protocolField}.roles.${role} refers to an undeclared action`);
        const spec = actionSpecs[action];
        if (!spec || spec.runtime !== "peer" || spec.role !== role) {
          fail(`${protocolField}.roles.${role} must match a peer action_spec`);
        }
        if (referencedPeerActions.has(action)) fail(`${protocolField}.roles references peer action ${action} more than once`);
        referencedPeerActions.add(action);
        roles[role] = action;
      }
      if (!Object.keys(roles).length) fail(`${protocolField}.roles must not be empty`);
      return { id, abi, transport, approval, roles };
    });
    for (const [action, spec] of Object.entries(actionSpecs)) {
      if (spec.runtime === "peer" && !referencedPeerActions.has(action)) {
        fail(`${field}.action_specs.${action} is not referenced by a peer protocol role`);
      }
    }
    if (runtime === "task" && (peerProtocols.length || Object.values(actionSpecs).some((spec) => spec.runtime === "peer"))) {
      fail(`${field}.task runtime cannot declare peer actions or peer_protocols`);
    }
    if (runtime === "peer" && !peerProtocols.length) fail(`${field}.peer runtime requires peer_protocols`);
    if (!Array.isArray(plugin.approval_actions ?? [])) fail(`${field}.approval_actions must be an array`);
    const approvalActions = (plugin.approval_actions ?? []).map((value, actionIndex) => actionName(value, `${field}.approval_actions.${actionIndex}`));
    if (new Set(approvalActions).size !== approvalActions.length || approvalActions.some((action) => !actions.includes(action))) {
      fail(`${field}.approval_actions must be unique members of actions`);
    }
    const repository = officialRepository(plugin.repository, `${field}.repository`);
    const repositoryPath = new URL(repository).pathname.replace(/\/$/, "");
    const version = pluginVersion(plugin.version, `${field}.version`);
    const platforms = new Set();
    const artifacts = plugin.artifacts.map((artifact, artifactIndex) => {
      const artifactField = `${field}.artifacts.${artifactIndex}`;
      if (!artifact || typeof artifact !== "object") fail(`${artifactField} must be an object`);
      if (!OS.has(artifact.os) || !ARCH.has(artifact.arch)) fail(`${artifactField} has an unsupported platform`);
      const platform = `${artifact.os}/${artifact.arch}`;
      if (platforms.has(platform)) fail(`${artifactField} duplicates platform ${platform}`);
      platforms.add(platform);
      const url = httpsUrl(artifact.url, `${artifactField}.url`, "github.com");
      const parsed = new URL(url);
      const releasePrefix = `${repositoryPath}/releases/download/v${version}/`;
      const filename = parsed.pathname.slice(releasePrefix.length);
      if (
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.search ||
        parsed.hash ||
        !parsed.pathname.startsWith(releasePrefix) ||
        !filename ||
        filename.includes("/")
      ) fail(`${artifactField}.url must come from this plugin repository and v${version}`);
      if (!SHA256.test(artifact.sha256)) fail(`${artifactField}.sha256 is invalid`);
      const entrypoint = text(artifact.entrypoint, `${artifactField}.entrypoint`);
      if (entrypoint === "." || entrypoint === ".." || entrypoint.includes("/") || entrypoint.includes("\\")) {
        fail(`${artifactField}.entrypoint must be a non-empty basename other than . or ..`);
      }
      return { os: artifact.os, arch: artifact.arch, url, sha256: artifact.sha256, entrypoint };
    });
    if (plugin.installable) {
      if (plugin.publisher !== "Fleet Official") fail(`${field} installable publisher must be Fleet Official`);
      if (!plugin.actions.length || !artifacts.length) fail(`${field} installable entry requires actions and artifacts`);
    } else if (artifacts.length) {
      fail(`${field} non-installable entry cannot contain artifacts`);
    }
    return {
      schema_version: 1,
      id,
      order: plugin.order,
      name: text(plugin.name, `${field}.name`),
      version,
      publisher: text(plugin.publisher, `${field}.publisher`),
      license: text(plugin.license, `${field}.license`),
      repository,
      homepage: httpsUrl(plugin.homepage, `${field}.homepage`),
      categories: plugin.categories.map((value, categoryIndex) => text(value, `${field}.categories.${categoryIndex}`)),
      description,
      installable: plugin.installable,
      runtime,
      actions,
      approval_actions: approvalActions,
      action_specs: actionSpecs,
      peer_protocols: peerProtocols,
      artifacts,
      source_file: text(plugin.source_file, `${field}.source_file`),
      body: text(plugin.body, `${field}.body`),
    };
  });
  return { schema_version: 1, plugins: plugins.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) };
}

function publicPlugin({ artifacts, ...plugin }) {
  return { ...plugin, platforms: artifacts.map(({ os, arch }) => ({ os, arch })) };
}

export function buildOutputs(registry, revision) {
  const checked = validateRegistry(registry);
  const commit = text(revision, "source commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("source commit must be a full Git SHA");
  const source = { repository: SOURCE_REPOSITORY, commit };
  const module = `// Generated by scripts/sync-plugin-registry.mjs from ${SOURCE_REPOSITORY}/tree/${commit}.\n// Do not edit this file by hand.\n\nfunction deepFreeze(value) {\n  if (value && typeof value === "object" && !Object.isFrozen(value)) {\n    for (const child of Object.values(value)) deepFreeze(child);\n    Object.freeze(value);\n  }\n  return value;\n}\n\nexport const PLUGIN_REGISTRY_SOURCE = deepFreeze(${JSON.stringify(source, null, 2)});\n\nexport const OFFICIAL_PLUGIN_CATALOG = deepFreeze(${JSON.stringify(checked.plugins, null, 2)});\n`;
  const publicRegistry = `${JSON.stringify({ schema_version: 1, source, plugins: checked.plugins.map(publicPlugin) }, null, 2)}\n`;
  return { module, publicRegistry };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function readSource() {
  const sourceOption = option("--source");
  if (sourceOption) {
    const sourcePath = resolve(sourceOption);
    const isDirectory = statSync(sourcePath).isDirectory();
    const directory = isDirectory ? sourcePath : dirname(sourcePath);
    const file = isDirectory ? join(sourcePath, "registry.json") : sourcePath;
    const revision = option("--revision") || execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    return { registry: JSON.parse(readFileSync(file, "utf8")), revision };
  }
  const commitResponse = await fetch("https://api.github.com/repos/TITOCHAN2023/fleet-plugins/commits/main", {
    headers: { accept: "application/vnd.github+json", "user-agent": "fleet-plugin-registry-sync" },
  });
  if (!commitResponse.ok) fail(`GitHub commit lookup failed with HTTP ${commitResponse.status}`);
  const revision = (await commitResponse.json()).sha;
  const registryResponse = await fetch(`https://raw.githubusercontent.com/TITOCHAN2023/fleet-plugins/${revision}/registry.json`);
  if (!registryResponse.ok) fail(`registry download failed with HTTP ${registryResponse.status}`);
  return { registry: await registryResponse.json(), revision };
}

export async function syncRegistry() {
  const { registry, revision } = await readSource();
  const output = buildOutputs(registry, revision);
  writeFileSync(GENERATED_MODULE, output.module);
  writeFileSync(PUBLIC_REGISTRY, output.publicRegistry);
  console.log(`synced ${registry.plugins.length} plugin(s) from ${revision}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await syncRegistry();
