export const PLUGIN_PEER_API = Object.freeze({
  create: "/v1/plugin-peer-session/create",
  authorize: "/v1/plugin-peer-session/authorize",
  signal: "/v1/plugin-peer-session/signal",
  poll: "/v1/plugin-peer-session/inbox/poll",
  status: "/v1/plugin-peer-session/status",
  event: "/v1/plugin-peer-session/event",
});

export function createPluginPeerAPI(hubPost) {
  if (typeof hubPost !== "function") throw new TypeError("hubPost is required");
  const call = (name, body, options) => {
    const pathname = PLUGIN_PEER_API[name];
    if (!pathname) throw new Error(`unknown plugin peer API operation: ${name}`);
    return hubPost(pathname, body, options);
  };
  return Object.freeze({
    create: (body, options) => call("create", body, options),
    authorize: (body, options) => call("authorize", body, options),
    signal: (body, options) => call("signal", body, options),
    poll: (body, options) => call("poll", body, options),
    status: (body, options) => call("status", body, options),
    event: (body, options) => call("event", body, options),
  });
}
