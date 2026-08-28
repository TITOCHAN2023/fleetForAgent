const PLUGIN_ID = "fleet.transfer";
const PROTOCOL_ID = "fleet.transfer.v2";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function transferError(code, message) {
  return Object.assign(new Error(message), { code });
}

function endpoint(raw, role, operatorId, plugin) {
  const kind = raw?.kind === "tool" ? "tool" : raw?.kind === "device" ? "device" : "";
  if (!kind) throw transferError("invalid_endpoint", `${role} kind must be tool or device`);
  const id = kind === "tool" ? operatorId : String(raw?.device_id || raw?.id || "").trim();
  if (!id) throw transferError("invalid_endpoint", `${role} device_id is required`);
  const protocol = plugin.peer_protocols.find((value) => value.id === PROTOCOL_ID);
  return {
    kind,
    id,
    plugin_id: plugin.id,
    plugin_version: plugin.version,
    action: protocol.roles[role],
    role,
  };
}

async function sourceBinding(sessionId, source, subtle) {
  const canonical = `fleet.transfer.source.v1\0${sessionId}\0${JSON.stringify({ kind: source.kind, id: source.id })}`;
  const digest = new Uint8Array(await subtle.digest("SHA-256", encoder.encode(canonical)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createFileTransferPeerConfig(
  input,
  {
    operatorId = "",
    plugin,
    sessionId = globalThis.crypto?.randomUUID?.(),
    subtle = globalThis.crypto?.subtle,
    isAbsolutePath,
  } = {},
) {
  sessionId = String(sessionId || "").trim().toLowerCase();
  if (!UUID_V4_RE.test(sessionId)) throw transferError("invalid_session", "session_id must be a UUIDv4");
  if (!subtle?.digest) throw transferError("crypto_unavailable", "Web Crypto SHA-256 is unavailable");
  const protocol = plugin?.peer_protocols?.find((value) => value.id === PROTOCOL_ID);
  if (!plugin || plugin.id !== PLUGIN_ID || !protocol) {
    throw transferError("plugin_unavailable", "fleet.transfer.v2 is not present in the pinned official plugin catalog");
  }
  const source = endpoint(input?.source, "source", operatorId, plugin);
  const target = endpoint(input?.target, "target", operatorId, plugin);
  if (source.kind === target.kind && source.id === target.id) {
    throw transferError("endpoint_collision", "source and target must be different endpoints");
  }

  const sourcePath = String(input?.source?.path || "");
  const targetDirectory = String(input?.target?.directory || "");
  if (!sourcePath || !targetDirectory) {
    throw transferError("invalid_input", "source path and target directory are required");
  }
  if (source.kind === "tool" && (!isAbsolutePath || !isAbsolutePath(sourcePath))) {
    throw transferError("invalid_source", "Tool source path must be absolute");
  }
  if (target.kind === "tool" && (!isAbsolutePath || !isAbsolutePath(targetDirectory))) {
    throw transferError("invalid_target", "Tool target directory must be absolute");
  }
  const name = String(input?.target?.name || "").trim();
  return {
    session_id: sessionId,
    protocol,
    initiator: "source",
    source: { ...source, input: { path: sourcePath, chunk_size: 32 << 10 } },
    target: {
      ...target,
      input: {
        directory: targetDirectory,
        ...(name ? { name } : {}),
        transfer_id: sessionId,
        source: await sourceBinding(sessionId, source, subtle),
      },
    },
  };
}
