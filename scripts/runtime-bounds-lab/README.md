# Bounded runtime Linux lab

Prerequisites: Node 22+, Go, installed locked root npm dependencies (for `ws`), Docker,
`node:22-bookworm-slim` and `golang:1.23-bookworm` images. Override the Node image with
`FLEET_LAB_NODE_IMAGE`. Docker uses an explicit caller `DOCKER_HOST`/`DOCKER_CONTEXT`,
or the existing default Colima socket on macOS; it never changes your context.

```sh
node scripts/runtime-bounds-lab/linux-tests.mjs
node scripts/runtime-bounds-lab/run.mjs
node scripts/runtime-bounds-lab/run.mjs # independent repeat with fresh state
```

`run.mjs` cross-builds a fresh Linux Agent and copies a source snapshot into ignored
`.artifacts/`. It starts a real Node Hub and two distinct Linux Agent containers on an
**internal-only network**, with no published ports. Each container has 1 CPU, 1 GiB RAM,
a PID limit, no-new-privileges, read-only source/artifact mounts, and temporary agent state.
It uses a freshly generated test-only token. No user home, production credentials or
Docker socket is mounted inside containers. Containers/network are removed in `finally`;
logs, source snapshots and JSON measurements remain under `.artifacts/` for inspection.

Checks: 24 concurrent multi-operator jobs on one/two endpoints; foreign ticket result and
screen isolation; duplicate delivery during and after a running command; 48 × 16 MiB
no-newline tasks; 264 warmup tasks per endpoint to fill completed-pane retention; then
three rounds producing 256 MiB each. At each sample both endpoints must remain online,
no container may be OOM-killed, each process RSS must stay under 384 MiB, and the three
post-warmup RSS samples must span less than 64 MiB. These are conservative integration
regression thresholds, not a mathematical bound on every workload or long-term leak proof.
Finally, an evicted task is resubmitted and its filesystem side effect must still exist
exactly once. Receipt safety and retained output are deliberately tested separately.

`linux-tests.mjs` uses an internal-only network (an interface is needed for local RTC), read-only source/vendor snapshot and executable
temporary build filesystem. It runs all Go tests including `FLEET_OPERATION_LAB=1`, then
three `-race` rounds of pane and operation/admission tests. Vendoring/build preparation
may populate the host Go cache, but no tested shell command executes on the host.

On Colima these are two isolated endpoints inside **one Linux VM**, not two independent
VMs. The lab exercises the Node Hub WS path, not production Cloudflare, real WAN RTC,
automatic updates, or an externally downloaded sandbox plugin. Those require separate
gates. Do not interpret a passing local lab as production deployment verification.

## Local Cloudflare runtime checks

`worker.mjs` runs the production Worker bundle in local Miniflare/workerd with real
SQLite Durable Objects, loopback-only listeners and fresh temporary storage. It needs
Node 22+ and the locked Worker dependencies in addition to the root dependencies.
Run from the repository root; build the bundle first rather than assuming a previous
`/tmp` artifact exists:

```sh
npm ci --prefix packages/fleet-worker --no-audit --no-fund
fleet_worker_bundle="$(mktemp -d "${TMPDIR:-/tmp}/fleet-bounds-worker-bundle.XXXXXX")"
WRANGLER_SEND_METRICS=false packages/fleet-worker/node_modules/.bin/wrangler deploy \
  --dry-run --config packages/fleet-worker/wrangler.toml --outdir "$fleet_worker_bundle"
WRANGLER_SEND_METRICS=false node scripts/runtime-bounds-lab/worker.mjs "$fleet_worker_bundle/worker.js"
WRANGLER_SEND_METRICS=false node scripts/runtime-bounds-lab/worker.mjs "$fleet_worker_bundle/worker.js"
# Complementary Room/authentication integration against the same bundle:
WRANGLER_SEND_METRICS=false node scripts/room-lab/worker.mjs "$fleet_worker_bundle/worker.js"
```

The Wrangler command is **dry-run only**: no deployment, login, production credentials
or database migration is needed. Do not replace it with `npm run build`, which includes
the application's database migration step. Each test invocation disposes its local
runtime and removes its own temporary state; the bundle directory remains available
for inspection. The runtime creates only local test accounts and tokens. The device
WebSocket peer is a protocol fixture: it does not execute a machine command.

Assertions cover 16 concurrent waiters receiving one persisted task result, exactly
one `run` envelope, rejection of a foreign operator's result lookup, real FleetDO alias
transactions (Unicode, case-insensitive collision, rename and account isolation), and
real McpDO SSE `initialize`/`ping` responses across requests. A separate workerd component
loads the production `McpSseSession` implementation and checks the 8 MiB queue budget:
an unread stream closes and clears its timer, while an actively consumed stream delivers
more than 16 MiB without disconnecting. The companion Room lab checks account isolation,
cookie-authorized writes, OAEP WebSockets, leader-local messages and live token revocation.

The SSE byte-budget check is **inside workerd**, not an end-to-end slow TCP consumer test.
Neither harness proves waiter recovery after Durable Object hibernation/eviction,
production Cloudflare routing or real machine execution. Keep those separate from the
local runtime and Linux-container evidence above.
