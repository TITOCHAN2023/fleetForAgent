function transferId(value) {
  return String(value?.transfer_id || value?.session_id || value?.local?.session_id || "");
}

function transferPhase(value) {
  return String(value?.local?.phase || value?.phase || "");
}

/**
 * A CLI owns the Tool endpoint, plugin process, and PeerConnection. Returning
 * after create would destroy all three, so the default CLI contract is to wait
 * until the peer session is terminal.
 */
export async function startAndWaitFileTransfer(manager, input, { signal, onProgress } = {}) {
  if (!manager?.start || !manager?.wait) throw new TypeError("file transfer manager with start/wait is required");
  const started = await manager.start(input, { signal });
  const id = transferId(started);
  if (!id) throw new Error("Hub did not return a transfer_id");
  onProgress?.(started);
  const result = await manager.wait(id, { signal, onProgress });
  const phase = transferPhase(result);
  if (phase !== "completed") {
    const code = String(result?.local?.failure_code || result?.failure_code || phase || "TRANSFER_FAILED").toUpperCase();
    throw Object.assign(new Error(result?.local?.error || result?.error || `file transfer ended in ${phase || "an unknown state"}`), {
      code,
      result,
    });
  }
  return result;
}
