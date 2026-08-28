import { officialPlugin } from "../../fleet-tool/operator.mjs";

export const PLUGIN_ARTIFACT_ROUTE = "/v1/plugin-artifact/";
export const PLUGIN_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isPluginArtifactPath(pathname) {
  return String(pathname || "").startsWith(PLUGIN_ARTIFACT_ROUTE);
}

export function parsePluginArtifactPath(pathname) {
  if (!isPluginArtifactPath(pathname)) return null;
  const raw = pathname.slice(PLUGIN_ARTIFACT_ROUTE.length).split("/");
  if (raw.length !== 4 || raw.some((value) => !value)) return null;
  let values;
  try {
    values = raw.map((value) => decodeURIComponent(value));
  } catch {
    return null;
  }
  const [id, version, os, arch] = values;
  if (!PLUGIN_ID.test(id) || !VERSION.test(version) || !PLATFORM.test(os) || !PLATFORM.test(arch)) {
    return null;
  }
  return { id, version, os, arch };
}

/**
 * Resolve only the build-pinned official manifest. The request never carries
 * an upstream URL, repository, hash, or filename.
 */
export function resolveOfficialPluginArtifact(route, lookup = officialPlugin) {
  if (!route) return null;
  const plugin = lookup(route.id);
  if (!plugin || plugin.id !== route.id || plugin.version !== route.version) return null;
  const artifact = plugin.artifacts?.find(
    (candidate) => candidate.os === route.os && candidate.arch === route.arch,
  );
  if (!artifact || !isPinnedReleaseArtifact(plugin, artifact)) return null;
  return { plugin, artifact };
}

export function pluginArtifactMirrorURL(origin, plugin, artifact) {
  const path = [plugin.id, plugin.version, artifact.os, artifact.arch]
    .map((value) => encodeURIComponent(value))
    .join("/");
  return new URL(`${PLUGIN_ARTIFACT_ROUTE}${path}`, origin).toString();
}

/** Clone the private install manifest. Never add mirror_url to the public registry snapshot. */
export function withPluginArtifactMirrors(plugin, origin) {
  return {
    ...plugin,
    artifacts: plugin.artifacts.map((artifact) => ({
      ...artifact,
      mirror_url: pluginArtifactMirrorURL(origin, plugin, artifact),
    })),
  };
}

export async function serveOfficialPluginArtifact(
  request,
  { lookup = officialPlugin, fetcher = fetch } = {},
) {
  const url = new URL(request.url);
  if (!isPluginArtifactPath(url.pathname)) return null;
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { allow: "GET", "content-type": "application/json" },
    });
  }
  if (url.search) return artifactError("artifact not found", 404);
  const resolved = resolveOfficialPluginArtifact(parsePluginArtifactPath(url.pathname), lookup);
  if (!resolved) return artifactError("artifact not found", 404);

  let upstream;
  try {
    upstream = await fetcher(resolved.artifact.url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "application/octet-stream",
        "user-agent": "fleet-official-plugin-mirror/1",
      },
    });
  } catch {
    return artifactError("artifact upstream unavailable", 502);
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return artifactError("artifact upstream unavailable", 502);
  }

  const contentLength = parseContentLength(upstream.headers.get("content-length"));
  if (contentLength === null || contentLength > PLUGIN_ARTIFACT_MAX_BYTES) {
    await upstream.body.cancel().catch(() => {});
    return artifactError("artifact upstream response is invalid", 502);
  }

  const headers = pluginArtifactResponseHeaders(upstream.headers, resolved.artifact, contentLength);
  return new Response(limitArtifactStream(upstream.body, PLUGIN_ARTIFACT_MAX_BYTES), {
    status: 200,
    headers,
  });
}

export function limitArtifactStream(body, maxBytes) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        seen += bytes.byteLength;
        if (seen > maxBytes) throw new Error("plugin artifact exceeds the streaming limit");
        controller.enqueue(bytes);
      },
    }),
  );
}

export function pluginArtifactResponseHeaders(upstream, artifact, contentLength) {
  const filename = safeFilename(new URL(artifact.url).pathname.split("/").pop());
  const headers = new Headers({
    "cache-control": "private, max-age=300, no-transform",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(contentLength),
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
    "x-fleet-artifact-sha256": artifact.sha256,
  });
  copyShortHeader(upstream, headers, "etag", 256);
  const lastModified = upstream.get("last-modified");
  if (lastModified && lastModified.length <= 128 && Number.isFinite(Date.parse(lastModified))) {
    headers.set("last-modified", lastModified);
  }
  return headers;
}

function isPinnedReleaseArtifact(plugin, artifact) {
  try {
    const repository = new URL(plugin.repository);
    const url = new URL(artifact.url);
    const repositoryPath = repository.pathname.replace(/\/$/, "");
    const prefix = `${repositoryPath}/releases/download/v${plugin.version}/`;
    const filename = url.pathname.slice(prefix.length);
    return (
      repository.protocol === "https:" &&
      repository.hostname === "github.com" &&
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(prefix) &&
      filename.length > 0 &&
      !filename.includes("/") &&
      /^[0-9a-f]{64}$/.test(artifact.sha256)
    );
  } catch {
    return false;
  }
}

function parseContentLength(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function safeFilename(value) {
  const filename = String(value || "plugin-artifact");
  return /^[A-Za-z0-9._-]{1,255}$/.test(filename) ? filename : "plugin-artifact";
}

function copyShortHeader(source, target, name, maxLength) {
  const value = source.get(name);
  if (value && value.length <= maxLength) target.set(name, value);
}

function artifactError(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}
