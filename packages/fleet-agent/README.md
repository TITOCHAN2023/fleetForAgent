# Fleet Agent

Go process that sits on each machine. Composition root is `package main`. Domain code lives in `internal/` so a contributor can open one folder instead of a flat dump of 50 files.

```
packages/fleet-agent/
  main.go            Agent, hub WebSocket, settings HTTP, CLI glue
  rtc.go             optional Pion DataChannel; WSS remains control/fallback
  desktop.go         desktop permit / consent / rate-limit (calls internal/desktop)
  tray_adapt.go      *Agent implements tray.Controller
  autoupdate.go, update*.go, restart.go, heartbeat.go, tokenv1.go, cli.go, …
  internal/
    desktop/         capture, HID, pointer motion, JPEG viewport
    pane/            PTY / oneshot shells, vt screen, type keys
    tray/            systray menu; takes a Controller, not Agent
    keepalive/       idle-sleep assertion (caffeinate / inhibit / ES_SYSTEM_REQUIRED)
    policy/          always-blocked destructive commands
```

`internal/` cannot be imported from outside this module. That is the point: these are agent internals, not a public SDK.

Where to change what:

| You want to… | Open |
|---|---|
| Hub protocol, permit, settings page | `main.go` |
| Screenshot / mouse / keyboard OS bits | `internal/desktop/` |
| Shell panes and live PTY | `internal/pane/` |
| Menu-bar / tray UI | `internal/tray/` |
| Keep the machine awake while enabled | `internal/keepalive/` |
| `rm -rf /` and friends | `internal/policy/` |

Agent 0.5.0 advertises `rtc_v1`. WSS and RTC both feed the same `dispatchEnvelope`; handlers reply through `EnvelopeSink`, so changing transport cannot bypass plugin approval, desktop consent, panes, or device policy. A direct session is accepted only after the hub-signed ticket binds both DTLS fingerprints to the current token kid, device, and operator; the Tool waits for the Agent's post-verification `rtc_ready` before sending business data. Token revocation or any WSS loss closes every DataChannel before reconnect logic runs.

Build and test from this directory:

```bash
go test ./...
go build .
```

Tests that dispatch an Envelope into a real shell must run in the disposable container from the repository root:

```bash
npm run test:agent:sandbox
```

The source tree is mounted read-only and the container has a read-only root filesystem, no Linux capabilities, and no access to the host Docker socket. Destructive command strings belong only in pure `internal/policy` parser tests; transport tests inject a harmless test-only block rule.
