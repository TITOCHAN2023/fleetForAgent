import {
  isJsonRpcMessage,
  MCP_LEGACY_PROTOCOL_VERSION,
  McpRpcSession,
} from "../../fleet-tool/mcp-protocol.mjs";

export { isJsonRpcMessage };
export const MCP_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSION;
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

export function isMcpSessionExpired({ now, expiresAt, lastActivityAt, idleMs }) {
  return now >= expiresAt || now - lastActivityAt >= idleMs;
}

export class McpSseSession {
  constructor({ rpc, now = Date.now, keepaliveMs = MCP_KEEPALIVE_MS, idleMs = MCP_SESSION_IDLE_MS } = {}) {
    if (typeof rpc !== "function") throw new Error("rpc required");
    this.rpcSession = new McpRpcSession({ rpc, env: {}, protocolVersion: MCP_PROTOCOL_VERSION });
    this.now = now;
    this.keepaliveMs = keepaliveMs;
    this.idleMs = idleMs;
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

  async dispatch(message, authorize = async () => {}) {
    if (this.closed) return;
    const method = message.method || "";
    if (method !== "ping" && method !== "notifications/initialized") this.lastActivityAt = this.now();
    const response = await this.rpcSession.dispatch(message, authorize, (notification) => {
      this.write(notification);
    });
    if (response) this.write(response);
  }
}
