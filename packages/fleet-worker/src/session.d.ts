export const FLEET_OPERATOR_HEADER: "X-Fleet-Operator";
export const ANON_FINGERPRINT: "";
export function normalizeFingerprint(value: unknown): string;
export function fingerprintFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
): string;
export function resolveTicket(input?: {
  fingerprint?: unknown;
  ticket?: unknown;
  owner?: unknown;
  live?: unknown;
}): { drop: boolean; corr: string };
export function createSessionBook(): {
  claim(fp: string, corr: string): void;
  finish(corr: string): void;
  ownerOf(corr: string): string | undefined;
  liveOf(fp: string): string;
  aliveOf(fp: string): string[];
  resolve(fp: string, ticket?: string | null): { drop: boolean; corr: string };
};
