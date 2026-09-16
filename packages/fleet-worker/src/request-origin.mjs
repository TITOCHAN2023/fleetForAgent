/** Cookie credentials are ambient: require a same-origin browser write.
 * Native Agent/MCP calls without a session cookie keep their token handshake.
 */
export function cookieMutationAllowed(request, expectedOrigin) {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  )
    return true;
  const cookies = request.headers.get("cookie") || "";
  if (!cookies.split(";").some((part) => part.trim().startsWith("fleet_session="))) return true;

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expectedOrigin;
  // Older clients can omit Origin; Referer still has to identify this origin.
  try {
    return new URL(request.headers.get("referer") || "").origin === expectedOrigin;
  } catch {
    return false;
  }
}
