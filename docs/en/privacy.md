# Privacy and retention

This describes the repository's Cloudflare Worker behavior. A self-hosted operator may change settings, code, infrastructure logging or backups. It is not a claim of independently audited production configuration.

## What the Hub sees

The Hub authenticates accounts, tracks device identity and presence, and can see relayed command input/output, plugin payloads and Room messages. HTTPS/WSS protects transport, not content from the Hub itself. Direct-only file transfer keeps file bytes between endpoints; signaling and status still pass through the Hub.

## Worker storage

| Data | Application policy |
|---|---|
| Completed command and plugin results | 15-minute expiry |
| Terminal snapshots | 5-minute expiry, refreshed by activity |
| Active execution/session records | 24-hour expiry |
| Account, credential and device metadata | Separate persistent records; the short result TTL does not remove them |
| OAuth pending attempts | 10-minute expiry |
| Login sessions | 7-day idle and 30-day maximum lifetime |
| Room history and task ledger | Stored on the leader machine, not in Hub durable storage |

Expiry controls application access and scheduled cleanup. Alarm scheduling, legacy-record cleanup and storage-provider behavior mean this is not a promise of physical erasure at the exact expiry time. Resetting a token revokes access; it does not delete all account/device data or undo finished commands.

Device buffers, plugin files and Room leader SQLite records have their own lifetimes. AI adapters and model providers can retain their own data. Linux tmpfs for Room members does not constrain arbitrary adapter writes or OS swap. Do not claim system-wide zero retention.

## Before connecting

Start with `ask`. With `allow`, commands and plugins execute with the current service user's privileges without a second confirmation. The Fleet Sandbox name does not mean OS isolation. Prefer an unprivileged dedicated account or VM for sensitive or untrusted tasks.

Keep account tokens out of screenshots, issue reports and shell history. Store only trusted MCP/runner credentials. The website uses a login cookie and local theme/language preferences; the plaintext generated token is shown once, not recoverable from its stored hash.

Public Hub operational admins can inspect operational metadata and ban accounts, but have no special cross-account machine-control credential. The Hub operator still controls the deployed code and infrastructure.

For data handling questions, use the project's public issue tracker without including private data. For a security issue, follow [SECURITY.md](../../SECURITY.md).
