export const TOKEN_V1_PREFIX: "flt_1.";
export const CHALLENGE_TTL_MS: number;
export const CHALLENGE_MAX_LIVE: number;
export const HIGH_SEC_UPGRADE: string;
export const HIGH_SEC_KEY_MISMATCH: string;
export const HIGH_SEC_HANDSHAKE: string;
export function audMismatch(aud: string, origin: string): string;
export function hubOrigin(raw: string | null | undefined): string;
export function isTokenV1(raw: string | null | undefined): boolean;
export function inspectTokenV1(raw: string | null | undefined): {
  prefix: string;
  aud: string;
  kid: string;
  iat: number;
  sig: string;
  rsa: number;
} | null;
export function isLegacyFlt(raw: string | null | undefined): boolean;
export function bearerToken(header: string | null | undefined): string;
export function parseAuthorization(header: string | null | undefined):
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "oaep"; kid: string; wrap: string };
export function fleetOaepValue(kid: string, wrap: string): string;
export function challengeMessage(aud: string, kid: string, nonce: string): string;
export function nextChallengeList(
  prev: string[] | null | undefined,
  nonce: string,
  max?: number,
): { list: string[]; dropped: string[] };
export function dropChallengeNonce(prev: string[] | null | undefined, nonce: string): string[];
export function createChallengeBook(opts?: { max?: number }): {
  put(kid: string, nonce: string, extra?: Record<string, unknown>): void;
  take(nonce: string): ({ kid: string } & Record<string, unknown>) | undefined;
  clearKid(kid: string): void;
};
export function b64url(bytes: BufferSource): string;
export function b64urlDecode(s: string): Uint8Array;
export function randomHex(nBytes: number): string;
export function sha256hex(raw: string): Promise<string>;
export function hashHubToken(sec: string): Promise<string>;
export function generateUserKeypair(): Promise<{
  kid: string;
  publicSpkiB64: string;
  privatePkcs8B64: string;
}>;
export function mintTokenV1(opts?: { aud?: string; now?: () => number }): Promise<{
  raw: string;
  hash: string;
  prefix: string;
  kid: string;
  pub: string;
  priv: string;
  sec: string;
  aud: string;
  iat: number;
}>;
export function verifyTokenV1(raw: string): Promise<{
  v: number;
  aud: string;
  kid: string;
  pub: string;
  iat: number;
  sec: string;
}>;
export function signChallenge(opts: {
  privatePkcs8B64: string;
  aud: string;
  kid: string;
  nonce: string;
}): Promise<string>;
export function verifyChallenge(opts: {
  publicSpkiB64: string;
  aud: string;
  kid: string;
  nonce: string;
  sig: string;
}): Promise<boolean>;
export function signFleetStatement(opts: {
  privatePkcs8B64: string;
  statement: Record<string, unknown>;
}): Promise<{ payload: string; sig: string }>;
export function verifyFleetStatement(opts: {
  publicSpkiB64: string;
  payload: string;
  sig: string;
}): Promise<Record<string, unknown> | null>;
export function wrapAuth(opts: { publicSpkiB64: string; sec: string; nonce: string }): Promise<string>;
export function unwrapAuth(opts: { privatePkcs8B64: string; wrapB64: string }): Promise<{ sec: string; nonce: string }>;
export function highSecAuthorization(
  token: string,
  originUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string>;
