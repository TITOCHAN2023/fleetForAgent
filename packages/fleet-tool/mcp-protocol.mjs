import {
  createOperator,
  FLEET_VERSION,
  fleetResultMeta,
  formatMcpText,
  MCP_INSTRUCTIONS,
} from "./operator.mjs";

export const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";
export const MCP_STREAMABLE_PROTOCOL_VERSION = "2025-06-18";
export const MCP_STREAMABLE_PROTOCOL_VERSIONS = Object.freeze([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

function rpcKey(id) {
  return id == null ? "" : String(id);
}

function result(id, value) {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, error) {
  if (id === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(name, out) {
  const row = out && typeof out === "object" ? out : null;
  const content = [];
  if (row?.ok === true && typeof row.image_b64 === "string" && row.image_b64) {
    content.push({
      type: "image",
      mimeType: typeof row.mime === "string" ? row.mime : "image/jpeg",
      data: row.image_b64,
    });
  }
  content.push({ type: "text", text: formatMcpText(name, out, {}) });
  const payload = { content };
  if (row && (row.isError === true || row.ok === false)) payload.isError = true;
  const meta = fleetResultMeta(out);
  if (meta) payload._meta = meta;
  return payload;
}

export function isJsonRpcMessage(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isInitializeMessage(message) {
  return isJsonRpcMessage(message) && message.method === "initialize";
}

export function isMcpActivity(method) {
  return method !== "ping" && method !== "notifications/initialized";
}

export function negotiateStreamableProtocolVersion(message) {
  const requested = String(message?.params?.protocolVersion || "");
  return MCP_STREAMABLE_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_STREAMABLE_PROTOCOL_VERSION;
}

function mcpClosingError() {
  return Object.assign(new Error("MCP stdio is closing"), { code: "mcp_closing" });
}

function mcpCancelledError() {
  return Object.assign(new Error("MCP request cancelled"), { code: "mcp_cancelled" });
}

const MCP_STDIO_JOIN_TIMEOUT_MS = 1_000;

function boundedJoin(promises, timeoutMs) {
  const settled = Promise.allSettled(promises);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return settled;
  if (timeoutMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class McpStdioCallManager {
  constructor({
    shutdown = async () => {},
    joinTimeoutMs = MCP_STDIO_JOIN_TIMEOUT_MS,
    shutdownTimeoutMs = MCP_STDIO_JOIN_TIMEOUT_MS,
  } = {}) {
    if (typeof shutdown !== "function") throw new TypeError("shutdown must be a function");
    this.shutdown = shutdown;
    this.joinTimeoutMs = joinTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.controller = new AbortController();
    this.pendingCalls = new Set();
    this.callControllers = new Map();
    this.closing = false;
    this.closePromise = null;
  }

  run(task, { key = "" } = {}) {
    if (this.closing) throw mcpClosingError();
    if (typeof task !== "function") throw new TypeError("task must be a function");
    const callKey = key == null ? "" : String(key);
    if (callKey && this.callControllers.has(callKey)) {
      throw Object.assign(new Error(`MCP request ${callKey} is already running`), { code: "mcp_duplicate_request" });
    }
    const callController = new AbortController();
    const closeCall = () => callController.abort(this.controller.signal.reason || mcpClosingError());
    this.controller.signal.addEventListener("abort", closeCall, { once: true });
    if (callKey) this.callControllers.set(callKey, callController);
    let resolveCall;
    let rejectCall;
    const tracked = new Promise((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    this.pendingCalls.add(tracked);
    const finish = (settle, value) => {
      this.pendingCalls.delete(tracked);
      this.controller.signal.removeEventListener("abort", closeCall);
      if (callKey && this.callControllers.get(callKey) === callController) {
        this.callControllers.delete(callKey);
      }
      settle(value);
    };
    try {
      Promise.resolve(task(callController.signal)).then(
        (value) => finish(resolveCall, value),
        (error) => finish(rejectCall, error),
      );
    } catch (error) {
      finish(rejectCall, error);
    }
    return tracked;
  }

  cancel(key, reason = mcpCancelledError()) {
    const callKey = key == null ? "" : String(key);
    const controller = this.callControllers.get(callKey);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  write(callback) {
    if (this.closing) return false;
    callback();
    return true;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.controller.abort(mcpClosingError());
    const pending = [...this.pendingCalls];
    this.closePromise = (async () => {
      await boundedJoin(pending, this.joinTimeoutMs);
      await boundedJoin([Promise.resolve().then(() => this.shutdown())], this.shutdownTimeoutMs);
    })();
    return this.closePromise;
  }
}

export class McpRpcSession {
  constructor({ rpc, operator, env = {}, state = {}, protocolVersion = MCP_LEGACY_PROTOCOL_VERSION } = {}) {
    if (!operator && typeof rpc !== "function") throw new Error("rpc or operator required");
    this.operator = operator || createOperator({ rpc, env, state });
    this.protocolVersion = protocolVersion;
    this.cancelled = new Map();
  }

  getState() {
    return typeof this.operator.getState === "function"
      ? this.operator.getState()
      : { lastUsed: null, lastCwd: null, envDefault: null };
  }

  async dispatch(message, authorize = async () => {}, notify = () => {}) {
    const id = message.id;
    const method = message.method || "";
    try {
      await authorize();
      if (method === "notifications/initialized") return null;
      if (method === "notifications/cancelled") {
        const requestId = rpcKey(message.params?.requestId);
        if (requestId && this.cancelled.has(requestId)) this.cancelled.set(requestId, true);
        return null;
      }
      if (method === "initialize") {
        return result(id, {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "fleet", version: FLEET_VERSION },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      if (method === "ping") return result(id, {});
      if (method === "prompts/list") return result(id, { prompts: this.operator.prompts });
      if (method === "prompts/get") {
        const name = String(message.params?.name || "");
        const prompt = this.operator.getPrompt(name);
        if (!prompt) throw new Error(`unknown prompt ${name}`);
        return result(id, prompt);
      }
      if (method === "tools/list") return result(id, { tools: this.operator.tools });
      if (method === "tools/call") {
        const requestId = rpcKey(id);
        const name = String(message.params?.name || "");
        const args = message.params?.arguments || {};
        this.cancelled.set(requestId, false);
        const progressToken = message.params?._meta?.progressToken ?? id;
        try {
          const out = await this.operator.callTool(name, args, {
            isCancelled: () => this.cancelled.get(requestId) === true,
            onProgress: ({ progress, total }) => {
              notify({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken, progress, total },
              });
            },
          });
          return result(id, toolResult(name, out));
        } finally {
          this.cancelled.delete(requestId);
        }
      }
      return failure(id, -32601, `method not found: ${method}`);
    } catch (error) {
      this.cancelled.delete(rpcKey(id));
      return failure(id, -32000, error);
    }
  }
}
