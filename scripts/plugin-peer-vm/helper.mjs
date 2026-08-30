#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const TRANSFER_ROOT = path.resolve(ROOT, "../fleet-transfer-plugin");
const CATALOG_MODULE = path.join(ROOT, "packages/fleet-tool/official-plugins.generated.mjs");
const EXPECTED_VERSION = "0.2.1";
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const HUB_IN_CONTAINER = "http://fleet-hub.test:8787";
const TRANSFER_CHUNK = 32 << 10;
const RESUME_STATE_VERSION = 2;
const RESUME_STATE_KEYS = [
  "chunk_size",
  "destination",
  "phase",
  "prefix_sha256",
  "sha256",
  "size",
  "source_sha256",
  "transfer_id",
  "v",
  "verified_offset",
];

function fail(message) {
  throw new Error(`plugin-peer-vm: ${message}`);
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function runRoot() {
  return path.resolve(requiredEnv("VM_RUN_ROOT"));
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256File(file) {
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function sha256Prefix(file, length) {
  if (!Number.isSafeInteger(length) || length < 0) fail(`invalid prefix length ${length}`);
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    while (position < length) {
      const wanted = Math.min(buffer.length, length - position);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (!bytesRead) fail(`${file} ended before verified prefix ${length}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function transferStem(destination) {
  if (!path.posix.isAbsolute(destination) || path.posix.normalize(destination) !== destination) {
    fail(`runtime destination must be a normalized absolute POSIX path: ${destination}`);
  }
  return `.fleet-transfer-${sha256Text(destination).slice(0, 16)}`;
}

function sourceBinding(sessionId, source) {
  const canonical = `fleet.transfer.source.v1\0${sessionId}\0${JSON.stringify({ kind: source.kind, id: source.id })}`;
  return sha256Text(canonical);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys ${actual.join(",")} do not match ${wanted.join(",")}`);
  }
}

async function regularFile(file, label) {
  const info = await lstat(file).catch((error) =>
    fail(`${label} is unavailable: ${error.message}`),
  );
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return info;
}

async function transferArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) =>
    fail(`cannot inspect transfer artifacts in ${directory}: ${error.message}`),
  );
  return entries
    .filter((entry) => entry.name.startsWith(".fleet-transfer-"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function exactTransferArtifacts(directory, expected, { allowStateTemps = false } = {}) {
  const artifacts = await transferArtifacts(directory);
  const names = artifacts.map((entry) => entry.name);
  const extras = names.filter((name) => !expected.includes(name));
  const stateTemps = extras.filter((name) => /^\.fleet-transfer-state-/.test(name));
  const invalidExtras = allowStateTemps
    ? extras.filter((name) => !stateTemps.includes(name))
    : extras;
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length || invalidExtras.length || stateTemps.length > (allowStateTemps ? 1 : 0)) {
    fail(
      `transfer artifacts in ${directory} are wrong; missing=${missing.join(",") || "none"} ` +
        `unexpected=${invalidExtras.join(",") || "none"} state_temps=${stateTemps.join(",") || "none"}`,
    );
  }
  for (const entry of artifacts) {
    if (
      (expected.includes(entry.name) || stateTemps.includes(entry.name)) &&
      (!entry.isFile() || entry.isSymbolicLink())
    ) {
      fail(`${entry.name} must be a regular non-symlink file`);
    }
  }
  return artifacts;
}

async function readResumeState(file) {
  const info = await regularFile(file, "transfer state sidecar");
  if ((info.mode & 0o777) !== 0o600)
    fail(`transfer state sidecar mode is ${(info.mode & 0o777).toString(8)}, expected 600`);
  const state = await jsonFile(file);
  exactKeys(state, RESUME_STATE_KEYS, "transfer state sidecar");
  return state;
}

function validateStateBinding(state, expected, phase) {
  const fields = {
    v: RESUME_STATE_VERSION,
    phase,
    destination: expected.destination,
    size: expected.size,
    sha256: expected.sha256,
    chunk_size: TRANSFER_CHUNK,
    transfer_id: expected.sessionId,
    source_sha256: sourceBinding(expected.sessionId, expected.source),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (state[key] !== value)
      fail(
        `transfer state ${key}=${JSON.stringify(state[key])}, expected ${JSON.stringify(value)}`,
      );
  }
}

async function expectedTransfer(sourceFile, destination, sessionId, source) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    fail(`invalid transfer session id ${sessionId}`);
  }
  if (!source || !["device", "tool"].includes(source.kind) || !String(source.id ?? "").trim()) {
    fail("session has no canonical source endpoint");
  }
  const sourceInfo = await regularFile(sourceFile, "transfer source");
  return {
    destination,
    sessionId,
    source: { kind: source.kind, id: String(source.id) },
    size: sourceInfo.size,
    sha256: await sha256File(sourceFile),
  };
}

async function writeJSON(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(file, mode);
}

async function writePatternFile(file, size, seed) {
  if (!Number.isSafeInteger(size) || size < 0) fail(`invalid fixture size ${size}`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 131 + seed * 17) & 0xff;
    let written = 0;
    while (written < size) {
      let offset = 0;
      const wanted = Math.min(chunk.length, size - written);
      while (offset < wanted) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          wanted - offset,
          written + offset,
        );
        if (!bytesWritten) fail(`short write while creating ${file}`);
        offset += bytesWritten;
      }
      written += wanted;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadTransferDeclaration() {
  const generated = await import(`${pathToFileURL(CATALOG_MODULE).href}?vm=${Date.now()}`);
  const plugin = generated.OFFICIAL_PLUGIN_CATALOG?.find((row) => row.id === "fleet.transfer");
  if (!plugin) fail("generated official catalog has no fleet.transfer entry");
  if (plugin.version !== EXPECTED_VERSION) {
    fail(
      `generated catalog has fleet.transfer ${plugin.version}; expected ${EXPECTED_VERSION}; sync the final registry first`,
    );
  }
  if (plugin.runtime !== "peer") fail("fleet.transfer must use the peer runtime");
  const protocol = plugin.peer_protocols?.find((row) => row.id === "fleet.transfer.v2");
  if (
    protocol?.abi !== "fleet.plugin.peer.v1" ||
    protocol?.transport !== "direct_ordered" ||
    protocol?.approval !== "both_once" ||
    protocol?.roles?.source !== "prepare_source" ||
    protocol?.roles?.target !== "prepare_target"
  ) {
    fail("generated catalog does not contain the final fleet.transfer.v2 peer declaration");
  }
  const artifact = plugin.artifacts?.find((row) => row.os === "linux" && row.arch === "arm64");
  if (!artifact || !/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? ""))) {
    fail("generated catalog has no hash-pinned linux/arm64 transfer artifact");
  }
  const sourceManifest = await jsonFile(path.join(TRANSFER_ROOT, "fleet-plugin.json"));
  for (const key of ["id", "version", "runtime"]) {
    if (sourceManifest[key] !== plugin[key])
      fail(`source fleet-plugin.json ${key} differs from generated catalog`);
  }
  for (const key of ["actions", "approval_actions", "action_specs", "peer_protocols"]) {
    if (JSON.stringify(sourceManifest[key]) !== JSON.stringify(plugin[key])) {
      fail(`source fleet-plugin.json ${key} differs from generated catalog`);
    }
  }
  return { plugin, artifact };
}

function installedMetadata(plugin, artifact) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    publisher: plugin.publisher,
    license: plugin.license,
    repository: plugin.repository,
    artifact_url: artifact.url,
    sha256: artifact.sha256,
    entrypoint: artifact.entrypoint,
    actions: plugin.actions,
    approval_actions: plugin.approval_actions,
    runtime: plugin.runtime,
    action_specs: plugin.action_specs,
    peer_protocols: plugin.peer_protocols,
    installed_at: Date.now(),
  };
}

async function installAgentPlugin(home, binary, plugin, artifact) {
  const directory = path.join(home, "plugins", plugin.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(binary, path.join(directory, artifact.entrypoint));
  await chmod(path.join(directory, artifact.entrypoint), 0o700);
  await writeJSON(path.join(directory, "metadata.json"), installedMetadata(plugin, artifact));
}

async function installToolPlugin(directory, binary, plugin, artifact) {
  const target = path.join(directory, plugin.id, plugin.version, artifact.entrypoint);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(binary, target);
  await chmod(target, 0o700);
}

async function checkArtifacts() {
  const root = runRoot();
  const { plugin, artifact } = await loadTransferDeclaration();
  const dist = path.join(TRANSFER_ROOT, "dist", "fleet-transfer-plugin-linux-arm64");
  const rebuilt = path.join(root, "artifacts", "fleet-transfer-plugin-linux-arm64");
  const [distHash, rebuiltHash] = await Promise.all([sha256File(dist), sha256File(rebuilt)]);
  if (distHash !== artifact.sha256) {
    fail(`final transfer dist hash ${distHash} differs from generated catalog ${artifact.sha256}`);
  }
  if (rebuiltHash !== artifact.sha256) {
    fail(
      `fresh linux/arm64 transfer build hash ${rebuiltHash} differs from generated catalog ${artifact.sha256}`,
    );
  }
  return { plugin, artifact, dist };
}

async function check() {
  const { plugin, artifact } = await checkArtifacts();
  process.stdout.write(
    `${JSON.stringify({ ok: true, version: plugin.version, sha256: artifact.sha256 })}\n`,
  );
}

async function prepare() {
  const root = runRoot();
  const token = requiredEnv("FLEET_TOKEN");
  const { plugin, artifact, dist } = await checkArtifacts();

  const agentAHome = path.join(root, "agent-a", "home");
  const agentBHome = path.join(root, "agent-b", "home");
  const agentAData = path.join(root, "agent-a", "data");
  const agentBData = path.join(root, "agent-b", "data");
  const toolData = path.join(root, "tool", "data");
  for (const directory of [agentAHome, agentBHome, agentAData, agentBData, toolData]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const config = (deviceId) => ({
    enabled: true,
    permit: "allow",
    hubInput: HUB_IN_CONTAINER,
    hubToken: token,
    deviceId,
    autoUpdate: false,
  });
  await writeJSON(path.join(agentAHome, "config.json"), config(DEVICE_A));
  await writeJSON(path.join(agentBHome, "config.json"), config(DEVICE_B));
  await Promise.all([
    installAgentPlugin(agentAHome, dist, plugin, artifact),
    installAgentPlugin(agentBHome, dist, plugin, artifact),
    installToolPlugin(path.join(root, "tool", "plugins"), dist, plugin, artifact),
  ]);

  await Promise.all([
    writePatternFile(path.join(toolData, "source", "tool-empty.bin"), 0, 1),
    writePatternFile(path.join(agentAData, "source", "client-to-tool.bin"), (2 << 20) + 19, 2),
    writePatternFile(
      path.join(agentAData, "source", "client-to-client.bin"),
      (32 << 20) + 12345,
      3,
    ),
    writePatternFile(path.join(agentAData, "source", "resume-37.bin"), (128 << 20) + 54321, 4),
    writePatternFile(path.join(agentAData, "source", "no-clobber.bin"), (1 << 20) + 7, 5),
    writePatternFile(path.join(agentAData, "source", "cancel.bin"), (64 << 20) + 31, 6),
  ]);
  await mkdir(path.join(agentBData, "no-clobber"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(agentBData, "no-clobber", "no-clobber.bin"), "do-not-replace\n", {
    mode: 0o600,
    flag: "wx",
  });

  await writeJSON(path.join(root, "meta.json"), {
    hub: HUB_IN_CONTAINER,
    plugin: { id: plugin.id, version: plugin.version, sha256: artifact.sha256 },
    devices: { a: DEVICE_A, b: DEVICE_B },
    fixtures: {
      tool_to_client: "tool-empty.bin",
      client_to_tool: "client-to-tool.bin",
      client_to_client: "client-to-client.bin",
      resume: "resume-37.bin",
    },
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, version: plugin.version, sha256: artifact.sha256 })}\n`,
  );
}

async function seed() {
  const origin = requiredEnv("VM_WORKER_ORIGIN");
  const key = requiredEnv("VM_SEED_KEY");
  const response = await fetch(`${origin}/__fleet_vm__/seed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-vm-key": key },
    body: "{}",
  });
  const body = await response.text();
  if (!response.ok) fail(`seed failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  if (!parsed.token || !parsed.user_id || !parsed.kid) fail("seed response is incomplete");
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}

async function seedField(file, field) {
  const value = (await jsonFile(file))[field];
  if (typeof value !== "string" || !value) fail(`seed field ${field} is missing`);
  process.stdout.write(value);
}

async function online(file) {
  const body = await jsonFile(file);
  const rows = Array.isArray(body?.computers) ? body.computers : [];
  for (const id of [DEVICE_A, DEVICE_B]) {
    const row = rows.find((value) => value?.id === id);
    if (!row?.online) fail(`${id} is not online`);
    if (!Array.isArray(row.caps) || !row.caps.includes("plugin_peer_session_v1")) {
      fail(`${id} does not advertise plugin_peer_session_v1`);
    }
  }
}

async function pending(file) {
  const state = await jsonFile(file);
  const command = String(state?.pending?.command ?? "");
  if (command && !command.startsWith("allow plugin fleet.transfer 0.2.1 action ")) {
    fail(`unexpected Agent approval prompt: ${command}`);
  }
  process.exitCode = command ? 0 : 1;
}

async function allowWithoutPending(file) {
  const state = await jsonFile(file);
  if (state?.permit !== "allow") {
    fail(`Agent permit changed from allow: ${String(state?.permit ?? "missing")}`);
  }
  if (state?.pending) {
    fail(`permit=allow unexpectedly requested approval: ${String(state.pending.command ?? "unknown")}`);
  }
}

async function terminal(file, wanted) {
  const value = await jsonFile(file);
  // Tool success output is the session itself. The VM status route wraps the
  // same canonical value in {session}; normalize once instead of teaching
  // every negative-path assertion about transport-specific response shapes.
  const session = value?.session && typeof value.session === "object" ? value.session : value;
  const localPhase = String(session?.local?.phase ?? "");
  const remotePhase = String(session?.phase ?? "");
  if (wanted === "completed") {
    if (remotePhase !== "completed" || (localPhase && localPhase !== "completed")) {
      fail(`expected completed session, got remote=${remotePhase} local=${localPhase || "none"}`);
    }
    return;
  }
  if (wanted === "failed") {
    if (remotePhase !== "failed" && localPhase !== "failed") {
      fail(`expected failed session, got remote=${remotePhase} local=${localPhase || "none"}`);
    }
    return;
  }
  if (wanted === "cancelled") {
    if (remotePhase !== "cancelled" && localPhase !== "cancelled") {
      fail(`expected cancelled session, got remote=${remotePhase} local=${localPhase || "none"}`);
    }
    return;
  }
  fail(`unknown terminal phase ${wanted}`);
}

async function sessionFromLog(file) {
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      const id = String(value?.transfer_id ?? value?.session_id ?? "");
      if (/^[0-9a-f-]{36}$/i.test(id)) {
        process.stdout.write(id);
        return;
      }
    } catch {
      // Progress output is NDJSON; non-JSON diagnostic lines are ignored.
    }
  }
  process.exitCode = 1;
}

async function readResumeCheckpoint(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const partials = entries.filter(
    (entry) => entry.isFile() && /^\.fleet-transfer-[0-9a-f]{16}\.part$/.test(entry.name),
  );
  const sidecars = entries.filter(
    (entry) => entry.isFile() && /^\.fleet-transfer-[0-9a-f]{16}\.json$/.test(entry.name),
  );
  if (partials.length > 1) fail(`multiple partial files in ${directory}`);
  if (sidecars.length > 1) fail(`multiple resume sidecars in ${directory}`);
  if (!partials.length || !sidecars.length) {
    return null;
  }
  if (partials[0].name.replace(/\.part$/, "") !== sidecars[0].name.replace(/\.json$/, "")) {
    fail(`partial and resume sidecar do not belong to the same destination in ${directory}`);
  }
  const state = await jsonFile(path.join(directory, sidecars[0].name));
  if (state?.v !== RESUME_STATE_VERSION || state?.phase !== "receiving") {
    fail(`resume checkpoint in ${directory} is not v${RESUME_STATE_VERSION} receiving state`);
  }
  const offset = Number(state?.verified_offset);
  const size = (await stat(path.join(directory, partials[0].name))).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    fail(`invalid verified_offset ${state?.verified_offset} for ${size}-byte partial`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(state?.prefix_sha256 ?? ""))) {
    fail(`resume checkpoint has an invalid prefix_sha256 in ${directory}`);
  }
  return { state, partialSize: size };
}

async function verifiedOffset(directory) {
  const checkpoint = await readResumeCheckpoint(directory);
  process.stdout.write(String(checkpoint?.state?.verified_offset ?? 0));
}

async function checkpoint(directory) {
  const value = await readResumeCheckpoint(directory);
  if (!value) fail(`no resume checkpoint in ${directory}`);
  const state = value.state;
  process.stdout.write(
    `${JSON.stringify({
      v: state.v,
      phase: state.phase,
      size: state.size,
      transfer_id: state.transfer_id,
      source_sha256: state.source_sha256,
      verified_offset: state.verified_offset,
      prefix_sha256: state.prefix_sha256,
      partial_size: value.partialSize,
    })}\n`,
  );
}

async function publishedReceipt(sourceFile, targetFile, runtimeDestination, sessionFile) {
  const raw = await jsonFile(sessionFile);
  const session = raw?.session && typeof raw.session === "object" ? raw.session : raw;
  if (session?.phase !== "completed") fail(`${sessionFile} is not a completed session`);
  const sessionId = String(session?.session_id ?? "");
  const source = session?.endpoints?.source;
  const expected = await expectedTransfer(sourceFile, runtimeDestination, sessionId, source);
  const [targetInfo, targetHash] = await Promise.all([
    regularFile(targetFile, "published destination"),
    sha256File(targetFile),
  ]);
  if (path.posix.basename(runtimeDestination) !== path.basename(targetFile)) {
    fail(`runtime destination ${runtimeDestination} does not name ${targetFile}`);
  }
  if (targetInfo.size !== expected.size || targetHash !== expected.sha256) {
    fail(
      `published destination ${targetInfo.size}/${targetHash} differs from source ${expected.size}/${expected.sha256}`,
    );
  }

  const stem = transferStem(runtimeDestination);
  const directory = path.dirname(targetFile);
  await exactTransferArtifacts(directory, [`${stem}.json`]);
  const state = await readResumeState(path.join(directory, `${stem}.json`));
  validateStateBinding(state, expected, "published");
  if (state.verified_offset !== expected.size || state.prefix_sha256 !== expected.sha256) {
    fail("published receipt does not describe the complete verified destination");
  }
  return {
    receipt: `${stem}.json`,
    transfer_id: sessionId,
    source_sha256: state.source_sha256,
    destination: runtimeDestination,
    bytes: expected.size,
    sha256: expected.sha256,
  };
}

async function receivingCheckpoint(
  directory,
  sourceFile,
  runtimeDestination,
  sessionId,
  sourceKind,
  sourceId,
  allowStateTemps,
) {
  const expected = await expectedTransfer(sourceFile, runtimeDestination, sessionId, {
    kind: sourceKind,
    id: sourceId,
  });
  const stem = transferStem(runtimeDestination);
  await exactTransferArtifacts(directory, [`${stem}.json`, `${stem}.part`], { allowStateTemps });
  const partialFile = path.join(directory, `${stem}.part`);
  const [partialInfo, state] = await Promise.all([
    regularFile(partialFile, "receiving partial"),
    readResumeState(path.join(directory, `${stem}.json`)),
  ]);
  validateStateBinding(state, expected, "receiving");
  const offset = state.verified_offset;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > expected.size ||
    (offset !== expected.size && offset % TRANSFER_CHUNK !== 0) ||
    partialInfo.size < offset ||
    partialInfo.size > expected.size
  ) {
    fail(
      `receiving checkpoint has invalid verified_offset ${offset} for ${partialInfo.size}/${expected.size}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(String(state.prefix_sha256 ?? ""))) {
    fail("receiving checkpoint has an invalid prefix_sha256");
  }
  const prefix = await sha256Prefix(partialFile, offset);
  if (prefix !== state.prefix_sha256)
    fail(`receiving checkpoint prefix ${prefix} differs from ${state.prefix_sha256}`);
  return {
    phase: state.phase,
    transfer_id: sessionId,
    source_sha256: state.source_sha256,
    destination: runtimeDestination,
    size: expected.size,
    sha256: expected.sha256,
    verified_offset: offset,
    prefix_sha256: prefix,
    partial_size: partialInfo.size,
  };
}

async function artifactsClean(directory) {
  const artifacts = await transferArtifacts(directory);
  if (artifacts.length) {
    fail(
      `transfer artifacts remain in ${directory}: ${artifacts.map((entry) => entry.name).join(", ")}`,
    );
  }
}

async function verifyFiles(source, target) {
  const [sourceStat, targetStat, sourceHash, targetHash] = await Promise.all([
    stat(source),
    stat(target),
    sha256File(source),
    sha256File(target),
  ]);
  if (!sourceStat.isFile() || !targetStat.isFile()) fail("SHA check requires regular files");
  if (sourceStat.size !== targetStat.size || sourceHash !== targetHash) {
    fail(`file mismatch: ${sourceStat.size}/${sourceHash} != ${targetStat.size}/${targetHash}`);
  }
  process.stdout.write(`${JSON.stringify({ bytes: sourceStat.size, sha256: sourceHash })}\n`);
}

async function assertText(file, expected) {
  const actual = await readFile(file, "utf8");
  if (actual !== expected) fail(`${file} was modified`);
}

async function vmPeerResponse(pathname, extra = {}) {
  const origin = requiredEnv("VM_WORKER_ORIGIN");
  const key = requiredEnv("VM_SEED_KEY");
  const sessionId = requiredEnv("VM_SESSION_ID");
  const userId = requiredEnv("VM_USER_ID");
  const kid = requiredEnv("VM_KID");
  const callerId = requiredEnv("VM_CALLER_ID");
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-vm-key": key },
    body: JSON.stringify({
      session_id: sessionId,
      user_id: userId,
      kid,
      caller_kind: "device",
      caller_id: callerId,
      ...extra,
    }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { response, body, text };
}

async function vmPeerRequest(pathname, extra = {}) {
  const value = await vmPeerResponse(pathname, extra);
  if (!value.response.ok) {
    fail(`${pathname} failed with HTTP ${value.response.status}: ${value.text.slice(0, 300)}`);
  }
  return value.body;
}

async function roundId(file) {
  const body = await jsonFile(file);
  const value = String(body?.session?.round?.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(value)) fail(`${file} has no valid peer round id`);
  process.stdout.write(value);
}

async function waitInterrupt(priorRoundId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(priorRoundId ?? "")))
    fail("wait-interrupt requires the prior round id");
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await vmPeerResponse("/__fleet_vm__/interrupt", { round_id: priorRoundId });
    if (value.response.ok) {
      if (value.body?.session?.round?.no < 2 || value.body?.session?.round?.id === priorRoundId) {
        fail("interrupt route returned without a fresh protocol round");
      }
      process.stdout.write(`${JSON.stringify(value.body)}\n`);
      return;
    }
    if (value.response.status !== 409) {
      fail(
        `/__fleet_vm__/interrupt failed with HTTP ${value.response.status}: ${value.text.slice(0, 300)}`,
      );
    }
    if (Date.now() >= deadline)
      fail("real endpoint interrupt did not advance the Hub within 120 seconds");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function sessionStatus() {
  process.stdout.write(`${JSON.stringify(await vmPeerRequest("/__fleet_vm__/session"))}\n`);
}

async function expectRejected(label, operation) {
  try {
    await operation();
  } catch {
    return;
  }
  fail(`self-test expected rejection: ${label}`);
}

function fixtureState(expected, phase, verifiedOffset, prefixSHA256) {
  return {
    v: RESUME_STATE_VERSION,
    phase,
    destination: expected.destination,
    size: expected.size,
    sha256: expected.sha256,
    chunk_size: TRANSFER_CHUNK,
    transfer_id: expected.sessionId,
    source_sha256: sourceBinding(expected.sessionId, expected.source),
    verified_offset: verifiedOffset,
    prefix_sha256: prefixSHA256,
  };
}

async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), "fleet-plugin-peer-vm-helper-"));
  try {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourceEndpoint = { kind: "device", id: DEVICE_A };
    const sourceFile = path.join(root, "source.bin");
    const data = Buffer.alloc(TRANSFER_CHUNK + 17);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 37 + 11) & 0xff;
    await writeFile(sourceFile, data, { mode: 0o600 });

    const publishedDirectory = path.join(root, "published");
    const publishedTarget = path.join(publishedDirectory, "target.bin");
    const publishedRuntime = "/data/published/target.bin";
    await mkdir(publishedDirectory, { mode: 0o700 });
    await writeFile(publishedTarget, data, { mode: 0o600 });
    const publishedExpected = await expectedTransfer(
      sourceFile,
      publishedRuntime,
      sessionId,
      sourceEndpoint,
    );
    const publishedSidecar = path.join(
      publishedDirectory,
      `${transferStem(publishedRuntime)}.json`,
    );
    const publishedState = fixtureState(
      publishedExpected,
      "published",
      publishedExpected.size,
      publishedExpected.sha256,
    );
    await writeJSON(publishedSidecar, publishedState);
    const sessionFile = path.join(root, "session.json");
    await writeJSON(sessionFile, {
      session_id: sessionId,
      phase: "completed",
      endpoints: { source: sourceEndpoint },
    });
    await publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile);

    await writeJSON(publishedSidecar, { ...publishedState, phase: "receiving" });
    await expectRejected("non-published receipt", () =>
      publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile),
    );
    await writeJSON(publishedSidecar, { ...publishedState, phase: "publishing" });
    await expectRejected("publishing receipt", () =>
      publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile),
    );
    await writeJSON(publishedSidecar, publishedState);
    await writeJSON(publishedSidecar, { ...publishedState, source_sha256: "0".repeat(64) });
    await expectRejected("receipt source binding mismatch", () =>
      publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile),
    );
    await writeJSON(publishedSidecar, publishedState);
    await writeFile(publishedTarget, Buffer.concat([data, Buffer.from("tampered")]), {
      mode: 0o600,
    });
    await expectRejected("receipt final file mismatch", () =>
      publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile),
    );
    await writeFile(publishedTarget, data, { mode: 0o600 });
    const strayPart = path.join(publishedDirectory, ".fleet-transfer-0000000000000000.part");
    await writeFile(strayPart, "stray", { mode: 0o600 });
    await expectRejected("published receipt with stray partial", () =>
      publishedReceipt(sourceFile, publishedTarget, publishedRuntime, sessionFile),
    );
    await rm(strayPart);

    const receivingDirectory = path.join(root, "receiving");
    const receivingRuntime = "/data/receiving/target.bin";
    const receivingStem = transferStem(receivingRuntime);
    await mkdir(receivingDirectory, { mode: 0o700 });
    const partial = path.join(receivingDirectory, `${receivingStem}.part`);
    await writeFile(partial, data.subarray(0, TRANSFER_CHUNK), { mode: 0o600 });
    const receivingExpected = await expectedTransfer(
      sourceFile,
      receivingRuntime,
      sessionId,
      sourceEndpoint,
    );
    const prefixSHA256 = await sha256Prefix(partial, TRANSFER_CHUNK);
    const receivingSidecar = path.join(receivingDirectory, `${receivingStem}.json`);
    const receivingState = fixtureState(
      receivingExpected,
      "receiving",
      TRANSFER_CHUNK,
      prefixSHA256,
    );
    await writeJSON(receivingSidecar, receivingState);
    await receivingCheckpoint(
      receivingDirectory,
      sourceFile,
      receivingRuntime,
      sessionId,
      sourceEndpoint.kind,
      sourceEndpoint.id,
      false,
    );

    await writeJSON(receivingSidecar, { ...receivingState, prefix_sha256: "0".repeat(64) });
    await expectRejected("tampered receiving prefix", () =>
      receivingCheckpoint(
        receivingDirectory,
        sourceFile,
        receivingRuntime,
        sessionId,
        sourceEndpoint.kind,
        sourceEndpoint.id,
        false,
      ),
    );
    await writeJSON(receivingSidecar, receivingState);
    const stateTemp = path.join(receivingDirectory, ".fleet-transfer-state-in-progress");
    await writeFile(stateTemp, "temporary", { mode: 0o600 });
    await receivingCheckpoint(
      receivingDirectory,
      sourceFile,
      receivingRuntime,
      sessionId,
      sourceEndpoint.kind,
      sourceEndpoint.id,
      true,
    );
    await expectRejected("stable checkpoint with state temp", () =>
      receivingCheckpoint(
        receivingDirectory,
        sourceFile,
        receivingRuntime,
        sessionId,
        sourceEndpoint.kind,
        sourceEndpoint.id,
        false,
      ),
    );

    const cleanDirectory = path.join(root, "clean");
    await mkdir(cleanDirectory, { mode: 0o700 });
    await artifactsClean(cleanDirectory);
    await mkdir(path.join(cleanDirectory, ".fleet-transfer-cancel-leftover"), { mode: 0o700 });
    await expectRejected("quarantine residue", () => artifactsClean(cleanDirectory));
    process.stdout.write(
      `${JSON.stringify({ ok: true, receipt: "strict", checkpoint: "strict", cleanup: "strict" })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "random") return process.stdout.write(randomBytes(32).toString("hex"));
  if (command === "check") return check();
  if (command === "prepare") return prepare();
  if (command === "seed") return seed();
  if (command === "seed-field") return seedField(args[0], args[1]);
  if (command === "online") return online(args[0]);
  if (command === "pending") return pending(args[0]);
  if (command === "allow-without-pending") return allowWithoutPending(args[0]);
  if (command === "terminal") return terminal(args[0], args[1]);
  if (command === "session") return sessionFromLog(args[0]);
  if (command === "verified-offset") return verifiedOffset(args[0]);
  if (command === "checkpoint") return checkpoint(args[0]);
  if (command === "published-receipt") {
    const value = await publishedReceipt(args[0], args[1], args[2], args[3]);
    return process.stdout.write(`${JSON.stringify(value)}\n`);
  }
  if (command === "receiving-checkpoint") {
    const value = await receivingCheckpoint(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
      args[5],
      args[6] === "--active",
    );
    return process.stdout.write(`${JSON.stringify(value)}\n`);
  }
  if (command === "artifacts-clean") return artifactsClean(args[0]);
  if (command === "self-test") return selfTest();
  if (command === "verify") return verifyFiles(args[0], args[1]);
  if (command === "assert-text") return assertText(args[0], args[1]);
  if (command === "round-id") return roundId(args[0]);
  if (command === "wait-interrupt") return waitInterrupt(args[0]);
  if (command === "session-status") return sessionStatus();
  fail(`unknown helper command ${command || "<empty>"}`);
}

await main();
