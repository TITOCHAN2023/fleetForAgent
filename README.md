# FleetForAgent

Fleet hub: list machines, pick one, run. Devices only dial out to a Cloudflare Worker. No VPS, no inbound ports, no machine cap.

**安装包（exe / dmg / tar.gz）在 Release，不在 git 里：**
[Latest release](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest)

**部署 Worker + 装 Agent 的完整步骤：**
[docs/DEPLOY.md](docs/DEPLOY.md)

## Quick start (console, local)

```bash
npm install
npm run dev
```

http://127.0.0.1:8080

## Deploy the Worker

```bash
cd packages/fleet-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HUB_TOKEN
```

Paste the `*.workers.dev` host into each agent.

## Layout

| Path | What |
|---|---|
| `packages/fleet-worker/` | Cloudflare Worker + Durable Objects (the relay) |
| `packages/fleet-agent/` | Go agent (Windows exe, macOS dmg, Linux tar.gz) |
| `src/` | Optional web console |
| `docs/DEPLOY.md` | Deploy tutorial (中文) |
| `migrations/` | Auth + fleet schema (PGLite locally, Postgres in prod) |
