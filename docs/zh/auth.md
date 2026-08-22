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
