# fleet-tool

Operator client. Config is the website origin plus the hub token from Settings.

```bash
FLEET_URL=https://fleet.ginfo.cc
FLEET_TOKEN=flt_...
npx -y https://fleet.ginfo.cc/fleet-tool.tgz
```

Local checkout (same env names):

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs list
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs run <device_id> 'uname -a'
node index.mjs --dev list
node index.mjs send-file /absolute/local.bin <target_device_id> /absolute/target/directory
node index.mjs receive-file <source_device_id> /absolute/source.bin /absolute/local/directory
node index.mjs transfer-file <source_device_id> /absolute/source.bin <target_device_id> /absolute/target/directory
node index.mjs transfer-status <transfer_id>
node index.mjs transfer-cancel <transfer_id>
```

Cursor / MCP: run `npx -y https://fleet.ginfo.cc/fleet-tool.tgz` with those two env vars, no extra args. `--dev` sets `FLEET_DEV=1` (same as the env) and still starts MCP if there are no other args.

Version 0.6.3 can negotiate a direct WebRTC DataChannel with Agent 0.6.1 for long-lived MCP run, pane, desktop, and task plugin calls. Account-local device aliases resolve to the immutable device ID before RTC tickets or file-transfer bindings are created. One-shot CLI control commands deliberately use WSS: a short process cannot own a reusable DataChannel, and a later `result` process must be able to reach the same hub job. It keeps using HTTPS for authentication/signaling and the Agent keeps its WSS control connection. The Tool verifies the hub ticket and waits for the Agent's `rtc_ready` before sending the unchanged v1 Envelope. New peers negotiate an application ACK for terminal replies; if the DataChannel accepts a result write but the Tool never ACKs it, the Agent replays that result once through WSS. Old peers do not negotiate ACKs and remain compatible. A missing `rtc_v1` capability, setup failure, or synchronous request-send failure falls back to the old hub path. Device-backed MCP results expose the actual path as `_meta.fleet_transport` (`rtc` or `ws`); it is tracked per invocation and is not inserted into command text or the v1 Envelope. Heartbeat and keepalive remain on WSS. Remote `/mcp` and `/mcp/sse` run inside the Worker, remain on the hub path, and therefore report `ws`.

Task fallback is not yet complete: if the DataChannel accepts the request write but disconnects before the Agent confirms receipt, the Tool cannot safely decide whether to resend. Closing that gap requires an Agent receive ACK, one caller-generated `corr` shared by RTC/WSS, a Worker claim ACK before execution, and bounded Agent/Worker idempotency ledgers. The hardening must also narrow today's generic plugin fast path to `invoke` of task actions; list/install/uninstall will be forced onto WSS and peer actions never enter it. File transfer uses the separate peer runtime and is always direct-only; it never uses WSS as a byte fallback.

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
      "command": "npx",
      "args": ["-y", "https://fleet.ginfo.cc/fleet-tool.tgz"],
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
      "command": "npx",
      "args": ["-y", "https://fleet.ginfo.cc/fleet-tool.tgz"],
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
| `set_computer` | Resolve an account-local alias or ID, then remember the immutable device ID **in this MCP process only**. |
| `get_current_computer` | Show last-used, last `cwd`, and the `FLEET_DEVICE_ID` start default. |
| `list_official_plugins` / `list_plugins` | Read the fixed official catalog or ask the selected device for its installed inventory. |
| `install_plugin` / `uninstall_plugin` | Submit an asynchronous software-change ticket. The Tool accepts an official id, never a URL; the target Agent follows its device permit. |
| `invoke_plugin` / `get_plugin_task` | Invoke an installed plugin under the target Agent's device permit and poll the same `corr` until `done`. |
| `configure_acp` / `delegate_to_acp` | Bind an ACP v1 stdio command on the device, then delegate one prompt through the official `fleet.acp` bridge. |
| `start_file_transfer` | Start one file between Tool↔device or device↔device endpoints. Source takes an absolute file path; target takes an absolute directory. Existing files are never overwritten. Each device endpoint follows its Agent permit. |
| `get_file_transfer` / `cancel_file_transfer` | Read the generic session/round phase or cancel by `transfer_id`. Tool endpoints require the local stdio/CLI process; remote Worker MCP can coordinate device↔device only. |

Plugin authorization has one source of truth: the target Agent's device permit. `off` refuses plugin installation, removal, task execution, and peer sessions; `ask` queues one local prompt; `allow` authorizes automatically without a second plugin click. `approval_actions` remains schema-v1 compatibility metadata only. Official source, platform, action/runtime, artifact and executable SHA-256, and applicable dangerous-operation checks remain mandatory in every mode. For peer sessions, `both_once` means one local authorization decision per endpoint for the whole session, not one human click per round; the explicit initiating call is the local Tool endpoint's decision.

File transfer deliberately differs from bounded task and shell RTC optimization: it is **direct-only**. The generic `PeerSessionDO` authenticates both endpoints and carries bounded prepare/signaling/ticket/status metadata, but never carries file bytes. If ICE cannot establish the ordered `fleet-plugin-peer-v1` DataChannel, the session returns `direct_unavailable`; it never falls back to WSS, Durable Object, R2, TURN, or another relay. Every resumed round gets a fresh `round_id`, PeerConnection, Core nonce, and signed 60-second ticket; old-round deliveries are rejected. The generic runtime allows the initial round plus at most three resumed rounds within a 30-minute coordination window. Agent/Tool and the plugin communicate through bounded FLPP records (64 KiB CONTROL, 32 KiB DATA); the peer inbox is capped at 128 messages and 2 MiB. File manifest/chunk/hash/resume/no-clobber rules live entirely in `fleet.transfer v0.2.1`, not Fleet Core. Explicit cancellation is delivered to the plugin before its process tree is terminated; before publication it removes only matching resumable state, while an ordinary network interruption preserves that state. A completed transfer retains its private `published` receipt so the exact same transfer can retry idempotently; cancellation after publication does not remove the destination or receipt. If the user later removes or moves the completed destination, the plugin may reclaim only a structurally valid orphan receipt for that exact path, with inode-checked quarantine and fail-closed concurrent-path handling. Endpoint authorization happens before the private manifest exists. Under `ask`, the confirmation dialog therefore cannot claim to show size or full SHA-256; under `allow`, there is no confirmation dialog. See [the protocol and security contract](../../docs/FILE_TRANSFER.md).

For both Tool and Agent endpoints, `status=canceled` by itself is not a receipt. Core also requires that this invocation wrote `cancel` successfully, drained the plugin's stdout, cleaned its whole process tree, and that the plugin then exited on its own with code 0. A hanging plugin that is terminated by Core, one that exits by signal/non-zero status, or a failed tree cleanup leaves the durable Hub cancellation unacknowledged. On Windows, the packed Tool starts each plugin through its architecture-matched Job Object host. `STARTUPINFOEX` puts the suspended process into a `KILL_ON_JOB_CLOSE` Job at creation time, then resumes it; the host reports a clean exit only after `ActiveProcesses` reaches zero. There is no `taskkill`-by-PID fallback.

Official plugin metadata comes from one Markdown file per plugin in the public [`fleet-plugins`](https://github.com/TITOCHAN2023/fleet-plugins) registry. Fleet Tool and Hub ship the same commit-pinned snapshot; they do not resolve a mutable GitHub manifest during installation. The Agent accepts only Fleet Official GitHub Release artifacts, selects its own OS/architecture, caps the download, verifies the pinned SHA-256, and atomically replaces the old binary. The pinned versions in this baseline are `fleet.transfer v0.2.1` and `fleet.acp v0.1.2`. `fleet.acp` is an MIT client bridge; it does not bundle a model, API key, or third-party coding agent. Nested ACP permissions reject by default and can only opt into the protocol's one-shot `allow_once` option.

MCP **prompts**: `hub_token` (generate / reset in Settings) and `hub_token_anatomy` (`flt_1.<payload>.<sig>`, RSA-2048). Stdio uses Fleet-OAEP. Recommended remote clients use Streamable HTTP at `/mcp`; the initialize response carries an opaque `Mcp-Session-Id`. Classic SSE remains at `/mcp/sse`: Bearer is used only on the initial GET, then the server announces a random token-free message URL. The initialize payload includes short `instructions`. `run` / `wait` emit `notifications/progress` where the transport supports it and honor `notifications/cancelled` (cancel stops waiting; it does not kill the remote command).

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
- POSIX `run` starts a **non-interactive** `shell -c` child on its own PTY (`creack/pty`). The command string is argv, not keystrokes into a persistent login shell, and completion is the **process exit code** — not `PS1`. Each `run` is a new process, so a hung job cannot eat the next command. `TERM=xterm-256color`, `PAGER=cat`, `GIT_PAGER=cat`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`; launcher `NO_COLOR` / `FORCE_COLOR` are not passed through. Echo is disabled from the **PTY master**. Every PTY byte is fed to a per-pane `hinshun/vt10x` screen (40×120). `read_screen` / `type` attach to that command's PTY. MCP `error` stays empty for command output (command stderr is on the PTY with stdout). Windows stays one-shot `cmd /C` with split stdout/stderr. `wrapSessionCommand` remains a unit-tested helper only.
