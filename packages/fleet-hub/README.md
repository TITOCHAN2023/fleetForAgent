# fleet-hub (Node)

Same HTTP + WSS relay as `packages/fleet-worker`, without Cloudflare. This is a **single shared `HUB_TOKEN`**. It has no per-account `flt_1` handshake, no Google / X login, and no multi-tenant isolation.

Devices dial **out** over WebSocket. Operators call HTTPS. Jobs do **not** run on the hub.

```bash
cd packages/fleet-hub
npm install
HUB_TOKEN=change-me PORT=8787 npm start
```

Empty `HUB_TOKEN` is allowed only on loopback (`HOST=127.0.0.1`). Binding `0.0.0.0` without a token exits.

Agent: paste `http://127.0.0.1:8787` (local) or `hub.example.com` (behind TLS).

Production: put Caddy/nginx in front for HTTPS, set `HUB_TOKEN`, bind `0.0.0.0`.

Full steps: [English](../../docs/en/deploy.md) · [中文](../../docs/zh/deploy.md)
