import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { officialPlugin } from "../fleet-tool/operator.mjs";
import {
  PLUGIN_ARTIFACT_MAX_BYTES,
  limitArtifactStream,
  parsePluginArtifactPath,
  resolveOfficialPluginArtifact,
  serveOfficialPluginArtifact,
  withPluginArtifactMirrors,
} from "./src/plugin-artifact.mjs";

const ID = "fleet.acp";
const ACP = officialPlugin(ID);
assert.ok(ACP, "fleet.acp must exist in the pinned catalog");
const VERSION = ACP.version;
const PATH = `/v1/plugin-artifact/${ID}/${VERSION}/linux/arm64`;

test("artifact route resolves one exact installable version and platform", () => {
  const route = parsePluginArtifactPath(PATH);
  const resolved = resolveOfficialPluginArtifact(route);
  assert.equal(resolved?.plugin.id, ID);
  assert.equal(resolved?.plugin.version, VERSION);
  assert.equal(resolved?.artifact.os, "linux");
  assert.equal(resolved?.artifact.arch, "arm64");
  assert.equal(
    resolved?.artifact.url,
    ACP.artifacts.find((artifact) => artifact.os === "linux" && artifact.arch === "arm64")?.url,
  );
  assert.equal(parsePluginArtifactPath(`${PATH}/extra`), null);
  assert.equal(
    resolveOfficialPluginArtifact(parsePluginArtifactPath(PATH.replace(VERSION, "9.9.9"))),
    null,
  );
  assert.equal(
    resolveOfficialPluginArtifact(parsePluginArtifactPath(PATH.replace("linux", "freebsd"))),
    null,
  );
  assert.equal(
    resolveOfficialPluginArtifact(route, () => null),
    null,
  );
});

test("temporary install manifest adds same-origin mirrors without mutating registry data", () => {
  const manifest = withPluginArtifactMirrors(ACP, "https://fleet.ginfo.cc");
  assert.equal(
    manifest.artifacts[0].mirror_url,
    `https://fleet.ginfo.cc/v1/plugin-artifact/${ID}/${VERSION}/darwin/amd64`,
  );
  assert.equal(ACP.artifacts[0].mirror_url, undefined);
});

test("artifact proxy fetches only the pinned URL, streams, and allowlists response headers", async () => {
  let fetched = "";
  const payload = new TextEncoder().encode("official artifact");
  const response = await serveOfficialPluginArtifact(new Request(`https://fleet.ginfo.cc${PATH}`), {
    fetcher: async (url) => {
      fetched = String(url);
      return new Response(payload, {
        headers: {
          "content-length": String(payload.byteLength),
          etag: '"pinned"',
          "last-modified": "Fri, 28 Aug 2026 00:00:00 GMT",
          location: "https://evil.example/",
          "set-cookie": "secret=bad",
          "x-upstream-secret": "bad",
        },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(fetched, resolveOfficialPluginArtifact(parsePluginArtifactPath(PATH)).artifact.url);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("etag"), '"pinned"');
  assert.equal(response.headers.get("last-modified"), "Fri, 28 Aug 2026 00:00:00 GMT");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-upstream-secret"), null);
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "official artifact");
});

test("artifact proxy rejects query URL injection and oversized upstreams", async () => {
  let calls = 0;
  const injected = await serveOfficialPluginArtifact(
    new Request(`https://fleet.ginfo.cc${PATH}?url=https://evil.example/payload`),
    { fetcher: async () => (calls += 1) },
  );
  assert.equal(injected.status, 404);
  assert.equal(calls, 0);

  const oversized = await serveOfficialPluginArtifact(
    new Request(`https://fleet.ginfo.cc${PATH}`),
    {
      fetcher: async () =>
        new Response("x", { headers: { "content-length": String(PLUGIN_ARTIFACT_MAX_BYTES + 1) } }),
    },
  );
  assert.equal(oversized.status, 502);

  const bounded = limitArtifactStream(new Response(new Uint8Array([1, 2, 3, 4, 5])).body, 4);
  await assert.rejects(new Response(bounded).arrayBuffer(), /streaming limit/);
});

test("Worker exposes the mirror only behind resolved account auth and injects it only on install", async () => {
  const worker = await readFile(new URL("./src/index.ts", import.meta.url), "utf8");
  const authorized = worker.slice(
    worker.indexOf("async function handleAuthorizedOperatorRequest"),
    worker.indexOf('if (url.pathname === "/v1/rtc/config"'),
  );
  assert.match(authorized, /isPluginArtifactPath\(url\.pathname\)/);
  assert.match(authorized, /actor\.super/);
  assert.match(authorized, /serveOfficialPluginArtifact\(request\)/);
  assert.match(worker, /operation === "install"[\s\S]*withPluginArtifactMirrors/);
  assert.doesNotMatch(
    await readFile(new URL("./public/plugin-registry.json", import.meta.url), "utf8"),
    /mirror_url/,
  );
});
