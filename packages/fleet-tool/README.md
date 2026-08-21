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
| `run` | `command` required. Optional `device_id`, optional `wait_ms` (**default 0**). **Default is still immediate `{corr,status:"running"}`** — `POST /v1/run` is not held. |
| `get_result` | Snapshot by `corr` when `wait_ms` is omitted/0. Optional `wait_ms` long-polls until done or the budget expires. |
| `wait` | Explicit block: `{corr, device_id?, wait_ms?}`. Default `wait_ms` is the 30s cap. Long-polls `get_result`. |
| `read_screen` / `type` | Same optional `device_id` fill. POSIX live PTY: `read_screen` is the current VT grid (not a raw byte dump). `type` still takes `keys`; optional `key` is a named press (`enter`, `ctrl+c`). Enter is CR; a single `keys` write of `text\\r` flushes the text then CR (ssh_send). `ctrl+c` is 0x03 plus SIGINT to the fg process group. |
| `set_computer` | Remember a device for later calls **in this MCP process only**. |
| `get_current_computer` | Show last-used, last `cwd`, and the `FLEET_DEVICE_ID` start default. |

`wait_ms` is an MCP-call budget only: default **0**, max **30s** (hosts cancel tools at ~60s). It never kills the remote command. `status=running` is not an error — do not re-issue `run`; poll `get_result(wait_ms=...)` or `wait(wait_ms=...)`. Do not spam `wait_ms=0`.

## Last-used (this process)

- Explicit `device_id` always wins and updates in-memory last-used.
- `set_computer` is the explicit setter (XcodeBuildMCP `session_set_defaults` / ssh-session-set-active).
- If `device_id` is omitted, fill from last-used, then `FLEET_DEVICE_ID` (start-of-process default only — never written back).
- No remembered device → error asking for `device_id` or `set_computer`. No auto-pick of the only/first online machine.
- Remembered device offline → the hub error is returned as-is. No fallback to another box.
- Last-used is **not** written to `hub_sessions`, disk, or `~/.fleet`. The web console may keep using `hub_sessions`; MCP does not.
- Targeted responses echo the resolved `device_id`.
- `corr` is bound to the device that started the job. `get_result` / `wait` / `read_screen` refuse a different `device_id`.
- The agent (0.2.4+) keeps one live POSIX **interactive login** shell (`-il`) on a PTY (`creack/pty`). stdin/stdout/stderr are the same pts (one screen). `TERM=xterm-256color`; launcher `NO_COLOR` / `FORCE_COLOR` are not passed through. Echo is disabled from the **PTY master**, not via slave `stty`. Every PTY byte is fed to a `hinshun/vt10x` screen the size of the PTY (40×120). `read_screen` returns that current grid (rows joined by newline, trailing spaces trimmed) plus cursor row/col — not the raw CSI history. The emulator answers DA and DSR-CPR on the PTY master. `run` writes only the user command; completion is `PS1='__FLEET_PROMPT__$?\n'`. MCP `error` stays empty for command output (command stderr is on the PTY with stdout). After `exit`, the process group is reaped and the next `run` starts a fresh login shell in `$HOME`. Windows stays one-shot `cmd /C` with split stdout/stderr. `wrapSessionCommand` remains a unit-tested helper only.
