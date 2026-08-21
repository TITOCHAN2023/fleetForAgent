import { createHash, randomBytes } from "node:crypto";

export const HUB_TOKEN_PREFIX = "flt_";

export type MintedHubToken = {
  raw: string;
  hash: string;
  prefix: string;
};

export function hashHubToken(raw: string): string {
  return createHash("sha256").update(raw.trim(), "utf8").digest("hex");
}

export function mintHubToken(): MintedHubToken {
  const raw = HUB_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { raw, hash: hashHubToken(raw), prefix: raw.slice(0, 12) };
}

export function isHubToken(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith(HUB_TOKEN_PREFIX) && t.length === HUB_TOKEN_PREFIX.length + 64;
}

export function bearerToken(header: string | null | undefined): string {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
