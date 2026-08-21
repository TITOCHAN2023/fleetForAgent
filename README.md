# KEEL

Fleet hub: list machines, pick one, run. Devices only dial out to a Worker. No machine cap. English by default, 中文 toggle on every surface (web + Windows / Mac / Linux agent).

## Run locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:8080

- Sign in with Google / X (Grok auth broker in the Grok preview; locally you can set `VITE_AUTH_ENABLED=false` for a single `dev-user`).
- Lab, downloads, and the on-machine settings page work without sign-in.

## Install an agent

From **Downloads** (or `public/dl/`):

| OS | File |
|---|---|
| Windows | `KeelAgent-windows-amd64.exe` |
| macOS Apple silicon | `KeelAgent-macos-arm64.dmg` (zip fallback next to it) |
| macOS Intel | `KeelAgent-macos-amd64.dmg` |
| Linux | `keel-agent-linux-amd64.tar.gz` |

Open it, turn on **Allow this computer to run**, paste the hub domain, connect. Policy: Off / Ask at the machine / Allow all.

Rebuild agents:

```bash
npm run release:agent
```

## Database

Preview uses in-process PGLite (Postgres in WASM). Process restart wipes sessions and fleet rows.

Production: set `DATABASE_URL` to Neon/Postgres. Same files in `migrations/` apply (`0001_auth.sql` identity, `0002_keel.sql` fleet). Copy `.env.example` → `.env.local`.

## Layout

- `src/` — TanStack Start hub (console, lab, agent settings, i18n)
- `packages/keel-agent/` — Go local agent (settings UI on `127.0.0.1:17890`)
- `packages/keel-worker/` — Cloudflare Worker / Durable Object sketch
- `public/dl/` — installable binaries
