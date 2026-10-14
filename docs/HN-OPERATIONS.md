# Public Hub admission and release checklist

This checklist describes code and operator actions, **not confirmation that a
Cloudflare account has alerts or WAF rules configured**. No dashboard settings,
production secrets, or device update preferences are changed by these patches.

## What is protected

- Public pages, the demo, blog JSON, fonts and 404 responses use Workers Static
  Assets; they do not need a Durable Object or authentication. `robots.txt` is
  advisory, not an access-control mechanism. `pack:blog` regenerates the exact
  SPA route rewrites and sitemap. Unknown routes return 404.
- Public OAuth admission has a 60 requests/minute/source/location budget;
  challenge issuance has a deliberately generous 6,000 budget because existing
  Fleet-OAEP clients obtain a fresh challenge per authenticated request.
- MCP credentials are verified on every request, and each verification has a cost.
  The current admission rate limits cover OAuth and challenge issuance, not MCP;
  there is no post-authentication MCP counter. Use deployment-specific WAF rules
  and monitor authentication failures for credential-guessing traffic. These
  limits are not a global DDoS shield. Do not apply browser challenges or blanket
  throttling to legitimate MCP task traffic. Valid established MCP calls, task
  polling, plugins, WSS heartbeats and reconnect messages have no blanket limiter.
- Admission uses only Cloudflare-supplied source metadata, hashes the source
  before constructing the key, and does not store it in Fleet. Local requests
  share a fallback key. Shared NATs share admission budgets: monitor false
  positives before lowering limits. Do not key on an unverified kid or Session ID.
- HTTP control JSON is limited to 16 MiB by **actual streamed bytes**, including
  when Content-Length is absent or dishonest. This matches the device WebSocket
  envelope ceiling. Plugin artifact downloads retain their separate 100 MiB
  streaming bound. File-transfer plugin payloads travel over their peer channel,
  not the Hub JSON endpoint. This is a size limit, not a concurrency limit.
- CSP blocks external scripts, plugin/object embedding and embedding Fleet in
  another site. Existing inline UI scripts/styles and the current Chinese font
  CDN are still allowed for compatibility. This is not a claim of XSS immunity.

Cloudflare rate-limit bindings are approximate and per location, not a global
billing meter. Namespace IDs are account-local; staging must use distinct IDs.
The committed TOML supplies the production binding declarations. Named Wrangler
environments must declare their own bindings; they do not inherit them. A missing
binding or binding failure on Cloudflare returns 503 for the affected admission
route, not for already-running task execution. Unit fixtures without Cloudflare
metadata can omit bindings; that is not a production deployment mode.

## Before sending traffic

1. Run the source suites and isolated two-device Linux tests. Exercise classic
   SSE and Streamable HTTP; current and previous clients; multi-operator task
   ownership; plugin calls; reset/replay rejection; and normal retries after 429.
2. Run `wrangler deploy --dry-run --config wrangler.toml` from
   `packages/fleet-worker` and inspect the two admission bindings. A dry run
   validates packaging, **not** an account's live WAF or limits. On a staging
   hostname, verify actual 200/404 routing, security headers, and local rate
   enforcement with bounded requests. Never load-test production by accident.
3. In the Cloudflare account, verify the plan's current Workers/DO allowances,
   current usage, and available usage/error notifications. Set thresholds with
   headroom for existing devices, and verify the notification destination with a
   test where supported. Record which alerts actually exist; a README checklist
   does not create them. Rate limits do not constitute a hard spending cap.
4. Review WAF rules for repeated scans and abusive public admission traffic.
   Do not add CAPTCHA/JS challenges to `/v1/*`, `/mcp*`, WSS or plugin endpoints.
   Keep an emergency rule scoped to the abused admission route, with an owner,
   expiry and rollback. Avoid cutting off result retrieval or device heartbeats.
5. Review metrics for 401/403/413/429/5xx rates, Worker CPU/errors, Durable Object
   latency/overload, active connections and quota consumption. Avoid logging
   Authorization, Token, MCP session IDs, OAuth callback query strings or command
   output. Keep any diagnostic logging minimal, redacted and time-limited.

## Downloadable version is not the automatic rollout

GitHub's latest release is the latest **manual download**. `LATEST_AGENT_VER`
is the Hub's advertised update and may lag. It is **not a global rollout lock**:
current hardened clients independently discover and verify the official GitHub
latest release, ignoring Hub-supplied binary URLs and version hints in production.
Device preferences and idle-update safeguards remain authoritative. Do not
change the advertisement merely to make the two labels match.

`advertisedUpdate` pins the default GitHub base (including an explicitly configured
`releases/latest/download` alias) to `releases/download/v{LATEST_AGENT_VER}`.
Both the binary and `checksums-{version}.txt` therefore come from the same release.
Custom mirrors and explicit checksum overrides remain operator-owned: verify the
manifest and every platform asset together before changing rollout secrets.

For a release held at 0.6.6 while 0.6.7 is downloadable, the correct automatic
advertised checksum URL ends in `releases/download/v0.6.6/checksums-0.6.6.txt`, not
`releases/latest/download/checksums-0.6.6.txt`. This change does not reset a Token,
enable automatic updates, restart a device, or advance its rollout version.

Before promotion: verify release assets and SHA-256, the build provenance, idle
upgrade behavior and rollback; read back `/v1/health`; then fetch the exact
advertised manifest and representative platform assets. Old clients requiring an
idle maintenance window still require it. Checksums prove consistency with the
manifest, not independent publisher authenticity; the updater does not yet
enforce verification of GitHub build attestations.

## 中文要点

这些改动不等于已配置线上 WAF、告警或预算上限。公开静态页面与控制 API 分开；
OAuth/挑战入口有限流，但机器心跳、合法任务结果和插件没有统一限流。
MCP 每次请求都要验证凭据并承担鉴权成本，当前入口限流不覆盖 MCP，也没有鉴权后的 MCP 计数器。共享出口、每个 Cloudflare 机房
的近似计数都需要监测，不能当成全局精确额度。HTTP 控制包按实际字节限制为
16 MiB，插件文件下载和点对点文件内容走各自原有路径。

最新版安装包不等于 Hub 公告。公告下载地址按公告版本固定，但新客户端会独立
检查官方 GitHub 最新版，因此不能拿旧公告当全局暂停升级开关。本次不修改生产
Token、自动升级开关或发布版本。发帖前要完成隔离验证，再检查真实监控、额度、
通知收件人和回滚预案；不要给机器接口套验证码，也不要记录凭据或任务内容。

## References

- [Rate Limiting binding: locality, accuracy, configuration](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Static routing and custom 404 pages](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
