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

Agent 0.6.2 advertises `rtc_v1`. WSS and RTC both feed the same `dispatchEnvelope`; handlers reply through `EnvelopeSink`, so changing transport cannot bypass the local permit decision, desktop consent, panes, or device policy. A direct session is accepted only after the hub-signed ticket binds both DTLS fingerprints to the current token kid, device, and operator; the Tool waits for the Agent's post-verification `rtc_ready` before sending business data. Signaling has a short-lived context, while established commands use a session context tied to WSS authentication and revocation. New peers negotiate terminal-result ACKs: an unacknowledged `result`, `plugin_result`, or `desktop` reply is replayed once through the authenticated WSS control path and the unhealthy DataChannel is closed. Old peers do not negotiate this extension and keep their existing behavior. Token revocation or any WSS loss closes every DataChannel before reconnect logic runs.

All plugin installation, removal, task execution, and peer sessions follow that same Agent permit: `off` refuses, `ask` queues a local approval, and `allow` authorizes automatically without a second plugin click. `approval_actions` is retained only as schema-v1 compatibility metadata. Permit never relaxes official-source, platform, action/runtime, artifact and executable SHA-256, ticket/nonce, or applicable dangerous-operation checks. Peer `both_once` means each endpoint makes one local authorization decision for the session; it does not require a human click under `allow` or another decision for each resumed round.

A durable peer cancellation is acknowledged only after the current FLPP process accepts this invocation's `cancel`, emits a valid v1 `status=canceled`, and exits cleanly with code 0. Timeout, forced termination, signal/non-zero exit, or a missing/invalid status is not a cancellation receipt. WSS loss uses Abort and retains a bounded recovery owner; a later Hub cancellation, permit-off, auth revocation, or token reset reopens the immutable plugin session, sends `open` then `cancel`, and clears the owner only after the same receipt. Replayed prepare atomically inherits that cleanup debt before it is acknowledged.

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
