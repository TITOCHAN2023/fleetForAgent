export {
  CHALLENGE_TTL_MS,
  createChallengeBook,
  HIGH_SEC_HANDSHAKE,
  HIGH_SEC_KEY_MISMATCH,
  HIGH_SEC_UPGRADE,
  audMismatch,
  bearerToken,
  hashHubToken,
  highSecAuthorization,
  hubOrigin,
  isLegacyFlt,
  isTokenV1,
  mintTokenV1,
  parseAuthorization,
  signChallenge,
  unwrapAuth,
  verifyChallenge,
  verifyTokenV1,
  wrapAuth,
} from "../../../packages/fleet-worker/src/tokenv1.mjs";

import { isTokenV1, mintTokenV1 } from "../../../packages/fleet-worker/src/tokenv1.mjs";

export function isHubToken(raw: string): boolean {
  return isTokenV1(raw);
}

export async function mintHubToken(aud?: string) {
  return mintTokenV1({
    aud: aud || process.env.FLEET_HUB_ORIGIN || "https://fleet.ginfo.cc",
  });
}
