# FleetForAgent

Fleet hub: list machines, pick one, run. Devices only dial out. The website **is** the hub: log in, generate a token, paste this origin + token into the agent and the operator tool. Multiple accounts share one Node process; SQL scopes every row by `user_id`.

**安装包（exe / dmg / tar.gz）在 Release，不在 git 里：**
[Latest release](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest)

打 macOS 包必须用 `hdiutil` 出真 dmg，禁止把 zip 改名为 `.dmg`。见 [docs/PACKAGING.md](docs/PACKAGING.md)。

登录是 Google / X，不是邮箱。生产域名见 [docs/AUTH.md](docs/AUTH.md)。

**新用户：** 登录网站 → 生成 Hub token → 电脑装 Agent，填本站地址 + token → tool 填同一对。

完整步骤：[docs/DEPLOY.md](docs/DEPLOY.md)

## Quick start (console, local)

```bash
npm install
npm run dev
```

http://127.0.0.1:8080

## Hub is this website

```bash
npm run dev          # http://127.0.0.1:8080
```

Log in → Settings → Generate token. Agent and tool both use that origin + token.

Optional separate relays (Worker / `packages/fleet-hub`) are documented in [docs/DEPLOY.md](docs/DEPLOY.md). New users do not need them.

## Layout

| Path | What |
|---|---|
| `src/routes/v1/` | Website hub routes (`/v1/*`). Token per account. |
| `packages/fleet-agent/` | Go agent. Config: site origin + Hub token |
| `packages/fleet-tool/` | Operator tool / MCP. Env: `FLEET_URL` + `FLEET_TOKEN` |
| `packages/fleet-worker/` | Optional Cloudflare Worker backend |
| `packages/fleet-hub/` | Optional standalone Node hub |
| `src/` | Optional web console |
| `docs/DEPLOY.md` | Deploy tutorial (中文) |
| `migrations/` | Auth + fleet schema (PGLite locally, Postgres in prod) |
