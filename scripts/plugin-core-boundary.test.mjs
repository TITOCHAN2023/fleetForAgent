import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GENERIC_CORE = [
  "packages/fleet-worker/src/index.ts",
  "packages/fleet-worker/src/peer-session.ts",
  "packages/fleet-agent/plugin_peer.go",
  "packages/fleet-agent/plugin_peer_process.go",
  "packages/fleet-agent/plugin_peer_wire.go",
  "packages/fleet-tool/plugin-peer-api.mjs",
  "packages/fleet-tool/plugin-peer-plugin.mjs",
  "packages/fleet-tool/plugin-peer-runtime.mjs",
];

const PLUGIN_BUSINESS_MARKERS = [
  /fleet\.transfer/i,
  /fleet\.acp/i,
  /\/v1\/transfer(?:\/|\b)/i,
  /\bTransferDO\b/,
  /\btransfer_id\b/i,
  /\bfile[_-]transfer\b/i,
  /\bprepare_source\b/i,
  /\bprepare_target\b/i,
];

test("generic plugin Core contains no official-plugin or file-transfer special case", async () => {
  for (const path of GENERIC_CORE) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const marker of PLUGIN_BUSINESS_MARKERS) {
      assert.doesNotMatch(source, marker, `${path} contains plugin business marker ${marker}`);
    }
  }

  const taskCore = await readFile(
    new URL("../packages/fleet-agent/plugin.go", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    taskCore,
    /fleet\.transfer/i,
    "a new peer plugin must not require a task-runtime compatibility branch",
  );
});

test("Worker exposes only the generic peer control plane", async () => {
  const [worker, peer, wrangler] = await Promise.all([
    readFile(new URL("../packages/fleet-worker/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/fleet-worker/src/peer-session.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/fleet-worker/wrangler.toml", import.meta.url), "utf8"),
  ]);
  const runtimeSource = `${worker}\n${peer}`;

  assert.match(worker, /\/v1\/plugin-peer-session\//);
  assert.match(wrangler, /class_name\s*=\s*"PeerSessionDO"/);
  assert.doesNotMatch(runtimeSource, /\/v1\/transfer(?:\/|\b)/i);
  assert.doesNotMatch(runtimeSource, /\bTransferDO\b/);
  assert.match(wrangler, /tag = "v3"\s+new_sqlite_classes = \["TransferDO"\]/);
  assert.match(
    wrangler,
    /tag = "v4"\s+new_sqlite_classes = \["PeerSessionDO"\]\s+deleted_classes = \["TransferDO"\]/,
  );
  assert.match(wrangler, /name\s*=\s*"REVOCATION"\s+class_name\s*=\s*"RevocationDO"/);
  assert.match(wrangler, /tag = "v5"\s+new_sqlite_classes = \["RevocationDO"\]/);
  assert.doesNotMatch(runtimeSource, /peer_session_data/i, "file/data bytes must never use Hub WSS");
  assert.doesNotMatch(peer, /\bFLPP\b/, "Worker must not parse the local plugin DATA ABI");
});

test("file-transfer product entry is a facade over the generic peer runtime", async () => {
  const facade = await readFile(
    new URL("../packages/fleet-tool/file-transfer-rtc.mjs", import.meta.url),
    "utf8",
  );
  assert.match(facade, /plugin-peer-runtime\.mjs/);
  assert.doesNotMatch(facade, /RTCPeerConnection|createDataChannel|setLocalDescription/);
  assert.doesNotMatch(facade, /\/v1\/transfer(?:\/|\b)/i);
});

test("Worker-shared operator imports only the runtime-neutral transfer contract", async () => {
  const [operator, contract] = await Promise.all([
    readFile(new URL("../packages/fleet-tool/operator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../packages/fleet-tool/file-transfer-contract.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(operator, /file-transfer-contract\.mjs/);
  assert.doesNotMatch(operator, /file-transfer-rtc\.mjs|plugin-peer-runtime\.mjs|plugin-peer-plugin\.mjs/);
  assert.doesNotMatch(contract, /from\s+["']node:|werift|child_process|RTCPeerConnection/);
});
