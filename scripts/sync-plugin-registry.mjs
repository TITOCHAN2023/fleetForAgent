import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_REPOSITORY = "https://github.com/TITOCHAN2023/fleet-plugins";
const GENERATED_MODULE = join(ROOT, "packages/fleet-tool/official-plugins.generated.mjs");
const PUBLIC_REGISTRY = join(ROOT, "packages/fleet-worker/public/plugin-registry.json");
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OS = new Set(["darwin", "linux", "windows"]);
const ARCH = new Set(["amd64", "arm64"]);

function fail(message) {
  throw new Error(`plugin registry: ${message}`);
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}

function httpsUrl(value, field, host) {
  const raw = text(value, field);
  let url;
  try { url = new URL(raw); } catch { fail(`${field} must be a valid URL`); }
  if (url.protocol !== "https:" || (host && url.hostname !== host)) fail(`${field} must be HTTPS${host ? ` on ${host}` : ""}`);
  return raw;
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
    const repository = httpsUrl(plugin.repository, `${field}.repository`, "github.com");
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
      if (!parsed.pathname.startsWith("/TITOCHAN2023/") || !parsed.pathname.includes("/releases/download/")) fail(`${artifactField}.url is outside the Fleet release trust root`);
      if (!SHA256.test(artifact.sha256)) fail(`${artifactField}.sha256 is invalid`);
      const entrypoint = text(artifact.entrypoint, `${artifactField}.entrypoint`);
      if (entrypoint.includes("/") || entrypoint.includes("\\")) fail(`${artifactField}.entrypoint must be a basename`);
      return { os: artifact.os, arch: artifact.arch, url, sha256: artifact.sha256, entrypoint };
    });
    if (plugin.installable) {
      if (plugin.publisher !== "Fleet Official") fail(`${field} installable publisher must be Fleet Official`);
      if (!new URL(repository).pathname.startsWith("/TITOCHAN2023/")) fail(`${field} installable repository is outside the Fleet trust root`);
      if (!plugin.actions.length || !artifacts.length) fail(`${field} installable entry requires actions and artifacts`);
    } else if (artifacts.length) {
      fail(`${field} non-installable entry cannot contain artifacts`);
    }
    return {
      schema_version: 1,
      id,
      order: plugin.order,
      name: text(plugin.name, `${field}.name`),
      version: text(plugin.version, `${field}.version`),
      publisher: text(plugin.publisher, `${field}.publisher`),
      license: text(plugin.license, `${field}.license`),
      repository,
      homepage: httpsUrl(plugin.homepage, `${field}.homepage`),
      categories: plugin.categories.map((value, categoryIndex) => text(value, `${field}.categories.${categoryIndex}`)),
      description,
      installable: plugin.installable,
      actions: plugin.actions.map((value, actionIndex) => text(value, `${field}.actions.${actionIndex}`)),
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
