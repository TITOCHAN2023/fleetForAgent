export const HEARTBEAT_WAIT_DEFAULT_MS: 3000;
export const HEARTBEAT_WAIT_MAX_MS: 10000;
export const DESKTOP_WAIT_MS: 8000;
export const COMPUTER_USE_CAP: "computer_use";
export function agentVerFromBody(body: unknown): string | undefined;
export function normalizeCaps(raw: unknown): string[];
export function normalizePermit(raw: unknown): "off" | "ask" | "allow" | null;
export function joinCaps(caps: unknown): string;
export function hasComputerUse(row: unknown): boolean;
export function unsupportedCapBody(row: unknown): {
  error: "unsupported";
  code: "UNSUPPORTED_CAP";
  missing: "computer_use";
  agentVer: string;
  os: string;
};
export function computerPublic(row: unknown): {
  id: string;
  name: unknown;
  os: unknown;
  online: boolean;
  lastSeen: unknown;
  agentVer: unknown;
  caps: string[];
  permit: "off" | "ask" | "allow" | null;
} | null;
export function clampHeartbeatWaitMs(value: unknown): number;
