import { randomUUID } from "node:crypto";
import {
  createOperator,
  FLEET_VERSION,
  fleetResultMeta,
  formatMcpText,
  isDeviceTransportPath,
  MCP_INSTRUCTIONS,
  wrapTransportRpc,
} from "../../../packages/fleet-tool/operator.mjs";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const KEEPALIVE_MS = 15_000;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

export type Operator = {
  tools: unknown[];
  prompts: unknown[];
  getPrompt: (name: string) => unknown;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    hooks?: {
      isCancelled?: () => boolean;
      onProgress?: (progress: { progress: number; total: number }) => void;
    },
  ) => Promise<unknown>;
  getState?: () => { lastUsed?: string | null; lastCwd?: string | null; envDefault?: string | null };
};

type MakeOperator = (options: {
  rpc: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  env?: Record<string, string>;
}) => Operator;

const makeOperator = createOperator as unknown as MakeOperator;

type Session = {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  operator: Operator;
  cancelled: Map<string, boolean>;
  keepalive: ReturnType<typeof setInterval>;
  expiresAt: number;
  closed: boolean;
  close: () => void;
};

type Authenticate = (request: Request) => Promise<Operator>;

type McpSseOptions = {
  authenticate?: Authenticate;
  now?: () => number;
  sessions?: Map<string, Session>;
};

class HubRpcError extends Error {
  status: number;
  json: Record<string, unknown>;

  constructor(status: number, json: Record<string, unknown>) {
    super(String(json.error || json.code || `hub returned ${status}`));
    this.status = status;
    this.json = json;
  }
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function encoder() {
  return new TextEncoder();
}

function sseEvent(event: string, data: string) {
  return encoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

function sseComment(comment: string) {
  return encoder().encode(`: ${comment}\n\n`);
}

function rpcKey(id: JsonRpcId | undefined) {
  return id == null ? "" : String(id);
}

function writeMessage(session: Session, payload: unknown) {
  if (session.closed) return;
  try {
    session.controller.enqueue(sseEvent("message", JSON.stringify(payload)));
  } catch {
    session.close();
  }
}

function reply(session: Session, id: JsonRpcId | undefined, result: unknown) {
  if (id === undefined) return;
  writeMessage(session, { jsonrpc: "2.0", id, result });
}

function replyError(session: Session, id: JsonRpcId | undefined, code: number, error: unknown) {
  if (id === undefined) return;
  const message = error instanceof Error ? error.message : String(error);
  writeMessage(session, { jsonrpc: "2.0", id, error: { code, message } });
}

function notify(session: Session, method: string, params: Record<string, unknown>) {
  writeMessage(session, { jsonrpc: "2.0", method, params });
}

function toolResult(name: string, out: unknown) {
  const row = out && typeof out === "object" ? (out as Record<string, unknown>) : null;
  const content: Record<string, unknown>[] = [];
  if (row?.ok === true && typeof row.image_b64 === "string" && row.image_b64) {
    content.push({
      type: "image",
      mimeType: typeof row.mime === "string" ? row.mime : "image/jpeg",
      data: row.image_b64,
    });
  }
  content.push({ type: "text", text: formatMcpText(name, out, {}) });
  const payload: Record<string, unknown> = { content };
  if (row && (row.isError === true || row.ok === false)) payload.isError = true;
  const meta = fleetResultMeta(out);
  if (meta) payload._meta = meta;
  return payload;
}

export function createSessionCorrTracker() {
  const corrByDevice = new Map<string, string>();
  return {
    prepare(path: string, body: Record<string, unknown>) {
      const payload = { ...(body || {}) };
      const deviceId = typeof payload.device_id === "string" ? payload.device_id : "";
      if (
        deviceId &&
        payload.corr == null &&
        (path === "/v1/get_result" || path === "/v1/read_screen" || path === "/v1/type")
      ) {
        const corr = corrByDevice.get(deviceId);
        if (corr) payload.corr = corr;
      }
      return payload;
    },
    remember(path: string, body: Record<string, unknown>, value: Record<string, unknown>) {
      const deviceId = typeof body.device_id === "string" ? body.device_id : "";
      if (path === "/v1/run" && deviceId && typeof value.corr === "string" && value.corr) {
        corrByDevice.set(deviceId, value.corr);
      }
    },
  };
}

async function dispatch(session: Session, message: JsonRpcMessage) {
  const id = message.id;
  const method = message.method || "";

  try {
    if (method === "notifications/initialized") return;
    if (method === "notifications/cancelled") {
      const requestId = rpcKey(message.params?.requestId as JsonRpcId | undefined);
      if (requestId && session.cancelled.has(requestId)) session.cancelled.set(requestId, true);
      return;
    }
    if (method === "initialize") {
      reply(session, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "fleet", version: FLEET_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
      return;
    }
    if (method === "ping") {
      reply(session, id, {});
      return;
    }
    if (method === "prompts/list") {
      reply(session, id, { prompts: session.operator.prompts });
      return;
    }
    if (method === "prompts/get") {
      const name = String(message.params?.name || "");
      const prompt = session.operator.getPrompt(name);
      if (!prompt) throw new Error(`unknown prompt ${name}`);
      reply(session, id, prompt);
      return;
    }
    if (method === "tools/list") {
      reply(session, id, { tools: session.operator.tools });
      return;
    }
    if (method === "tools/call") {
      const requestId = rpcKey(id);
      const name = String(message.params?.name || "");
      const args = (message.params?.arguments as Record<string, unknown> | undefined) || {};
      session.cancelled.set(requestId, false);
      const progressToken =
        (message.params?._meta as Record<string, unknown> | undefined)?.progressToken ?? id;
      try {
        const out = await session.operator.callTool(name, args, {
          isCancelled: () => session.cancelled.get(requestId) === true,
          onProgress: ({ progress, total }: { progress: number; total: number }) => {
            notify(session, "notifications/progress", { progressToken, progress, total });
          },
        });
        reply(session, id, toolResult(name, out));
      } finally {
        session.cancelled.delete(requestId);
      }
      return;
    }
    replyError(session, id, -32601, `method not found: ${method}`);
  } catch (error) {
    session.cancelled.delete(rpcKey(id));
    replyError(session, id, -32000, error);
  }
}

function closeSession(sessions: Map<string, Session>, session: Session) {
  if (session.closed) return;
  session.closed = true;
  clearInterval(session.keepalive);
  sessions.delete(session.id);
  try {
    session.controller.close();
  } catch {
    // The client already closed the stream.
  }
}

function cleanupExpired(sessions: Map<string, Session>, now: number) {
  for (const session of sessions.values()) {
    if (session.expiresAt <= now) closeSession(sessions, session);
  }
}

async function jsonBody(request: Request): Promise<JsonRpcMessage | null> {
  try {
    const parsed = (await request.json()) as JsonRpcMessage;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createMcpSseHandler(options: McpSseOptions = {}) {
  const sessions = options.sessions || new Map<string, Session>();
  const now = options.now || Date.now;
  const authenticate = options.authenticate || authenticateHubOperator;

  return async function handleMcpSse(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json({ error: "origin not allowed" }, 403);
    cleanupExpired(sessions, now());

    if (request.method === "GET") {
      let operator: Operator;
      try {
        operator = await authenticate(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "unauthorized" }, 401);
      }

      const id = randomUUID();
      let session: Session | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const keepalive = setInterval(() => {
            if (!session || session.closed) return;
            if (session.expiresAt <= now()) {
              session.close();
              return;
            }
            try {
              controller.enqueue(sseComment("keepalive"));
            } catch {
              session.close();
            }
          }, KEEPALIVE_MS);
          session = {
            id,
            controller,
            operator,
            cancelled: new Map(),
            keepalive,
            expiresAt: now() + SESSION_MAX_AGE_MS,
            closed: false,
            close: () => {},
          };
          session.close = () => closeSession(sessions, session as Session);
          sessions.set(id, session);
          controller.enqueue(sseEvent("endpoint", `/mcp/sse?sessionId=${encodeURIComponent(id)}`));
        },
        cancel() {
          if (session) closeSession(sessions, session);
        },
      });

      request.signal.addEventListener("abort", () => {
        if (session) closeSession(sessions, session);
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    if (request.method === "POST") {
      const sessionId = new URL(request.url).searchParams.get("sessionId") || "";
      const session = sessions.get(sessionId);
      if (!session || session.closed) return json({ error: "MCP session not found" }, 404);
      const message = await jsonBody(request);
      if (!message) return json({ error: "invalid JSON-RPC message" }, 400);
      void dispatch(session, message);
      return new Response(null, { status: 202 });
    }

    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  };
}

export async function authenticateHubOperator(request: Request): Promise<Operator> {
  const token = bearerToken(request);
  if (!token) throw new Error("Authorization: Bearer <Hub token> required");
  const [{ highSecAuthorization }, { handleHubHttp }] = await Promise.all([
    import("./token"),
    import("./v1.server"),
  ]);
  const origin = new URL(request.url).origin;
  const fingerprint = randomUUID();
  const corrTracker = createSessionCorrTracker();

  const internalFetch = (input: string | URL | Request, init?: RequestInit) =>
    handleHubHttp(new Request(input, init));

  const rpc = async (path: string, body: Record<string, unknown>) => {
    const payload = corrTracker.prepare(path, body);
    const authorization = await highSecAuthorization(token, origin, internalFetch);
    const response = await handleHubHttp(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "x-fleet-operator": fingerprint,
        },
        body: JSON.stringify(payload),
      }),
    );
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new HubRpcError(response.status, value);
    corrTracker.remember(path, payload, value);
    return wrapTransportRpc(value, isDeviceTransportPath(path) ? "ws" : null);
  };

  await rpc("/v1/list_computers", {});
  return makeOperator({ rpc, env: {} });
}

type McpGlobal = typeof globalThis & {
  __fleetMcpSseHandler__?: ReturnType<typeof createMcpSseHandler>;
};

const mcpGlobal = globalThis as McpGlobal;

export function handleMcpSse(request: Request) {
  mcpGlobal.__fleetMcpSseHandler__ ??= createMcpSseHandler();
  return mcpGlobal.__fleetMcpSseHandler__(request);
}
