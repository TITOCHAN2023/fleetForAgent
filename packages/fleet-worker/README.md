# fleet-hub (Cloudflare Worker)

Relay only. Machines dial **out** over WebSocket. Operators call HTTPS.

Same protocol as `packages/fleet-hub` (plain Node). Pick one backend.

Jobs do **not** run on the Worker. The device keeps a pane buffer (tmux-style snapshot). The wire is latest-wins at ~4 Hz. `POST /v1/run` returns `accepted` immediately.

Agent/tool 0.6.0 may negotiate a direct WebRTC DataChannel through this Worker for shell, pane, desktop, and task plugin traffic. WSS remains connected for control, signed token revocation, and fallback. New peers ACK terminal DataChannel replies; an unacknowledged result is replayed once through WSS, while healthy direct traffic still bypasses the Worker. The DataChannel carries the unchanged v1 Envelope, so those handlers do not fork. Optional `RTC_STUN_URLS` is a comma-separated public `[vars]` value, never a secret. There is no TURN relay in this version.

Current task fallback covers missing capability, setup failure, and synchronous send failure. It does not safely cover a request write accepted by the DataChannel but not yet confirmed by the Agent. The future hardened path requires an Agent receive ACK, the same caller-generated `corr` on both paths, a persisted Worker claim before execution, and bounded Agent/Worker idempotent replay. It must narrow today's generic plugin fast path to `invoke` of task actions and force list/install/uninstall onto WSS-only. Generic peer DATA has the opposite policy: it is direct-only and never falls back through this Worker.

Full steps: [English](../../docs/en/deploy.md) · [中文](../../docs/zh/deploy.md)

Hub tokens are `flt_1` (RSA-2048, bound to `HUB_ORIGIN` in `wrangler.toml`). Agents and stdio MCP authenticate with `Fleet-OAEP`. Remote Streamable HTTP uses `POST /mcp`, returns an opaque `Mcp-Session-Id`, and persists only the session identity plus operator selection inside its isolated `McpDO`. Classic SSE remains at `/mcp/sse`: Bearer is sent on the initial GET, then the server announces a random token-free message URL. Both transports revalidate the current key id on every JSON-RPC message. After deploy, users must issue a new token and run agent 0.2.9+.

## Generic plugin peer sessions

`/v1/plugin-peer-session/*` is the control plane for direct, ordered plugin-to-plugin sessions. `PeerSessionDO` stores account and endpoint identity, the exact frozen registry protocol, per-endpoint Core nonce hashes, SDP fingerprints, a short-lived signed `plugin_peer` ticket, and a persistent delivery outbox. It never stores or relays plugin DATA.

Creation selects one registry `peer_protocols` entry and supplies `source` and `target` descriptors containing the exact plugin ID, version, action, role, plus at most 8 KiB of canonical opaque action input. The Worker validates `runtime`, `action_specs`, and `peer_protocols` from the build-pinned official registry. Missing or inconsistent declarations fail closed. The opaque input exists only in the initial prepare outbox and is not copied into the session record or ticket.

Each endpoint Core generates a 32-byte session nonce and a fresh round nonce, submits their unpadded base64url encodings to `authorize`, and retains the raw values locally. The DO decodes and hashes them; only the four SHA-256 hashes enter durable state and the ticket. After the DataChannel opens, the endpoint Cores exchange raw nonces directly and verify them against the signed hashes before allowing opaque FLPP DATA.

The DO generates every negotiation `round_id`. State mutation and outbox insertion are one storage transaction; DeviceDO/FleetDO calls happen afterward. A stable `delivery_id`, replay-until-Agent-ACK DeviceDO delivery, replayable tool inbox with `ack_delivery_ids`, and alarm backoff make control delivery at-least-once without turning the Worker into a byte relay. Every lifecycle event is bound to its round; `active` and `complete` are recorded per side and become global only after both endpoints report them. Old-round callbacks, signals, and ticket jobs cannot modify a newer round. See [`docs/PLUGIN_RUNTIME.md`](../../docs/PLUGIN_RUNTIME.md).

```bash
cd packages/fleet-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put HUB_TOKEN
npx wrangler secret put ADMIN_EMAILS
```

`workers_dev` is off. Bind a custom domain (this repo uses `fleet.ginfo.cc`) or set `workers_dev = true` for a `*.workers.dev` preview. Paste that origin into the agent.

`public/fleet-tool.tgz` is an npm-installable pack of `packages/fleet-tool` (so `npx -y https://fleet.ginfo.cc/fleet-tool.tgz` works). Rebuild it from the repo root with `npm run pack:fleet-tool` after tool changes. Do not rely on SPA fallback for that path — a missing file becomes `index.html`.

## Ops (`/ops`)

Same Worker (`fleet-hub` on `fleet.ginfo.cc`). Not a new Worker or repo.

`GET /ops` is an in-Worker page for usage and last-seen freshness (online/offline, OS / arch / agent version, stale vs recent). It does **not** claim packet loss, congestion, or traffic Mbps. Ban marks a row for abnormal-account identification; it cannot operate machines.

Only a **cookie session** whose email is listed in the `ADMIN_EMAILS` secret can open `/ops` or `/v1/ops/*`. `Authorization` (`Fleet-OAEP` hub tokens, `HUB_TOKEN`) is ignored. Everyone else gets 404 — the page does not exist. Empty / unset secret means no admins (forks stay closed). Comma or whitespace separated; compared case-insensitively. Admins see a muted **Ops** control in the site header (no URL to type); it switches to the ops view, which searches accounts/devices and lists them by most recently active.

```bash
npx wrangler secret put ADMIN_EMAILS
```

Privacy: ops never includes device names, hostnames, or IPs.

Ban copy: 「操作不了你的机子，只是用于异常账号识别」 / “Cannot operate your machines. This is only for identifying abnormal accounts.”
