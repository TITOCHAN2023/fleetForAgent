/**
 * Serve /fleet-tool.tgz from Worker assets.
 * SPA not_found_handling turns a missing file into index.html — refuse that.
 */
export const FLEET_TOOL_TGZ_PATH = "/fleet-tool.tgz";
export const FLEET_TOOL_TGZ_TYPE = "application/octet-stream";

export function isFleetToolTgzPath(path) {
  return path === FLEET_TOOL_TGZ_PATH;
}

export function serveFleetToolTgz(assetRes) {
  const ct = (assetRes.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) {
    return new Response("fleet-tool tarball missing", { status: 404 });
  }

  if (assetRes.status === 304) {
    return new Response(null, {
      status: assetRes.status,
      statusText: assetRes.statusText,
      headers: assetRes.headers,
    });
  }

  if (assetRes.status === 416) {
    return new Response(assetRes.body, {
      status: assetRes.status,
      statusText: assetRes.statusText,
      headers: assetRes.headers,
    });
  }

  if (!assetRes.ok) {
    return new Response("fleet-tool tarball missing", { status: 404 });
  }
  const headers = new Headers(assetRes.headers);
  headers.set("content-type", FLEET_TOOL_TGZ_TYPE);
  return new Response(assetRes.body, {
    status: assetRes.status,
    statusText: assetRes.statusText,
    headers,
  });
}
