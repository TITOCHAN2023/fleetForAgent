# 登录

产品登录一直是 **Google / X**。邮箱密码不是新设计，是把站点绑到 `fleet.ginfo.cc` Worker 时的临时方案，不要再当主路径。

## 两套环境，不要混

| 环境 | 怎么登 | 回调 |
|---|---|---|
| 本地 / Grok 预览 `*.grok-sandbox.com` | TanStack + Better Auth，经 **Grok broker**（`auth.grok.me`）转 Google/X | 预览 client 只允许 `*.grok-sandbox.com` |
| 生产 `https://fleet.ginfo.cc` | 同一套按钮，Worker 走 **原生 Google / X OAuth** | 见下 |

Grok 预览 client **不能**用在 `fleet.ginfo.cc`。redirect_uri 对不上，broker 会拒。不要把 `PREVIEW_CLIENT_ID` 配到生产域名。

## 生产必须配的 secret

在 `packages/fleet-worker`：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
```

Google Cloud 里建 Web 应用，授权重定向 URI：

```
https://fleet.ginfo.cc/v1/auth/callback/google
```

X 开发者门户 OAuth 2.0，callback：

```
https://fleet.ginfo.cc/v1/auth/callback/x
```

未配置时按钮会打开明确错误页。不要再加邮箱密码登录。`/v1/register` 和 `/v1/login` 已关闭。

## 高安全 Hub token（`flt_1`）

设置页为每个账号生成一对 RSA-2048。复制出来的字符串是 `flt_1.<payload>.<sig>`：里面带公钥和密钥，并且绑定 `HUB_ORIGIN`（`https://fleet.ginfo.cc`），不绑 HTTP Host。

Agent 和 MCP 不会把整串当 `Authorization: Bearer` 发出去。它们会：

1. `GET /v1/challenge?kid=…` — 中枢用对应私钥对 nonce 做 PSS 签名。
2. 用 token 里的公钥 OAEP 封装 `{sec, nonce}`。
3. 在 WSS `/v1/device` 和每次操作 HTTPS 上发送 `Authorization: Fleet-OAEP <kid>.<wrap>`。

刷新 token 会删掉旧密钥，并断开该账号下所有设备 WebSocket（`1008 token reset`）。旧的 `flt_` hex Bearer 会被拒绝，英文 `HIGH_SEC` 提示：更新 Agent / MCP 客户端，再签发新 token。

`HUB_ORIGIN` 写在 `packages/fleet-worker/wrangler.toml` 的 `[vars]`。可选的 `HUB_TOKEN` 仍只做 HTTP list/run 超级操作员，不能抢设备 WebSocket。
