# Notes from building Fleet

Help is [how to use it](https://fleet.ginfo.cc/help). This page is how it is actually built, and the mistakes we already paid for. Same text lives on **https://fleet.ginfo.cc/docs** (no login).

## 1. The hub is a mailbox

Jobs live **on the device**. The hub does not own a process, a PTY, or a byte stream. `POST /v1/run` returns `{ corr, status: "running" }` immediately. If the hub waits on `Wait()` / `CombinedOutput`, the design is already wrong.

## 2. Devices only dial out

Agents open `WSS /v1/device`. No inbound ports, no VPN, no public IP on `list_computers`. The operator talks HTTPS to the website; the website already holds the sockets.

## 3. Latest-wins pane, not a stream

A ring (~200 lines) sits on the machine. The wire sees snapshots (~4 Hz), drop intermediate frames. `ping` / `type` / `read_screen` must not wait for the job to finish.

## 4. Permit is on the machine

`off` / `ask` / `allow`. The hub cannot override. Destructive regex still blocks. `ask` means a human at that keyboard.

## 5. Hash the token. Reset is a kill switch

Store the hash. Plaintext is shown once. Reset invalidates immediately and kicks live sockets (`1008 token reset`). Production wrap is Fleet-OAEP, not a long-lived Bearer in logs. **Never** put `HUB_TOKEN` in wrangler `[vars]`.

## 6. Two different “cannot open” bugs on macOS

1. **Fake dmg** — a zip renamed to `.dmg`. Finder says the disk image is damaged. `PK\x03\x04` is zip, not UDIF. Use `hdiutil create -format UDZO`. Zip `.app` with `ditto`, not Python `zipfile` (it drops `+x`).
2. **Gatekeeper** — a real dmg that still will not run after a browser download. Unsigned. Right-click Open, or `xattr -cr`. This is not the fake-dmg bug. Do not tell people to rename the zip.

## 7. Tray owns the process. CLI is a client

Same binary. No args / `--daemon` starts the tray. `fleet status` talks to `127.0.0.1:17890`. Do not edit `~/.fleet-agent/config.json` while it runs. That is the Tailscale pattern: one state.

## 8. Linux has no settings page

`FLEET_URL` + `FLEET_TOKEN`. Tray or CLI. Headless = background. GNOME needs an AppIndicator extension or the icon never appears.

## 9. Lock screen is not sleep

While Enabled, hold idle-sleep: `caffeinate -i` (Mac), `SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)` (Windows), `systemd-inhibit --what=idle:sleep` (Linux). The display may lock. Lid-close is **not** blocked.

## 10. Compile against the SDK you have

macOS 15 headers mark `CGDisplayCreateImage` unavailable. The dylib still exports it — `dlsym`. Darwin tray needs `CGO_ENABLED=1`. Windows tray is syscall, Linux tray is DBus StatusNotifierItem; both cross-compile with CGO off.

## 11. Ship every OS/arch or auto-update is a lie

`/releases/latest/download` must have Windows/macOS/Linux amd64+arm64 plus `checksums.txt`. v0.3.0 shipped without macOS; agents on Mac had nothing to pull. Build dmg **on a Mac** with `hdiutil`.

## 12. Login is Google / X

Email/password was a detour. The Grok OAuth broker is sandbox-only (`*.grok-sandbox.com`). Production callbacks are native Google/X on this origin.

Source: [GitHub](https://github.com/TITOCHAN2023/fleetForAgent)
