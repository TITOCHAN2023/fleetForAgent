export const MCP_LEGACY_PROTOCOL_VERSION: string;
export const MCP_STREAMABLE_PROTOCOL_VERSION: string;
export const MCP_STREAMABLE_PROTOCOL_VERSIONS: readonly string[];

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type McpOperatorState = {
  lastUsed?: string | null;
  lastCwd?: string | null;
  envDefault?: string | null;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpOperator = {
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
  getState?: () => McpOperatorState;
};

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage;
export function isInitializeMessage(message: unknown): message is JsonRpcMessage;
export function isMcpActivity(method: string | undefined): boolean;
export function negotiateStreamableProtocolVersion(message: JsonRpcMessage): string;

export class McpRpcSession {
  constructor(options: {
    rpc?: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    operator?: McpOperator;
    env?: Record<string, string>;
    state?: McpOperatorState;
    protocolVersion?: string;
  });
  getState(): McpOperatorState;
  dispatch(
    message: JsonRpcMessage,
    authorize?: () => Promise<void>,
    notify?: (message: Record<string, unknown>) => void,
  ): Promise<JsonRpcResponse | null>;
}
