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

The existing lab is `scripts/plugin-peer-vm/`:

- two Agent containers (`agent-a`, `agent-b`) on a dedicated Docker bridge
- one Tool container
- local Wrangler Worker as Hub (throwaway account, no production)
- no TURN / Worker-byte / R2 fallback — if direct RTC fails, the run fails

```bash
./scripts/plugin-peer-vm/run.sh
# or
npm run test:intranet
```

Read `scripts/plugin-peer-vm/README.md` before inventing a new harness. Do not claim a green unit suite means live-shell reattach, peer sessions, or file transfer work across hosts.

`npm run test:agent:sandbox` is a disposable **single** container for Agent envelope→shell tests. It is not an intranet lab and does not replace two pods.
