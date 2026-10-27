import worker from './worker.js';
import { fixedWindowLimit } from './rate-limit.mjs';
export { FleetDO, DeviceDO, McpDO, PeerSessionDO, RevocationDO, RoomRelayDO } from './worker.js';
// Filled by the release packager, never copied from the host's private settings.
const releaseSource = {};

const oauth = fixedWindowLimit(60);
const challenge = fixedWindowLimit(6000);

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = new URL(env.HUB_ORIGIN);
    url.protocol = origin.protocol;
    url.host = origin.host;
    request = new Request(url, request);
    return worker.fetch(request, {
      ...env, ...releaseSource, OAUTH_RATE_LIMITER: oauth, CHALLENGE_RATE_LIMITER: challenge,
    }, ctx);
  },
};
