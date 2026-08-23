# fleet-tool

Operator client. Config is the website origin plus the hub token from Settings.

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs list
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs run <device_id> 'uname -a'
node index.mjs --dev list
```

Cursor / MCP: run `node index.mjs` with those two env vars, no extra args. `--dev` sets `FLEET_DEV=1` (same as the env) and still starts MCP if there are no other args.

`~/.fleet/mcp.env` is already loaded (does not override env vars that are already set):

```
FLEET_URL=https://your.app
FLEET_TOKEN=flt_...
FLEET_DEV=1
```

### Cursor `mcp.json`

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["/path/to/packages/fleet-tool/index.mjs"],
      "env": {
        "FLEET_URL": "https://your.app",
        "FLEET_TOKEN": "flt_...",
        "FLEET_DEV": "1"
      }
    }
  }
}
```

### Claude Desktop `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["/path/to/packages/fleet-tool/index.mjs"],
      "env": {
        "FLEET_URL": "https://your.app",
        "FLEET_TOKEN": "flt_...",
        "FLEET_DEV": "1"
      }
    }
  }
}
```

## MCP tools

Existing tools stay. `device_id` is still on every mutating/read schema; it is optional at call time.

| Tool | Notes |
|---|---|
| `list_computers` | Account fleet. Never returns IPs. |
| `run` | `command` required. Optional `device_id`, optional `wait_ms` (**default 30000**). Omitted `wait_ms` is passed through to `POST /v1/run`; if the hub returns a finished payload, `get_result` is skipped. Against an old hub that still replies immediately, the operator falls back to polling `get_result`. Explicit **`wait_ms: 0`** starts the job and returns immediately — one hop, hub is not held. |
| `get_result` | Snapshot of this MCP process's live session when `wait_ms` is omitted/0. Optional `wait_ms` long-polls until done or the budget expires. |
| `wait` | Explicit block: `{device_id?, wait_ms?}`. Default `wait_ms` is the 30s cap. Long-polls `get_result`. |
| `read_screen` / `type` | Same optional `device_id` fill. POSIX live PTY: `read_screen` is the current VT grid (not a raw byte dump; `__FLEET_PROMPT__` rows are stripped). After a corr finishes the grid is reset so the next command does not paint on leftover TUI chrome. `type` still takes `keys`; optional `key` is a named press (`enter`, `ctrl+c`). Enter is CR; a single `keys` write of `text\\r` flushes the text then CR (ssh_send). `ctrl+c` is 0x03 plus SIGINT to the fg process group. |
| `set_computer` | Remember a device for later calls **in this MCP process only**. |
| `get_current_computer` | Show last-used, last `cwd`, and the `FLEET_DEVICE_ID` start default. |

MCP **prompts**: `hub_token` (generate / reset in Settings) and `hub_token_anatomy` (`flt_1.<payload>.<sig>`, RSA-2048, Fleet-OAEP not Bearer). The initialize payload includes short `instructions`. `run` / `wait` emit `notifications/progress` and honor `notifications/cancelled` (cancel stops waiting; it does not kill the remote command).

`wait_ms` is an MCP-call budget only, max **30s** (hosts cancel tools at ~60s). It never kills the remote command. `run` omitted defaults to **30s**; `get_result` omitted/0 is an instant snapshot; `wait` omitted defaults to **30s**. Explicit `run` `wait_ms: 0` is the fire-and-forget path. Hub `POST /v1/run` and `POST /v1/get_result` treat omitted/`0` `wait_ms` as immediate (web console and old clients unchanged). A still-running reply is not an error — do not re-issue `run`; poll `get_result(wait_ms=...)` or `wait(wait_ms=...)`.

MCP text for a finished `run` / `get_result` / `wait` is the command output (Desktop Commander style), not a JSON envelope. A still-running job is the plain line `still running` — never a `corr=`, fingerprint, or operator id. `FLEET_DEV=1` (also `true`/`yes`) keeps that text first, then appends a `# fleet-dev` trailer with per-hop `out`/`in`/`send`/`wait`/`recv`/`total` (epoch-ms wall times plus durations). The tool result includes a `dev` object; MCP `_meta.duration_ms` is the overall total and `_meta.fleet_dev` is the full `dev` object. Default is off.

Each fleet-tool stdio process generates one `X-Fleet-Operator` fingerprint with `crypto.randomUUID()` at start and sends it on every hub HTTP call. It is not a tool argument and is not read from `FLEET_OPERATOR`. The hub keys long sessions per device per fingerprint. Clients that omit the header share one anonymous fingerprint (current 0.2.7 agents and old fleet-tool keep working, without isolation from each other).

## Last-used (this process)

- Explicit `device_id` always wins and updates in-memory last-used.
- `set_computer` is the explicit setter (XcodeBuildMCP `session_set_defaults` / ssh-session-set-active).
- If `device_id` is omitted, fill from last-used, then `FLEET_DEVICE_ID` (start-of-process default only — never written back).
- No remembered device → error asking for `device_id` or `set_computer`. No auto-pick of the only/first online machine.
- Remembered device offline → the hub error is returned as-is. No fallback to another box.
- Last-used is **not** written to `hub_sessions`, disk, or `~/.fleet`. The web console may keep using `hub_sessions`; MCP does not.
- Targeted responses echo the resolved `device_id`.
- Long sessions are bound to this MCP process's fingerprint, not to a model-visible ticket. `get_result` / `wait` / `type` / `read_screen` drive the live session this process started.
- The agent (0.2.8+) keeps one live POSIX **interactive login** shell (`-il`) on a PTY (`creack/pty`) **per fingerprint**. stdin/stdout/stderr are the same pts (one screen). `TERM=xterm-256color`; launcher `NO_COLOR` / `FORCE_COLOR` are not passed through. Echo is disabled from the **PTY master**, not via slave `stty`. Every PTY byte is fed to a `hinshun/vt10x` screen the size of the PTY (40×120). `read_screen` returns that current grid (rows joined by newline, trailing spaces trimmed) plus cursor row/col — not the raw CSI history. The emulator answers DA and DSR-CPR on the PTY master. `run` writes only the user command; completion is `PS1='__FLEET_PROMPT__$?\n'`. MCP `error` stays empty for command output (command stderr is on the PTY with stdout). After `exit`, the process group is reaped and the next `run` starts a fresh login shell in `$HOME`. Windows stays one-shot `cmd /C` with split stdout/stderr. `wrapSessionCommand` remains a unit-tested helper only.
