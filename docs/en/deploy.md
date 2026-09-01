# Deploy FleetForAgent

Try the live hub first: **[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**  
Local `npm run dev` is a CLI on loopback — it cannot run a fleet. Cloud is where Windows / Linux / macOS join the same account.

```
New user → https://fleet.ginfo.cc → mint a Hub token
Install Agent on each PC → paste https://fleet.ginfo.cc + token
Import the tool → FLEET_URL + FLEET_TOKEN
```

```
[fleet-tool / Cursor / Claude]
        HTTPS + Fleet-OAEP (flt_1)
            │
            ▼
   fleet.ginfo.cc  (cloud hub)
            ▲
            │  outbound WSS /v1/device
   ┌────────┼────────┐
Windows   Linux           macOS
amd64     amd64/arm64     arm64/amd64
```

Installers live on GitHub Releases, not in git:

https://github.com/TITOCHAN2023/fleetForAgent/releases/latest

---

## 0. New user (default path)

Start at **[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**. Do not begin with `npm run dev` — a hub on 127.0.0.1 is at most a command-line tool.

1. Open [https://fleet.ginfo.cc](https://fleet.ginfo.cc), sign in.
2. Settings → generate a Hub token (plaintext shown once; reset invalidates the old key immediately).
3. Install Agent on each computer. Hub address is **this site's origin** (`https://fleet.ginfo.cc`), then paste the token.
4. Operator:

```bash
FLEET_URL=https://fleet.ginfo.cc FLEET_TOKEN=flt_... node packages/fleet-tool/index.mjs list
```

A/B below are optional separate hub implementations. New users do not fill those URLs. Local `http://127.0.0.1:8080` is only for hacking the website.

## 1. Optional: separate hub (Worker or a Node process)

Same protocol. Use only when you deliberately split the hub from the website.

### A. Cloudflare Worker

Needs: Cloudflare account, Node 18+.

```bash
git clone https://github.com/TITOCHAN2023/fleetForAgent.git
cd fleetForAgent/packages/fleet-worker
npm install
npx wrangler login
```

Before deploying, replace both production-domain values in `wrangler.toml`: set `HUB_ORIGIN` to your exact public origin and set `[[routes]].pattern` to its hostname. Then register these callbacks in your own Google and X OAuth applications:

```text
https://your.example/v1/auth/callback/google
https://your.example/v1/auth/callback/x
```

The callback origin, `HUB_ORIGIN`, and route hostname must describe the same site; otherwise login fails or issued `flt_1` tokens have the wrong audience. Now deploy:

```bash
npx wrangler deploy
```

`wrangler.toml` sets `workers_dev = false`, so there is no `*.workers.dev` URL. Bind that custom domain in Cloudflare and paste its origin into the Agent. This repo's production host is `https://fleet.ginfo.cc`. For a workers.dev preview, enable `workers_dev`, remove the custom route, and use the workers.dev origin consistently in OAuth and `HUB_ORIGIN`.

### Authentication

```bash
npx wrangler secret put ADMIN_EMAILS
```

The public Worker has no deployment-wide machine-control credential. Configure the OAuth providers described in [Auth](auth.md), sign in, and issue one per-account `flt_1` token from Settings. Agents and the local Tool use Fleet-OAEP; remote MCP accepts Bearer only for session initialization. Every machine route stays scoped to that account.

`ADMIN_EMAILS` is a comma or whitespace list of cookie-session emails that may open `/ops` on this same Worker. Empty / unset = no admins. It never authenticates a machine-control request or adds authority beyond that user's existing account-scoped access. Do not put emails in `[vars]`.

Local debug:

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev --port 8787
```

Agent: `http://127.0.0.1:8787` (turned into `ws://…/v1/device`).

### Default direct data channel and optional self-hosted STUN

Agent 0.6.2 and local `fleet-tool` 0.6.3 keep the existing WSS control connection while attempting a WebRTC DataChannel. Completing the short signaling context does not cancel the established session. A successful direct path carries the same `{ v, type, id, corr, t, body }` used by WSS for run, panes, desktop, and plugins. New peers negotiate terminal-result ACKs: if a DataChannel write succeeds but the Tool never receives it, the Agent replays that reply once through WSS and closes the unhealthy direct session. Healthy direct business traffic still bypasses the Worker, and old peers keep their existing behavior because they do not negotiate the extension. ICE failure, timeout, or a client without `rtc_v1` falls back to the existing Worker → WSS route. Remote `/mcp` and `/mcp/sse` execute inside the Worker and remain relayed because Workers do not expose a UDP socket.

STUN discovers public mappings; it does not relay command data. The Worker ships with Cloudflare STUN in its public configuration:

```toml
RTC_STUN_URLS = "stun:stun.cloudflare.com:3478"
```

The Agent and Tool need no separate setting; they obtain this address from the Worker for every new RTC session. The first version deliberately has no TURN path. To self-host coturn on a small VPS, configure it in STUN-only mode on UDP 3478, then replace the default public Worker variable:

```toml
RTC_STUN_URLS = "stun:stun.example.com:3478"
```

Open UDP 3478 in both the host firewall and cloud security group. A STUN outage only makes that direct attempt fail; Fleet stays available through WSS.

### B. Plain deploy (VPS / local Node)

No Cloudflare. One Node 18+ machine:

```bash
cd packages/fleet-hub
npm install
SELF_HOST_TOKEN=change-me PORT=8787 HOST=0.0.0.0 npm start
```

Local Agent: `http://127.0.0.1:8787`. On the public internet put Caddy / nginx in front for HTTPS; Agent uses `hub.example.com`.

Control-plane paths match the Worker: `/v1/health`, `/v1/list_computers`, `/v1/run`, `/v1/get_result`, `/v1/read_screen`, `/v1/type`. Devices still use `WSS /v1/device`.

This Node hub is a single-user `SELF_HOST_TOKEN` relay: no `flt_1`, no per-account isolation. An empty `SELF_HOST_TOKEN` is **loopback-only** (`HOST=127.0.0.1`). Binding `0.0.0.0` or a public address requires a token. Agents and Tools keep their existing `FLEET_TOKEN` setting and receive the same value.

Existing installations may keep the deprecated `HUB_TOKEN` environment name during migration. New installations should use `SELF_HOST_TOKEN`; it takes precedence when both are present.

systemd example:

```
[Service]
WorkingDirectory=/opt/fleet/packages/fleet-hub
Environment=PORT=8787
Environment=SELF_HOST_TOKEN=change-me
ExecStart=/usr/bin/node index.mjs
Restart=always
```

---

## 2. Install Agent on each computer

Download from [Releases](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest):

| OS | File |
|---|---|
| Windows | `FleetAgent-windows-amd64.exe` |
| macOS Apple silicon | `FleetAgent-macos-arm64.dmg` (real disk image; do not rename a zip) |
| macOS Intel | `FleetAgent-macos-amd64.dmg` |
| Linux amd64 | `fleet-agent-linux-amd64.tar.gz` |
| Linux ARM64 | `fleet-agent-linux-arm64.tar.gz` |

Then:

1. Open the installer (Windows: double-click the exe; Mac: drag to Applications).
2. **Mac / Windows:** first launch opens `http://127.0.0.1:17890`. Closing the page is fine: Mac is next to the clock, Windows is in the tray. Click the icon again to reopen settings; right-click toggles the machine and execution permission.
3. **Linux: no settings page.** Unzip and start with env vars. Status is in the panel tray (KDE / XFCE / Cinnamon by default; GNOME needs the AppIndicator extension). Right-click for on/off and permission. No graphical session: run in the background.

```bash
export FLEET_URL=https://fleet.ginfo.cc
export FLEET_TOKEN=flt_…
./fleet-agent
```

Config is also written to `~/.fleet-agent/config.json`. Optional `FLEET_ENABLED=1`.

All three platforms have a CLI that shares the local API (`127.0.0.1:17890`) with the tray / settings page. Do not edit two copies of config:

```bash
fleet start --hub https://fleet.ginfo.cc --token flt_…
fleet status
fleet permit ask
fleet stop          # disable this machine, process stays
fleet quit          # exit the process
fleet help
```

Mac binary: `"/Applications/Fleet Agent.app/Contents/MacOS/FleetAgent" status`  
or `fleet install` to put `fleet` on PATH. The Linux tarball has both `fleet` and `fleet-agent` (same file). Windows: `FleetAgent.exe status`; `fleet install` copies to `%LOCALAPPDATA%\Fleet\fleet.exe`.
5. Mac/Windows: paste the hub origin (no path) and connect; Linux uses `FLEET_URL` above. Connected icon is `F•`.
6. While enabled, the Agent blocks idle sleep (the screen may still lock). Closing the lid is not blocked. Linux uses `systemd-inhibit --what=idle:sleep`.
7. Permission (settings page on Mac/Windows, tray right-click on all platforms):
   - **Off**: refuse run and type (including existing panes), plus plugin installation, removal, task execution, and peer sessions
   - **Ask**: run, later keystrokes, and plugin operations need approval at the machine
   - **Allow**: commands and plugin operations run immediately without another plugin click. The destructive-command policy and plugin source/platform/action/runtime/SHA-256 checks remain enforced

The device only dials out. **No inbound ports, public IP, or VPN on the device side.** The Node machine in a plain deploy must of course be reachable (80/443 or the port you chose).

Rebuild installers yourself:

```bash
npm run release:agent
gh release create v0.x.0 public/dl/FleetAgent-* public/dl/fleet-agent-linux-amd64.tar.gz
```

---

## 3. List machines, pick one, run

Worker and Node hubs share the same paths, not the same authentication. For the Worker, use `fleet-tool` with `FLEET_URL` + the account's `flt_1`; it performs the Fleet-OAEP challenge. The raw Bearer examples below are only for the single-user Node hub. Set `$HUB=https://hub.example.com` and `$SELF_HOST_TOKEN` to the value used by the Node process.

Health:

```bash
curl $HUB/v1/health
```

List devices (no IPs):

```bash
curl -X POST $HUB/v1/list_computers \
  -H "authorization: Bearer $SELF_HOST_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

Run a command:

```bash
curl -X POST $HUB/v1/run \
  -H "authorization: Bearer $SELF_HOST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","command":"uname -a"}'
```

Returns `{ "corr": "...", "status": "running" }`. Then fetch the result:

```bash
curl -X POST $HUB/v1/get_result \
  -H "authorization: Bearer $SELF_HOST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","corr":"<corr>"}'
```

Protocol envelope: `{ v:1, type, id, corr, t, body }`. The device path is only `WSS /v1/device`.

### Keep async jobs from blocking (tmux-hub style)

The job lives in a **pane on the device**, not on the hub request.

| Don't | Do |
|---|---|
| Stream stdout bytes through the hub | Local ring buffer, like tmux pane history |
| Keep `pipe-pane` pushing | `capture-pane` snapshots |
| HTTP-wait until `sleep 30` finishes | Immediate `accepted`, then `read_screen` / `get_result` |
| One WS message per line of output | 4 Hz latest-wins, drop intermediate frames |

```bash
# returns immediately { corr, status: running }
curl -X POST $HUB/v1/run -H "authorization: Bearer $SELF_HOST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","command":"yes"}'

# snapshot, do not attach
curl -X POST $HUB/v1/read_screen -d '{"device_id":"<id>"}' ...

# type into stdin, do not wait for the process
curl -X POST $HUB/v1/type -d '{"device_id":"<id>","keys":"q\n"}' ...
```

Control plane (ping / type / read_screen) does not `Wait()`. A 10k-line compile will not stall the hub.

---

## 4. Optional: deploy the console website

The repo root is the TanStack Start console (login, lab, downloads). Preview uses in-process PGLite; production uses Postgres.

```bash
# repo root
cp .env.example .env.local
# DATABASE_URL=postgres://...
# BETTER_AUTH_SECRET=long random string
# BETTER_AUTH_URL=https://your.site
npm install
npm run build
```

Any Node host, or Neon + your usual frontend host. Console and hub are separate: the hub (Worker or `packages/fleet-hub`) relays devices; the website does login and UI.

---

## 5. Security notes

- Devices only dial out. Home routers need no port map.
- Token goes in the `Authorization` header, not the URL.
- The three local permission levels run on the device; the hub cannot change them. They cover run/type and every plugin installation, removal, task, and peer operation. `allow` removes the extra click, not the destructive-command policy or plugin source/action/runtime/SHA-256 checks; changing between WSS and RTC cannot bypass this decision.
- Worker machine access is always account-scoped; the optional ops allowlist grants no extra machine-control authority. The single-user Node hub requires `SELF_HOST_TOKEN` on a public bind (empty token is loopback-only), and possession grants full control of that instance.
- Machines cannot ping each other. There is no LAN overlay.

---

## FAQ

**Cannot reach the hub**  
The domain may omit `https://`; the Agent fills it in. From that machine, `curl /v1/health` should work. Worker: confirm `npx wrangler deploy` succeeded. Plain deploy: Node is listening and the reverse proxy upgrades WebSocket.

**Mac: unsigned / cannot open**  
Confirm it is a **real dmg** (`file` must not say `Zip archive`). Fake dmgs were a packaging-script bug, see [packaging.md](packaging.md).

A real image can still be blocked by Gatekeeper (not notarized): System Settings → Privacy & Security → Open Anyway; or right-click `.app` → Open; or `xattr -cr "/Applications/Fleet Agent.app"`. Zip fallback: unzip the `.app` and drag to Applications. Do not rename a zip to `.dmg`.

**Windows SmartScreen**  
More info → Run anyway. Normal for an unsigned exe.

**list_computers is empty**  
The Agent must show connected first. Wait a few seconds and POST again.

**Windows jobs vs Mac/Linux live shell**
Mac/Linux share a login PTY (cwd and env persist across commands). Windows uses `cmd /C` oneshot so the agent still compiles and runs without ConPTY. Same hub protocol either way.

**Tray says connected, list says offline**  
The hub advertised `heartbeat_s` but older agents never sent a heartbeat, so a half-open socket (common on Windows after sleep or NAT idle) stayed “online” on the machine and “offline” on the hub. Current agents ping the hub every 25s; a failed ping reconnects. Restart the Agent once to pick that up.

**Change the domain**  
Worker: bind a Custom Domain, then every Agent reconnects to the new name. Plain deploy: change the reverse-proxy name; Agents do the same.
