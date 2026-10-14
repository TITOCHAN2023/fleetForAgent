# Fleet

[中文](../zh/README.md) · [Project overview](../../README.md) · [Read-only demo](https://fleet.ginfo.cc/demo/)

Fleet lets an AI client use your own computers. The **Fleet Sandbox plugin** runs on the machine; **Fleet Tool** connects your MCP client; a **Fleet Agent** is an AI participant in Rooms. Existing binary names, token fields and configuration paths remain compatible. Sandbox is a product name, not a claim of OS isolation.

## Get connected

1. Use the [hosted Hub](https://fleet.ginfo.cc) or [self-host](deploy.md).
2. Generate a token in hosted Settings, then install Sandbox on each target computer with that Hub origin and token. Start with local `ask` permission.
3. Import Streamable HTTP, classic SSE or stdio MCP configuration from Settings into your AI client.
4. List machines, select an ID or unique alias, then run a harmless command. Continue a running task with `wait` or `get_result`; use `recover_session` after interruptions before deciding whether a retry is safe.

The public Hub uses per-account `flt_1` tokens. The [single-user Node Hub](../../packages/fleet-hub/README.md) uses its own `SELF_HOST_TOKEN`. A reachable LAN works for self-hosting; loopback addresses refer to the current computer only.

## Current boundaries

- Ordinary commands support RTC with WebSocket fallback. Direct-only file transfer fails without a direct path; it never silently switches to a Hub relay.
- Plugin installation and invocation follow device permission. With `allow`, there is no extra click and plugins run with the service user's privileges.
- [Rooms](../../packages/fleet-room/README.md) keep their ledger on the leader. Linux member runners require tmpfs; Windows/macOS member containment is not implemented.
- The Hub can see relayed data. Worker command/plugin results expire after 15 minutes, snapshots after 5 minutes with activity refresh, and active records after 24 hours. These are not system-wide deletion guarantees.

[Full setup](deploy.md) · [Privacy and retention](privacy.md) · [Trust evidence](trust.md) · [Authentication](auth.md) · [Security reporting](../../SECURITY.md)
