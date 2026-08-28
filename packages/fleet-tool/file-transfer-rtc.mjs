import path from "node:path";

import { createFileTransferPeerConfig } from "./file-transfer-contract.mjs";
import { OFFICIAL_PLUGIN_CATALOG } from "./official-plugins.generated.mjs";
import { createPluginPeerLauncher, createPluginPeerResolver } from "./plugin-peer-plugin.mjs";
import { createPluginPeerManager } from "./plugin-peer-runtime.mjs";

const PLUGIN_ID = "fleet.transfer";

function transferShape(value) {
  if (!value || typeof value !== "object") return value;
  const sessionId = value.session_id || value.local?.session_id;
  return {
    ...value,
    ...(sessionId ? { transfer_id: sessionId } : {}),
    ...(value.local ? { local: { ...value.local, transfer_id: sessionId } } : {}),
  };
}

export function createFileTransferManager({
  hubPost,
  token,
  operatorId,
  verifyTokenV1,
  verifyFleetStatement,
  hubOrigin = "",
  authorization = "",
  catalog = OFFICIAL_PLUGIN_CATALOG,
  fetchImpl,
  runtime = {},
}) {
  const plugin = catalog.find((value) => value.id === PLUGIN_ID);
  const resolve = runtime.resolvePlugin || createPluginPeerResolver({
    catalog,
    hubOrigin,
    authorization,
    fetchImpl,
    pluginDir: runtime.pluginDir,
  });
  const launchPlugin = runtime.launchPlugin || createPluginPeerLauncher({ resolve, spawnImpl: runtime.spawn });
  const peer = createPluginPeerManager({
    hubPost,
    token,
    operatorId,
    verifyTokenV1,
    verifyFleetStatement,
    launchPlugin,
    runtime,
  });

  async function start(input, { signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error("file transfer cancelled"), { code: "cancelled" });
    const config = await createFileTransferPeerConfig(input, {
      operatorId,
      plugin,
      isAbsolutePath: path.isAbsolute,
    });
    if (signal?.aborted) throw Object.assign(new Error("file transfer cancelled"), { code: "cancelled" });
    return transferShape(await peer.start(config, { signal }));
  }

  async function status(transferId, { signal } = {}) {
    return transferShape(await peer.status(transferId, { signal }));
  }

  async function cancel(transferId, { signal } = {}) {
    return transferShape(await peer.cancel(transferId, { signal }));
  }

  async function wait(transferId, options) {
    return transferShape(await peer.wait(transferId, options));
  }

  return { start, status, wait, cancel, shutdown: peer.shutdown, _rows: peer._rows };
}

export { createFileTransferPeerConfig } from "./file-transfer-contract.mjs";
