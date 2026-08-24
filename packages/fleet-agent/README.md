# Fleet Agent

Go process that sits on each machine. Composition root is `package main`. Domain code lives in `internal/` so a contributor can open one folder instead of a flat dump of 50 files.

```
packages/fleet-agent/
  main.go            Agent, hub WebSocket, settings HTTP, CLI glue
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

Build and test from this directory:

```bash
go test ./...
go build .
```
