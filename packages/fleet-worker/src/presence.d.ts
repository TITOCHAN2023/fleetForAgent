export const HEARTBEAT_WAIT_DEFAULT_MS: 3000;
export const HEARTBEAT_WAIT_MAX_MS: 10000;
export function agentVerFromBody(body: unknown): string | undefined;
export function computerPublic(row: unknown): {
  id: string;
  name: unknown;
  os: unknown;
  online: boolean;
  lastSeen: unknown;
  agentVer: unknown;
} | null;
export function clampHeartbeatWaitMs(value: unknown): number;
