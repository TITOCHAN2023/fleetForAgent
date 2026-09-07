/** Public source identity for the hosted hub.

HN-style doubt is "GitHub is one tree, production is another." This module
turns that into a checkable JSON document. It does not claim Cloudflare
exposes live Worker bytecode — `verified` only means SOURCE_COMMIT is a
40-hex git object name baked at deploy time.
*/

export const DEFAULT_SOURCE_REPO = "https://github.com/TITOCHAN2023/fleetForAgent";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function trimStr(value) {
  return String(value ?? "").trim();
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sourceIdentity(env = {}) {
  const repo = trimStr(env.SOURCE_REPO) || DEFAULT_SOURCE_REPO;
  const commit = trimStr(env.SOURCE_COMMIT).toLowerCase();
  const tag = trimStr(env.SOURCE_TAG);
  const workflowRun = trimStr(env.SOURCE_WORKFLOW_RUN);
  const bundleSha256 = trimStr(env.SOURCE_BUNDLE_SHA256).toLowerCase();
  const verified = COMMIT_RE.test(commit);
  /** @type {Record<string, unknown>} */
  const out = {
    name: "fleet-hub",
    source_repo: repo.replace(/\/+$/, ""),
    source_commit: verified ? commit : "",
    verified,
  };
  if (verified) {
    out.source_commit_url = `${out.source_repo}/commit/${commit}`;
    out.source_tree = `${out.source_repo}/tree/${commit}`;
    out.source_archive = `${out.source_repo}/archive/${commit}.tar.gz`;
  }
  if (tag) out.source_tag = tag;
  if (workflowRun) out.source_workflow_run = workflowRun;
  if (SHA256_RE.test(bundleSha256)) out.source_bundle_sha256 = bundleSha256;
  return out;
}

export function publicSource(env = {}, extra = {}) {
  return { ...sourceIdentity(env), ...extra };
}

export function isSourcePath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return path === "/source" || path === "/v1/source";
}

export function isTrustPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return path === "/trust";
}

export function sourceHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
  };
}

export function trustPage(identity, { origin = "https://fleet.ginfo.cc" } = {}) {
  const src = identity && typeof identity === "object" ? identity : sourceIdentity();
  const repo = htmlEscape(src.source_repo || DEFAULT_SOURCE_REPO);
  const commit = htmlEscape(src.source_commit || "");
  const verified = src.verified === true;
  const commitUrl = htmlEscape(src.source_commit_url || "");
  const treeUrl = htmlEscape(src.source_tree || "");
  const archiveUrl = htmlEscape(src.source_archive || "");
  const tag = htmlEscape(src.source_tag || "");
  const runUrl = htmlEscape(src.source_workflow_run || "");
  const bundle = htmlEscape(src.source_bundle_sha256 || "");
  const hub = htmlEscape(String(origin || "https://fleet.ginfo.cc").replace(/\/+$/, ""));
  const status = verified ? "verified" : "unverified";
  const statusLabel = verified
    ? "This process reports a 40-hex git commit baked at deploy."
    : "No 40-hex SOURCE_COMMIT is baked into this process. Treat the hosted hub as unverified.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fleet source identity</title>
  <meta name="description" content="Check that fleet.ginfo.cc was deployed from the public GitHub repository." />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <style>
    :root { color-scheme: light dark; --bg:#f7f7f8; --fg:#0d0d0d; --muted:#6e6e80; --ok:#0f7b4c; --bad:#c7381a; --border:#e5e5e5; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --sans: ui-sans-serif, system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#212121; --fg:#ececec; --muted:#b4b4b4; --ok:#3dd68c; --bad:#ff8a80; --border:rgba(255,255,255,.1); }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 var(--sans); }
    main { max-width: 44rem; margin: 0 auto; padding: 48px 20px 80px; }
    a { color: inherit; }
    h1 { font-size: 2rem; letter-spacing: -0.04em; margin: 0 0 12px; }
    h2 { font-size: 1.1rem; margin: 2rem 0 8px; }
    p, li { color: var(--muted); }
    code, pre { font-family: var(--mono); font-size: 13px; }
    pre { overflow: auto; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; }
    .status { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid currentColor; border-radius: 999px; padding: 2px 10px; }
    .ok { color: var(--ok); } .bad { color: var(--bad); }
    dl { display: grid; grid-template-columns: 10rem 1fr; gap: 8px 16px; }
    dt { color: var(--muted); font-size: 13px; } dd { margin: 0; word-break: break-all; font-family: var(--mono); font-size: 13px; }
    .nav { margin-bottom: 32px; font-size: 14px; }
    .nav a { margin-right: 16px; }
  </style>
</head>
<body>
  <main>
    <p class="nav"><a href="/">Fleet</a><a href="/source">/source JSON</a><a href="${repo}">GitHub</a></p>
    <p><span class="status ${verified ? "ok" : "bad"}">${status}</span></p>
    <h1>Same tree as GitHub, or not</h1>
    <p>${htmlEscape(statusLabel)}</p>
    <p>The usual doubt: the public repo is one codebase and <code>${hub}</code> is another. This page is the check. It is not a Cloudflare bytecode dump — nobody outside Cloudflare can hash the live Worker isolate. What you can check is the git object this process claims, the public Actions run that deployed it, and the Agent attestations on GitHub Releases.</p>
    <h2>What this process claims</h2>
    <dl>
      <dt>repository</dt><dd><a href="${repo}">${repo}</a></dd>
      <dt>commit</dt><dd>${verified && commitUrl ? `<a href="${commitUrl}">${commit}</a>` : "(missing)"}</dd>
      <dt>tree</dt><dd>${verified && treeUrl ? `<a href="${treeUrl}">${treeUrl}</a>` : "—"}</dd>
      <dt>tag</dt><dd>${tag || "—"}</dd>
      <dt>workflow run</dt><dd>${runUrl ? `<a href="${runUrl}">${runUrl}</a>` : "—"}</dd>
      <dt>bundle sha256</dt><dd>${bundle || "—"}</dd>
      <dt>archive</dt><dd>${verified && archiveUrl ? `<a href="${archiveUrl}">${archiveUrl}</a>` : "—"}</dd>
    </dl>
    <h2>Check it yourself</h2>
    <pre>curl -sS ${hub}/source
# source_commit should be a 40-hex SHA and verified=true
git ls-remote ${repo.replace(/\/+$/, "")}.git ${commit || "HEAD"}
${verified ? `git clone --depth 1 ${repo}.git && git -C fleetForAgent fetch --depth 1 origin ${commit} && git -C fleetForAgent checkout ${commit}` : "# no commit baked; stop here"}</pre>
    <h2>What a yes does not prove</h2>
    <p>A Cloudflare account token can still publish a different Worker while advertising a public SHA. Mitigation: production deploys of <code>fleet.ginfo.cc</code> go through <code>.github/workflows/deploy-hub.yml</code> in this repository; <code>SOURCE_COMMIT</code> is set from <code>$GITHUB_SHA</code> in that job; a laptop <code>wrangler deploy</code> without those vars makes <code>verified</code> false. Agent installers are a stronger case: they embed <code>vcs.revision</code> and ship GitHub attestations plus <code>checksums-*.txt</code>.</p>
    <p lang="zh">中文：线上中枢会公开它部署时的 git commit。用 <code>curl /source</code> 对一下 GitHub。Cloudflare 不会让你下载线上 Worker 字节码，所以这是「CI 烘焙 + 公开声明」，不是对 isolate 的哈希比对。Agent 安装包可以用 <code>gh attestation verify</code> 和 checksums 核。</p>
  </main>
</body>
</html>
`;
}
