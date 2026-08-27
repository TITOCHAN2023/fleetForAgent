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
