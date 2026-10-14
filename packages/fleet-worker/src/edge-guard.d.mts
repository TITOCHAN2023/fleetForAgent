// Structural subset of the platform RateLimit binding; verified against current
// @cloudflare/workers-types. Optional bindings preserve local test harnesses.
export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
type AdmissionEnv = {
  OAUTH_RATE_LIMITER?: RateLimit;
  CHALLENGE_RATE_LIMITER?: RateLimit;
};
export const CONTROL_BODY_MAX_BYTES: number;
export class BodyLimitError extends Error { status: number }
export function readBoundedBytes(request: Request, maxBytes?: number): Promise<Uint8Array>;
export function readBoundedText(request: Request, maxBytes?: number): Promise<string>;
export function readBoundedJson(request: Request, maxBytes?: number): Promise<unknown>;
export function edgeRequestGuard(request: Request, env: AdmissionEnv): Response | null | Promise<Response | null>;
export const BROWSER_SECURITY_HEADERS: Record<string, string>;
export function withBrowserSecurityHeaders(response: Response): Response;
