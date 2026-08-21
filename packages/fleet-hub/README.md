# fleet-hub (Node)

Same relay as `packages/fleet-worker`, without Cloudflare.

Devices dial **out** over WebSocket. Operators call HTTPS. Jobs do **not** run on the hub.

```bash
cd packages/fleet-hub
npm install
HUB_TOKEN=change-me PORT=8787 npm start
```

Agent: paste `http://127.0.0.1:8787` (local) or `hub.example.com` (behind TLS).

Production: put Caddy/nginx in front for HTTPS, set `HUB_TOKEN`, bind `0.0.0.0`.

Full steps: [docs/DEPLOY.md](../../docs/DEPLOY.md)
