# Linux two-pod intranet lab (1C1G)

macOS `scripts/plugin-peer-vm/` needs Colima arm64 and sibling plugin repos.
This lab is the Linux stand-in: **two Agent containers + one Hub container**
on a private Docker bridge. Each container is hard-capped at **1 CPU and 1 GiB**
(`--cpus=1 --memory=1g --memory-swap=1g`).

```text
Tool (host python) --HTTP--> Hub container
Agent pod-a --WSS--> Hub     Agent pod-b --WSS--> Hub
```

```bash
./scripts/intranet-lab/run.sh
# or
npm run test:intranet
```

Needs `sudo docker` (or `FLEET_LAB_DOCKER='docker'` if you are in group `docker`),
Go, and Python 3. Pulls `alpine:3.20` and `node:20-alpine` once.

The probe lists both online agents and runs `printf %s "$HOSTNAME"` on each.
The hostnames must be `pod-a` and `pod-b`. That is the intranet proof: two
isolated machines, not one process with two names.

This does **not** replace plugin-peer-vm for file-transfer / RTC interruption.
It is the cheap Linux gate for Agent + Hub + run.

## Real Worker and persistent sessions

`worker-lab.mjs` runs the actual Worker and Durable Objects (using the existing test-only seed wrapper), two Linux Agents, and the real Tool RTC manager. All four containers are capped at 1 CPU / 1 GiB. It checks cookie-origin rejection with a real session, direct WebRTC with no WSS fallback accepted, and tmux/Herdr create → type → screen → detach → reattach → preserved shell state → close on both Agents.

Build the current Agent and obtain the Herdr 0.9.0 Linux binary separately. The runner only mounts these binaries; it does not install software on the host. Use Node 22+ and install locked root and Worker npm dependencies first. Docker access is through `sudo -n docker`; image-build proxies are inherited when present.

```bash
(cd packages/fleet-agent && CGO_ENABLED=0 go build -buildvcs=false -o /tmp/fleet-agent .)
FLEET_LAB_AGENT=/tmp/fleet-agent FLEET_LAB_HERDR=/path/to/herdr \
  node scripts/intranet-lab/worker-lab.mjs
```

The seed endpoint and browser cookie are confined to the local test wrapper. Evidence and throwaway credentials are written into a private temporary directory; runtime containers and the network are removed on completion. This complements the smaller Node Hub `run.sh` lab and does not test file-transfer or plugin peer recovery.
