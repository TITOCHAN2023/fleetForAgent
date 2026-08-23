export const BAN_COPY_ZH: string;
export const BAN_COPY_EN: string;
export const FRESHNESS_NOTE: string;

export type OpsActor = { id?: string; email?: string; super?: boolean } | null | undefined;

export function parseAdminEmails(raw: string | null | undefined): string[];
export function isOpsAdmin(actor: OpsActor, adminEmailsRaw: string | null | undefined): boolean;
export function opsNotFound(kind?: "json" | "html"): Response;
export function classifyOs(os: unknown): "mac" | "windows" | "linux" | "unknown";
export function classifyArch(arch: unknown): "arm64" | "amd64" | "unknown";
export function freshnessBucket(
  lastSeen: unknown,
  now?: number,
): "recent" | "hour" | "day" | "stale" | "unknown";
export function userHasToken(user: unknown): boolean;
export function stripSensitive<T>(value: T): T;
export function deviceOpsPublic(row: unknown): {
  id: string;
  os: string;
  arch: string;
  agentVer: string;
  online: boolean;
  lastSeen: number;
  userId: string;
} | null;
export function buildOverview(
  catalog?: { users?: unknown[]; devices?: unknown[] },
  now?: number,
): {
  users: number;
  tokens: number;
  devices: { total: number; online: number; offline: number };
  os: Record<string, number>;
  arch: Record<string, number>;
  agentVer: Record<string, number>;
  freshness: Record<string, number>;
  freshnessNote: string;
  accounts: unknown[];
  deviceRows: unknown[];
};
export function handleOpsRoute(input: {
  path: string;
  method: string;
  actor?: OpsActor;
  adminEmails?: string | null;
  users?: unknown[];
  devices?: unknown[];
  body?: { id?: string; banned?: boolean } | null;
  setBanned?: (id: string, banned: boolean) => Promise<{ id: string; banned: boolean } | null>;
}): Promise<Response>;
export function opsPageHtml(): string;
