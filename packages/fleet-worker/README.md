# fleet-hub (Cloudflare Worker)

Relay only. Machines dial **out** over WebSocket. Operators call HTTPS.

Same protocol as `packages/fleet-hub` (plain Node). Pick one backend.

Jobs do **not** run on the Worker. The device keeps a pane buffer (tmux-style snapshot). The wire is latest-wins at ~4 Hz. `POST /v1/run` returns `accepted` immediately.

Full steps: [English](../../docs/en/deploy.md) · [中文](../../docs/zh/deploy.md)

Hub tokens are `flt_1` (RSA-2048, bound to `HUB_ORIGIN` in `wrangler.toml`). Agents and MCP authenticate with `Fleet-OAEP`, not plaintext Bearer. After deploy, users must issue a new token and run agent 0.2.9+.

`npm run deploy` packs `fleet-tool` into `public/fleet-tool.tgz` first so `GET /fleet-tool.tgz` (Worker static assets) stays current. Import snippet: `npx -y <origin>/fleet-tool.tgz`.

```bash
cd packages/fleet-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HUB_TOKEN
npx wrangler secret put ADMIN_EMAILS
```

`workers_dev` is off. Bind a custom domain (this repo uses `fleet.ginfo.cc`) or set `workers_dev = true` for a `*.workers.dev` preview. Paste that origin into the agent.

## Ops (`/ops`)

Same Worker (`fleet-hub` on `fleet.ginfo.cc`). Not a new Worker or repo.

`GET /ops` is an in-Worker page for usage and last-seen freshness (online/offline, OS / arch / agent version, stale vs recent). It does **not** claim packet loss, congestion, or traffic Mbps. Ban marks a row for abnormal-account identification; it cannot operate machines.

Only a **cookie session** whose email is listed in the `ADMIN_EMAILS` secret can open `/ops` or `/v1/ops/*`. `Authorization` (`Fleet-OAEP` hub tokens, `HUB_TOKEN`) is ignored. Everyone else gets 404 — the page does not exist. Empty / unset secret means no admins (forks stay closed). Comma or whitespace separated; compared case-insensitively. Admins see a muted **Ops** control in the site header (no URL to type); it switches to the ops view, which searches accounts/devices and lists them by most recently active.

```bash
npx wrangler secret put ADMIN_EMAILS
```

Privacy: ops never includes device names, hostnames, or IPs.

Ban copy: 「操作不了你的机子，只是用于异常账号识别」 / “Cannot operate your machines. This is only for identifying abnormal accounts.”
