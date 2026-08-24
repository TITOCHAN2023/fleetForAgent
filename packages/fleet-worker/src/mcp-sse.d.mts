export const MCP_PROTOCOL_VERSION: string;
export const MCP_KEEPALIVE_MS: number;
export const MCP_SESSION_MAX_AGE_MS: number;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage;

export class McpSseSession {
  constructor(options: {
    rpc: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    now?: () => number;
    keepaliveMs?: number;
  });
  readonly opened: boolean;
  readonly closed: boolean;
  open(sessionId: string): Response;
  close(): void;
  dispatch(message: JsonRpcMessage, authorize?: () => Promise<void>): Promise<void>;
}
