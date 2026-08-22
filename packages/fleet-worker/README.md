# fleet-hub (Cloudflare Worker)

Relay only. Machines dial **out** over WebSocket. Operators call HTTPS.

Same protocol as `packages/fleet-hub` (plain Node). Pick one backend.

Jobs do **not** run on the Worker. The device keeps a pane buffer (tmux-style snapshot). The wire is latest-wins at ~4 Hz. `POST /v1/run` returns `accepted` immediately.

Full steps: [English](../../docs/en/deploy.md) · [中文](../../docs/zh/deploy.md)

Hub tokens are `flt_1` (RSA-2048, bound to `HUB_ORIGIN` in `wrangler.toml`). Agents and MCP authenticate with `Fleet-OAEP`, not plaintext Bearer. After deploy, users must issue a new token and run agent 0.2.9+.

```bash
cd packages/fleet-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HUB_TOKEN
```

Worker URL looks like `https://fleet-hub.<account>.workers.dev`. Paste that domain into the agent.
