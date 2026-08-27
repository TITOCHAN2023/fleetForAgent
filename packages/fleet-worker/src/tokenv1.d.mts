export const TOKEN_V1_PREFIX: string;
export const CHALLENGE_TTL_MS: number;
export const CHALLENGE_MAX_LIVE: number;
export const RSA_MODULUS: number;
export const PSS_SALT_LEN: number;

export const HIGH_SEC_UPGRADE: string;
export const HIGH_SEC_KEY_MISMATCH: string;
export const HIGH_SEC_HANDSHAKE: string;

export function audMismatch(aud: string, origin: string): string;
export function hubOrigin(raw: unknown): string;
export function isTokenV1(raw: unknown): boolean;
export function inspectTokenV1(raw: unknown): {
  prefix: string;
  aud: string;
  kid: string;
  iat: number;
  sig: string;
  rsa: number;
} | null;
export function isLegacyFlt(raw: unknown): boolean;
export function bearerToken(header: unknown): string;

export type AuthorizationParse =
  | { kind: "none" }
  | { kind: "oaep"; kid: string; wrap: string }
  | { kind: "bearer"; token: string };
export function parseAuthorization(header: unknown): AuthorizationParse;

export function fleetOaepValue(kid: string, wrap: string): string;
export function challengeMessage(aud: string, kid: string, nonce: string): string;
export function nextChallengeList(
  prev: unknown,
  nonce: string,
  max?: number,
): { list: string[]; dropped: string[] };
export function dropChallengeNonce(prev: unknown, nonce: string): string[];

export interface ChallengeBook {
  put(kid: string, nonce: string, extra?: Record<string, unknown>): void;
  take(nonce: string): ({ kid: string } & Record<string, unknown>) | undefined;
  clearKid(kid: string): void;
}
export function createChallengeBook(opts?: { max?: number }): ChallengeBook;

export function b64url(bytes: Uint8Array | ArrayBuffer): string;
export function b64urlDecode(s: string): Uint8Array;
export function randomHex(nBytes: number): string;
export function sha256hex(raw: unknown): Promise<string>;
export function hashHubToken(sec: unknown): Promise<string>;

export function generateUserKeypair(): Promise<{
  kid: string;
  publicSpkiB64: string;
  privatePkcs8B64: string;
}>;

export interface MintedTokenV1 {
  raw: string;
  hash: string;
  prefix: string;
  kid: string;
  pub: string;
  priv: string;
  sec: string;
  aud: string;
  iat: number;
}
export function mintTokenV1(opts?: { aud?: string; now?: () => number }): Promise<MintedTokenV1>;

export interface VerifiedTokenV1 {
  v: 1;
  aud: string;
  kid: string;
  pub: string;
  iat: number;
  sec: string;
}
export function verifyTokenV1(raw: unknown): Promise<VerifiedTokenV1>;

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
export function wrapAuth(opts: {
  publicSpkiB64: string;
  sec: string;
  nonce: string;
}): Promise<string>;
export function unwrapAuth(opts: {
  privatePkcs8B64: string;
  wrapB64: string;
}): Promise<{ sec: string; nonce: string }>;
export function highSecAuthorization(
  token: string,
  originUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string>;
