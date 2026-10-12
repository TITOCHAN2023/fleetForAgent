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
    verified, // Legacy format check only; retained for existing clients.
    source_claim_present: verified,
    verification_method: "self-reported",
    runtime_verified: false,
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
  const status = verified ? "source declared" : "source missing";
  const statusLabel = verified
    ? "This process reports a 40-hex git commit baked at deploy."
    : "No 40-hex SOURCE_COMMIT is baked into this process. No source claim is available.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fleet source identity</title>
  <meta name="description" content="Inspect Fleet release evidence and its verification limits." />
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
    <h1>Hub release evidence</h1>
    <p>${htmlEscape(statusLabel)}</p>
    <p>This page reports the source identity claimed by <code>${hub}</code>. It does not independently verify the running code. A valid commit string is not a security verdict.</p>
    <p><a href="/docs/same-source-as-github">Read the maintained trust document: evidence, limits, and next steps.</a></p>
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
# A valid source_commit is a claim, not runtime verification
git ls-remote ${repo.replace(/\/+$/, "")}.git ${commit || "HEAD"}
${verified ? `git clone --depth 1 ${repo}.git && git -C fleetForAgent fetch --depth 1 origin ${commit} && git -C fleetForAgent checkout ${commit}` : "# no commit baked; stop here"}</pre>
    <h2>Verify the build evidence</h2>
    <p>For releases using the evidence workflow, open the reported Actions run and download its hub-evidence artifact. Verify the archive before extracting it:</p>
    <pre>gh attestation verify hub-evidence.tar.gz --repo TITOCHAN2023/fleetForAgent --signer-workflow TITOCHAN2023/fleetForAgent/.github/workflows/deploy-hub.yml</pre>
    <p>Check the verified provenance commit, receipt, checksums and deploy step. Downloads require GitHub login; artifacts are retained for 90 days. The archive covers Worker JavaScript and repository configuration, not static assets, secrets or the live runtime.</p>
    <h2>What remains a trust decision</h2>
    <p>A Cloudflare account administrator can deploy different code while reporting a public SHA. Authorized reviewers can inspect deployed scripts and configuration through Cloudflare APIs; that is separate from this self-report and is not a per-request hardware proof. Independent deployment audits and enforced approval settings must be evidenced separately. The legacy JSON field <code>verified</code> checks commit format only; <code>runtime_verified</code> remains false.</p>
    <p lang="zh">这里展示的是 Hub 自报的版本。请到公开发布记录核验下载文件的来源；这不能证明每次请求运行的代码。独立审计与生产权限设置的落实情况，请看置顶信任文档。</p>
  </main>
</body>
</html>
`;
}
