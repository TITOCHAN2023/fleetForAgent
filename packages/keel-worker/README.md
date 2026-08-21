# keel-hub (Cloudflare Worker)

Relay only. Machines dial **out** over WebSocket. Operators call HTTPS.

Full steps: [docs/DEPLOY.md](../../docs/DEPLOY.md)

```bash
cd packages/keel-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HUB_TOKEN
```

Worker URL looks like `https://keel-hub.<account>.workers.dev`. Paste that domain into the agent.
