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
| `read_screen` / `type` | Same optional `device_id` fill. |
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
- The agent (0.2.4+) keeps one live POSIX **interactive login** shell (`-il`) on a PTY (`creack/pty`, like ssh-mcp-sessions `conn.shell`) started in `$HOME`, using the account login shell (passwd / `dscl` on darwin), not inherited `$SHELL`. `FLEET_SHELL` overrides the binary. `TERM=xterm-256color` so `tty` / Codex doctor see a real terminal. `stty -echo` plus `PS1='__FLEET_PROMPT__$?\n'` — `run` writes only the user command; completion is the prompt (stripped, never returned). Nothing is injected into a program's stdin. After `exit`, the next `run` starts a fresh login shell in home. `cd` / `export` / aliases survive across `run`s. Windows stays one-shot `cmd /C`. fleet-tool does **not** wrap commands with `__FLEET_META__` (that fought the live shell). `wrapSessionCommand` remains as a unit-tested helper only.
