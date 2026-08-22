# Deploy FleetForAgent

The website is the hub. Multiple accounts on one Node process; SQL scopes every row by `user_id`. Machines only dial out.

```
New user → log in → mint a Hub token
Install Agent → paste this site's origin + token
tool / Cursor → FLEET_URL=this site  FLEET_TOKEN=same key
```

```
[Mac / Windows / Linux Agent]
        outbound only  WSS /v1/device
            │
            ▼
   this site  (TanStack Start · /v1/*)
            ▲
            │  HTTPS + Bearer flt_…
   [fleet-tool / Cursor]
```

Installers live on GitHub Releases, not in git:

https://github.com/TITOCHAN2023/fleetForAgent/releases/latest

---

## 0. New user (default path)

1. Open the site, sign in.
2. Settings → generate a Hub token (plaintext shown once; reset invalidates the old key immediately).
3. Install Agent on each computer. Hub address is **this site's origin** (for example `http://127.0.0.1:8080`), then paste the token.
4. Operator:

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node packages/fleet-tool/index.mjs list
```

A/B below are optional separate hub implementations. New users do not fill those URLs.

## 1. Optional: separate hub (Worker or a Node process)

Same protocol. Use only when you deliberately split the hub from the website.

### A. Cloudflare Worker

Needs: Cloudflare account, Node 18+.

```bash
git clone https://github.com/TITOCHAN2023/fleetForAgent.git
cd fleetForAgent/packages/fleet-worker
npm install
npx wrangler login
npx wrangler deploy
```

Success prints something like:

```
https://fleet-hub.<your-account>.workers.dev
```

That is the **hub URL** the Agent should use. You can also bind a custom domain (Cloudflare Dashboard → Workers → Triggers → Custom Domain).

### Token (recommended in production)

```bash
npx wrangler secret put HUB_TOKEN
```

After that, device connections and control-plane calls must send:

```
Authorization: Bearer <HUB_TOKEN>
```

The local Agent settings page has a Hub token field. With no secret the Worker is open — only for bringing it up yourself.

Local debug:

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev --port 8787
```

Agent: `http://127.0.0.1:8787` (turned into `ws://…/v1/device`).

### B. Plain deploy (VPS / local Node)

No Cloudflare. One Node 18+ machine:

```bash
cd packages/fleet-hub
npm install
HUB_TOKEN=change-me PORT=8787 HOST=0.0.0.0 npm start
```

Local Agent: `http://127.0.0.1:8787`. On the public internet put Caddy / nginx in front for HTTPS; Agent uses `hub.example.com`.

Control-plane paths match the Worker: `/v1/health`, `/v1/list_computers`, `/v1/run`, `/v1/get_result`, `/v1/read_screen`, `/v1/type`. Devices still use `WSS /v1/device`.

Empty `HUB_TOKEN` is open — only for bring-up. Production must set it.

systemd example:

```
[Service]
WorkingDirectory=/opt/fleet/packages/fleet-hub
Environment=PORT=8787
Environment=HUB_TOKEN=change-me
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
| Linux | `fleet-agent-linux-amd64.tar.gz` |

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
   - **Off**: run nothing
   - **Ask**: someone at the machine must approve
   - **Allow**: run (dangerous commands are still blocked)

The device only dials out. **No inbound ports, public IP, or VPN on the device side.** The Node machine in a plain deploy must of course be reachable (80/443 or the port you chose).

Rebuild installers yourself:

```bash
npm run release:agent
gh release create v0.x.0 public/dl/FleetAgent-* public/dl/fleet-agent-linux-amd64.tar.gz
```

---

## 3. List machines, pick one, run

Worker and Node hubs share the same paths. Replace `$HUB` with `https://fleet-hub.<account>.workers.dev` or `https://hub.example.com`.

Health:

```bash
curl $HUB/v1/health
```

List devices (no IPs):

```bash
curl -X POST $HUB/v1/list_computers \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

Run a command:

```bash
curl -X POST $HUB/v1/run \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","command":"uname -a"}'
```

Returns `{ "corr": "...", "status": "running" }`. Then fetch the result:

```bash
curl -X POST $HUB/v1/get_result \
  -H "authorization: Bearer $HUB_TOKEN" \
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
curl -X POST $HUB/v1/run -H "authorization: Bearer $HUB_TOKEN" \
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
- The three local permission levels run on the device; the hub cannot change them.
- Dangerous commands (`rm -rf`, `format`, shutdown, …) are refused by the Agent.
- Production must set `HUB_TOKEN` (Worker: `wrangler secret put HUB_TOKEN`; Node: env).
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

**Tray says connected, list says offline**  
The hub advertised `heartbeat_s` but older agents never sent a heartbeat, so a half-open socket (common on Windows after sleep or NAT idle) stayed “online” on the machine and “offline” on the hub. Current agents ping the hub every 25s; a failed ping reconnects. Restart the Agent once to pick that up.

**Change the domain**  
Worker: bind a Custom Domain, then every Agent reconnects to the new name. Plain deploy: change the reverse-proxy name; Agents do the same.
