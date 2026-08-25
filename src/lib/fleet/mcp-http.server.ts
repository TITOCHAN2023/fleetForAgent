import { randomUUID } from "node:crypto";
import {
  McpRpcSession,
  isInitializeMessage,
  isJsonRpcMessage,
  isMcpActivity,
  negotiateStreamableProtocolVersion,
  type JsonRpcMessage,
} from "../../../packages/fleet-tool/mcp-protocol.mjs";
import { authenticateHubOperator, type Operator } from "./mcp-sse.server";

export type { Operator } from "./mcp-sse.server";

const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type Session = {
  id: string;
  rpc: McpRpcSession;
  openedAt: number;
  lastActivityAt: number;
};

type McpHttpOptions = {
  authenticate?: (request: Request) => Promise<Operator>;
  now?: () => number;
  sessions?: Map<string, Session>;
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function rpcError(id: string | number | null, code: number, message: string, status: number) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function validSessionId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function expired(session: Session, now: number) {
  return now >= session.openedAt + SESSION_MAX_AGE_MS || now - session.lastActivityAt >= SESSION_IDLE_MS;
}

async function body(request: Request): Promise<JsonRpcMessage | null> {
  const value = await request.json().catch(() => null);
  return isJsonRpcMessage(value) ? value : null;
}

export function createMcpHttpHandler(options: McpHttpOptions = {}) {
  const sessions = options.sessions ?? new Map<string, Session>();
  const now = options.now ?? Date.now;
  const authenticate = options.authenticate ?? authenticateHubOperator;

  return async function handleMcpHttp(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json({ error: "origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const sessionId = request.headers.get("mcp-session-id")?.trim() ?? "";
    if (request.method === "DELETE") {
      if (!validSessionId(sessionId) || !sessions.delete(sessionId)) {
        return json({ error: "MCP session not found" }, 404);
      }
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE", ...CORS } });
    }

    const message = await body(request);
    if (!message) return rpcError(null, -32700, "invalid JSON-RPC message", 400);

    if (!sessionId) {
      if (!isInitializeMessage(message) || message.id === undefined) {
        return rpcError(message.id ?? null, -32600, "initialize request required", 400);
      }
      let operator: Operator;
      try {
        operator = await authenticate(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "unauthorized" }, 401);
      }
      const id = randomUUID();
      const stamp = now();
      const rpc = new McpRpcSession({
        operator,
        protocolVersion: negotiateStreamableProtocolVersion(message),
      });
      const response = await rpc.dispatch(message);
      if (!response) return rpcError(null, -32603, "initialize failed", 500);
      sessions.set(id, { id, rpc, openedAt: stamp, lastActivityAt: stamp });
      return json(response, 200, { "Mcp-Session-Id": id });
    }

    const session = validSessionId(sessionId) ? sessions.get(sessionId) : undefined;
    if (!session || expired(session, now())) {
      if (session) sessions.delete(sessionId);
      return json({ error: "MCP session not found" }, 404);
    }
    const response = await session.rpc.dispatch(message);
    if (isMcpActivity(message.method)) session.lastActivityAt = now();
    return response ? json(response) : new Response(null, { status: 202, headers: CORS });
  };
}

type McpGlobal = typeof globalThis & {
  __fleetMcpHttpHandler__?: ReturnType<typeof createMcpHttpHandler>;
};

const mcpGlobal = globalThis as McpGlobal;

export function handleMcpHttp(request: Request) {
  mcpGlobal.__fleetMcpHttpHandler__ ??= createMcpHttpHandler();
  return mcpGlobal.__fleetMcpHttpHandler__(request);
}
