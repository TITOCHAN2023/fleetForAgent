# Fleet agent conventions

## Tests are not `go test` / `npm test`

Unit tests (`npm test`, `go test ./...` in `packages/fleet-agent`) prove parsers and local PTY helpers. They do **not** prove Fleet works.

Fleet is two (or more) machines on a private network plus a hub. Any change that touches Agent, Hub, Tool, live shell / session backend, RTC, plugins, or peer transfer is unverified until it has run in a **two-endpoint intranet lab**:

```text
Tool ──HTTPS──► local Hub (Wrangler)
Agent A ──WSS──► Hub     Agent B ──WSS──► Hub
Tool ◄──direct WebRTC DATA──► Agent A / Agent B
Agent A ◄──direct WebRTC DATA──► Agent B
```

Linux (this host): `scripts/intranet-lab/` — two Agent containers + Hub, **each capped at 1 CPU / 1 GiB**.

```bash
npm run test:intranet
# ./scripts/intranet-lab/run.sh
```

macOS / plugin + RTC interruption: `scripts/plugin-peer-vm/` (`npm run test:intranet:peer`). That lab is heavier (Colima arm64, sibling plugin repos) and is not the default here.

Read `scripts/plugin-peer-vm/README.md` before inventing a new harness. Do not claim a green unit suite means live-shell reattach, peer sessions, or file transfer work across hosts.

`npm run test:agent:sandbox` is a disposable **single** container for Agent envelope→shell tests. It is not an intranet lab and does not replace two pods.
