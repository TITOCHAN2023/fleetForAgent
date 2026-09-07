# 源码就是线上那套

常见怀疑：GitHub 上一套，[https://fleet.ginfo.cc](https://fleet.ginfo.cc) 另一套。不要拿仓库截图当证据，去核。

站点文章（也在 `/docs`）：[为什么线上中枢就是 GitHub 上这棵树](https://fleet.ginfo.cc/docs/same-source-as-github)。

## 线上身份

未鉴权，`Cache-Control: no-store`：

```bash
curl -sS https://fleet.ginfo.cc/source
```

人读页（没有 JavaScript）：[https://fleet.ginfo.cc/trust](https://fleet.ginfo.cc/trust)

`verified` 为 true 的唯一条件：`SOURCE_COMMIT` 是 40 位 hex 的 git 对象名。`/v1/health` 里同样有 `source` 字段。

| 字段 | 含义 |
|---|---|
| `source_repo` | 公开仓库，默认 `https://github.com/TITOCHAN2023/fleetForAgent` |
| `source_commit` | 部署时烘焙的 SHA（`$GITHUB_SHA`） |
| `source_workflow_run` | 发布这次 Worker 的 Actions 运行 |
| `source_bundle_sha256` | 同一 job 里 Wrangler dry-run 脚本的 SHA-256 |
| `source_tag` | 若这次是 tag 部署 |

## 生产怎么发

`.github/workflows/deploy-hub.yml` 是 `fleet.ginfo.cc` 的预定发布路径。这个 job：

1. checkout 它将要声明的那次 commit
2. `wrangler deploy --dry-run` 并对脚本做 SHA-256
3. 用 GitHub OIDC 给这份 bundle 做 attestation
4. `wrangler deploy --var SOURCE_COMMIT:$GITHUB_SHA`（外加 repo / 运行 URL / bundle hash）
5. **不**保留 dashboard vars（不开 `--keep-vars`）。笔记本上裸跑 `npx wrangler deploy` 且不带这些 `--var` 会清掉 `SOURCE_COMMIT`，于是 `/source.verified` 变 false

`CLOUDFLARE_API_TOKEN` 只放 GitHub Actions secrets，不要放笔记本。

## 这证明不了什么

Cloudflare 不会让外人下载线上 Worker isolate 再哈希。拿着 Cloudflare token 的人仍可以部署另一份 Worker，同时广告一个公开 SHA。对策是流程，不是字节码证明：token 只在 Actions 里、声明的 SHA 来自 `$GITHUB_SHA`、workflow URL 公开、笔记本部署后 `verified=false`。

## Agent 安装包更硬

Release 二进制嵌入 `vcs.revision`（`go build -buildvcs=true`），脏工作区直接拒绝。checksums 和 GitHub attestation 跟 Release 一起发：

```bash
curl -fsSL https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download/checksums.txt
gh attestation verify --repo TITOCHAN2023/fleetForAgent FleetAgent-macos-arm64.dmg
go version -m ./fleet-agent | grep vcs.revision
```

## 自托管

自己的 Worker：用同一份 workflow 对你的账号跑，或自己传 `--var SOURCE_COMMIT:$(git rev-parse HEAD)`。

Node 中枢：

```bash
SOURCE_COMMIT=$(git rev-parse HEAD) \
SOURCE_REPO=https://github.com/TITOCHAN2023/fleetForAgent \
SELF_HOST_TOKEN=change-me PORT=8787 node packages/fleet-hub/index.mjs
```

即使设了 `SELF_HOST_TOKEN`，`GET /source` 和 `GET /trust` 仍然公开。
