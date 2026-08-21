# fleet-tool

Operator client. Config is the website origin plus the hub token from Settings.

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs list
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs run <device_id> 'uname -a'
```

Cursor / MCP: run `node index.mjs` with those two env vars, no extra args.

## MCP tools

Existing tools stay. `device_id` is still on every mutating/read schema; it is optional at call time.

| Tool | Notes |
|---|---|
| `list_computers` | Account fleet. Never returns IPs. |
| `run` | `command` required. Optional `device_id`, optional `wait_ms`. **Default (no `wait_ms`) is still immediate `{corr,status:"running"}`** — `POST /v1/run` is not held. |
| `get_result` | Non-blocking peek by `corr`. |
| `wait` | `{corr, device_id?, timeout_ms?}`. Blocks server-side (default 30s, clamped 1s–5min) by polling `get_result`. Does not kill the job. |
| `read_screen` / `type` | Same optional `device_id` fill. |
| `set_computer` | Remember a device for later calls **in this MCP process only**. |
| `get_current_computer` | Show last-used and the `FLEET_DEVICE_ID` start default. |

If `wait_ms` / `timeout_ms` elapses, the tool returns `{corr,status:"running"}` plus any snapshot already on `get_result`. Use `wait` instead of looping `get_result`.

## Last-used (this process)

- Explicit `device_id` always wins and updates in-memory last-used.
- `set_computer` is the explicit setter (XcodeBuildMCP `session_set_defaults` / ssh-session-set-active).
- If `device_id` is omitted, fill from last-used, then `FLEET_DEVICE_ID` (start-of-process default only — never written back).
- No remembered device → error asking for `device_id` or `set_computer`. No auto-pick of the only/first online machine.
- Remembered device offline → the hub error is returned as-is. No fallback to another box.
- Last-used is **not** written to `hub_sessions`, disk, or `~/.fleet`. The web console may keep using `hub_sessions`; MCP does not.
- Targeted responses echo the resolved `device_id`.
- `corr` is bound to the device that started the job. `get_result` / `wait` / `read_screen` refuse a different `device_id`.
