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
