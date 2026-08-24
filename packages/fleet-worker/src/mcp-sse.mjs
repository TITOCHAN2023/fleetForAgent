import {
  createOperator,
  FLEET_VERSION,
  formatMcpText,
  MCP_INSTRUCTIONS,
} from "../../fleet-tool/operator.mjs";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_KEEPALIVE_MS = 15_000;
export const MCP_SESSION_IDLE_MS = 10 * 60 * 1000;
export const MCP_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function sseEvent(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

function sseComment(comment) {
  return encoder.encode(`: ${comment}\n\n`);
}

function rpcKey(id) {
  return id == null ? "" : String(id);
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
  return payload;
}

export function isJsonRpcMessage(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isMcpSessionExpired({ now, expiresAt, lastActivityAt, idleMs }) {
  return now >= expiresAt || now - lastActivityAt >= idleMs;
}

export class McpSseSession {
  constructor({ rpc, now = Date.now, keepaliveMs = MCP_KEEPALIVE_MS, idleMs = MCP_SESSION_IDLE_MS } = {}) {
    if (typeof rpc !== "function") throw new Error("rpc required");
    this.operator = createOperator({ rpc, env: {} });
    this.now = now;
    this.keepaliveMs = keepaliveMs;
    this.idleMs = idleMs;
    this.cancelled = new Map();
    this.controller = null;
    this.timer = null;
    this.expiresAt = 0;
    this.lastActivityAt = 0;
    this.opened = false;
    this.closed = false;
  }

  open(sessionId) {
    if (this.opened) {
      return new Response(JSON.stringify({ error: "MCP session already open" }), {
        status: 409,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    this.opened = true;
    this.lastActivityAt = this.now();
    this.expiresAt = this.lastActivityAt + MCP_SESSION_MAX_AGE_MS;
    const endpoint = `/mcp/sse?sessionId=${encodeURIComponent(sessionId)}`;
    const stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        controller.enqueue(sseEvent("endpoint", endpoint));
        this.timer = setInterval(() => {
          if (this.closed) return;
          if (isMcpSessionExpired({
            now: this.now(),
            expiresAt: this.expiresAt,
            lastActivityAt: this.lastActivityAt,
            idleMs: this.idleMs,
          })) {
            this.close();
            return;
          }
          try {
            controller.enqueue(sseComment("keepalive"));
          } catch {
            this.close();
          }
        }, this.keepaliveMs);
      },
      cancel: () => this.close(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.controller?.close();
    } catch {
      // The client already closed the stream.
    }
    this.controller = null;
  }

  write(payload) {
    if (this.closed || !this.controller) return;
    try {
      this.controller.enqueue(sseEvent("message", JSON.stringify(payload)));
    } catch {
      this.close();
    }
  }

  reply(id, result) {
    if (id === undefined) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  replyError(id, code, error) {
    if (id === undefined) return;
    const message = error instanceof Error ? error.message : String(error);
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async dispatch(message, authorize = async () => {}) {
    if (this.closed) return;
    const id = message.id;
    const method = message.method || "";
    if (method !== "ping" && method !== "notifications/initialized") this.lastActivityAt = this.now();
    try {
      await authorize();
      if (method === "notifications/initialized") return;
      if (method === "notifications/cancelled") {
        const requestId = rpcKey(message.params?.requestId);
        if (requestId && this.cancelled.has(requestId)) this.cancelled.set(requestId, true);
        return;
      }
      if (method === "initialize") {
        this.reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "fleet", version: FLEET_VERSION },
          instructions: MCP_INSTRUCTIONS,
        });
        return;
      }
      if (method === "ping") {
        this.reply(id, {});
        return;
      }
      if (method === "prompts/list") {
        this.reply(id, { prompts: this.operator.prompts });
        return;
      }
      if (method === "prompts/get") {
        const name = String(message.params?.name || "");
        const prompt = this.operator.getPrompt(name);
        if (!prompt) throw new Error(`unknown prompt ${name}`);
        this.reply(id, prompt);
        return;
      }
      if (method === "tools/list") {
        this.reply(id, { tools: this.operator.tools });
        return;
      }
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
              this.notify("notifications/progress", { progressToken, progress, total });
            },
          });
          this.reply(id, toolResult(name, out));
        } finally {
          this.cancelled.delete(requestId);
        }
        return;
      }
      this.replyError(id, -32601, `method not found: ${method}`);
    } catch (error) {
      this.cancelled.delete(rpcKey(id));
      this.replyError(id, -32000, error);
    }
  }
}
