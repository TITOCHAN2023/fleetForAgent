# Security

Fleet can execute commands with the privileges of the OS user running the machine-side Sandbox service. The product name does not imply a container or VM boundary. Use a dedicated unprivileged account or disposable VM when running untrusted work.

## Reporting a vulnerability

Do not put tokens, private device identifiers, command output or a working exploit against the hosted Hub in a public issue.

Check the repository's [Security page](https://github.com/TITOCHAN2023/fleetForAgent/security). If GitHub offers **Report a vulnerability**, use that private reporting flow. This document does not assert that private reporting is currently enabled. If no private channel is available, open a minimal issue asking the maintainer to arrange one, without exploit details or secrets. There is no published response-time guarantee.

Include the affected commit/version, deployment type, prerequisites, expected and actual behavior, and a minimal reproduction against your own isolated Hub and disposable machines. Do not test other users' devices or load-test the public service.

## Trust boundaries

- Possession of an account token grants broad authority within that account, subject to device permission. Treat it like remote shell access.
- Token reset revokes existing credentials. It is not a transaction rollback for external effects already performed.
- `ask` requires local approval; `allow` permits commands and plugins without another click. Deny patterns cannot safely classify every shell program.
- The Hub sees relayed content. TLS and RTC do not provide an end-to-end confidentiality claim against all trusted components.
- Release SHA-256 checks detect changed bytes, not whether the publisher is trustworthy. Build provenance and self-reported `/source` metadata have distinct limits.
- Use supported current releases. Older binaries may remain wire-compatible without containing later security fixes. Read release notes before upgrading a busy machine.

[Privacy and retention](docs/en/privacy.md) · [中文说明](docs/zh/privacy.md) · [Trust evidence](docs/en/trust.md)
