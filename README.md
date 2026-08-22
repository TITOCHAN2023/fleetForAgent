# Fleet

**Docs:** [English](docs/en/README.md) · [中文](docs/zh/README.md)

![Fleet](docs/media/title.png)

**Your coding agent, on your real machines.**  
Devices only dial out. The website **is** the hub. No inbound ports, no VPS on the device side.

![How a command travels](docs/media/architecture-flow.gif)

Log in → mint a Hub token → install Agent on each computer (this origin + token) → point Cursor / Claude MCP at the same pair. Multiple accounts share one Node process; SQL scopes every row by `user_id`.

[Latest release](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest) · [Deploy](docs/en/deploy.md) · [Auth](docs/en/auth.md) · [Media kit](docs/media/README.md) · [中文文档](docs/zh/README.md)

## How it works

![Fleet architecture](docs/media/architecture.svg)

1. **You** — Cursor, Claude, or any MCP client. `FLEET_URL` + `FLEET_TOKEN`.
2. **Hub** — this website. Login, mint tokens, route jobs on `/v1/*`.
3. **Agent** — a small process on Mac / Windows / Linux. It opens an outbound WebSocket (`/v1/device`) and never accepts inbound connections.

A command is a round trip: MCP → hub → agent → stdout/result back.

Silent 24s explainer (visual bed for a later VO video): [docs/media/architecture.mp4](docs/media/architecture.mp4)

## New user

![Four steps](docs/media/setup.png)

1. Open the site, sign in with **Google / X** (not email). Production domain: [docs/en/auth.md](docs/en/auth.md).
2. Settings → generate a Hub token (plaintext shown once; reset invalidates the old key).
3. Install Agent from [Releases](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest). Paste this site's origin + the token.
4. Operator / MCP:

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node packages/fleet-tool/index.mjs list
```

macOS installers must be real `hdiutil` dmg files, not renamed zips — [docs/en/packaging.md](docs/en/packaging.md).

Full walkthrough: [English](docs/en/deploy.md) · [中文](docs/zh/deploy.md)

## Quick start (console, local)

```bash
npm install
npm run dev
```

http://127.0.0.1:8080 → log in → Settings → Generate token. Agent and tool both use that origin + token.

Optional separate relays (Cloudflare Worker / `packages/fleet-hub`) are in [docs/en/deploy.md](docs/en/deploy.md). New users do not need them.

## Layout

| Path | What |
|---|---|
| `src/routes/v1/` | Website hub routes (`/v1/*`). Token per account. |
| `packages/fleet-agent/` | Go agent. Config: site origin + Hub token |
| `packages/fleet-tool/` | Operator / MCP. Env: `FLEET_URL` + `FLEET_TOKEN` |
| `packages/fleet-worker/` | Optional Cloudflare Worker backend |
| `packages/fleet-hub/` | Optional standalone Node hub |
| `docs/en/`, `docs/zh/` | Docs by language |
| `docs/media/` | Architecture diagrams, GIF, explainer video, VO script |
| `migrations/` | Auth + fleet schema (PGLite locally, Postgres in prod) |
