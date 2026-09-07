# Source equals deploy

The usual doubt: GitHub is one tree and [https://fleet.ginfo.cc](https://fleet.ginfo.cc) is another. Check it; do not take a screenshot of the repo as proof.

Site article (also on `/docs`): [Why the hosted hub is this GitHub tree](https://fleet.ginfo.cc/docs/same-source-as-github).

## Live identity

Unauthenticated, `Cache-Control: no-store`:

```bash
curl -sS https://fleet.ginfo.cc/source
```

Human page (no JavaScript): [https://fleet.ginfo.cc/trust](https://fleet.ginfo.cc/trust)

`verified` is true only when `SOURCE_COMMIT` is a 40-hex git object name. The Worker also advertises this object under `/v1/health` as `source`.

| Field | Meaning |
|---|---|
| `source_repo` | Public remote. Default `https://github.com/TITOCHAN2023/fleetForAgent` |
| `source_commit` | SHA baked at deploy (`$GITHUB_SHA`) |
| `source_workflow_run` | The Actions run that published this Worker |
| `source_bundle_sha256` | SHA-256 of the Wrangler dry-run script from that same job |
| `source_tag` | Release tag when the deploy was a tag |

## How production is published

`.github/workflows/deploy-hub.yml` is the only intended publisher of `fleet.ginfo.cc`. That job:

1. Checks out the commit it will advertise.
2. `wrangler deploy --dry-run` and SHA-256s the script.
3. Attests that bundle with GitHub OIDC.
4. `wrangler deploy --var SOURCE_COMMIT:$GITHUB_SHA` (and repo / run URL / bundle hash).
5. Does **not** keep dashboard vars (`--keep-vars` is off). A laptop `npx wrangler deploy` without those `--var` flags drops `SOURCE_COMMIT`, so `/source.verified` becomes false.

`CLOUDFLARE_API_TOKEN` belongs in GitHub Actions secrets, not on a laptop.

## What this does not prove

Cloudflare does not let a stranger download the live Worker isolate and hash it. A Cloudflare token holder can still publish a different Worker while advertising a public SHA. The counter is process, not a bytecode proof: token only in Actions, advertised SHA from `$GITHUB_SHA`, public workflow URL, `verified=false` after a laptop deploy.

## Agent installers are stronger

Release binaries embed `vcs.revision` (`go build -buildvcs=true`) and refuse a dirty tree. Checksums and GitHub attestations ship on the release:

```bash
curl -fsSL https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download/checksums.txt
gh attestation verify --repo TITOCHAN2023/fleetForAgent FleetAgent-macos-arm64.dmg
go version -m ./fleet-agent | grep vcs.revision
```

## Self-host

Your own Worker: run the same workflow against your account, or pass `--var SOURCE_COMMIT:$(git rev-parse HEAD)` yourself.

Node hub:

```bash
SOURCE_COMMIT=$(git rev-parse HEAD) \
SOURCE_REPO=https://github.com/TITOCHAN2023/fleetForAgent \
SELF_HOST_TOKEN=change-me PORT=8787 node packages/fleet-hub/index.mjs
```

`GET /source` and `GET /trust` stay public even when `SELF_HOST_TOKEN` is set.
