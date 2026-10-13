# Linux two-VM isolation and stability validation

Date: 2026-10-13. Branch: `codex/linux-sandbox-isolation`, based on
`a999aee14ecc467cd75139239f9a2194a99504f3`. The original working tree is
untouched. This is a review-only change stacked on PR #22; merging, releasing
and deploying remain separate actions. Private lab disks and redacted evidence
are retained, not committed.

## Environment

Two actual Debian 12 arm64 Lima VZ guests, each with 2 CPUs, 3 GiB RAM and a
12 GiB disk. VM A hosts the local Worker/DO Hub, STUN, Agent, Room leader and
one runner. VM B hosts the second Agent and runner. There are no host directory
mounts, SSH-agent forwarding or production credentials. Guest firewalls deny
Internet and host-gateway access after provisioning. Agents and tasks run as an
unprivileged user, with automatic updates disabled. Fault and destructive-policy
regressions run inside the guests, never on personal machines.

The Agent is an unpublished local build; its version field remains `0.6.6`,
not a downloaded release or automatic update. Retention build SHA-256:
`16804a0a505d9836524d5523f20ad90c4f347d3b56d629ae8651351cfffaf41e`.
The earlier reconnect-only build was
`d2f0d842193b8e0c505369dcc2fb2a92a2a5ef6e658c789d713eb3e32dca16c1`.

The final Hub uses a fixed Miniflare/workerd build without a development watcher
or remote bindings. See the [lab guide](../../scripts/plugin-peer-vm/LINUX.md).
The real official ACP 0.1.2 artifact is SHA-256 verified and provisioned offline;
download/install transport is not covered. Its downstream ACP agent is a
deterministic protocol fixture, not a real model.

## Fixes supported by reproduction

1. A result query could overtake Agent run registration and falsely report
   unknown, reproduced through RTC and remote MCP. The common Agent entry now
   reserves admission in memory before scheduling asynchronous work. No I/O or
   process wait is added to the control loop. Durable intent is still mandatory
   before execution; genuine unknown outcomes never permit replay. The initial
   RTC-only Tool delay was removed rather than keeping two different rules.
2. Eight account-wide challenge slots evicted valid concurrent handshakes:
   only 8/32 succeeded. The bounded limit is now 64; signatures, the 120-second
   TTL, one-use consumption and revocation remain unchanged. Real 32/32
   handshakes now succeed; replay still returns 401. Error text no longer tells
   users to reset a valid token blindly.
3. Transient challenge transport/429/5xx failures were classified as permanent
   HIGH_SEC failures, disabling reconnection. They now use existing reconnect
   backoff; revoked keys and invalid signatures still fail closed.
4. Long plugins could complete through a replaced socket that reported a
   successful write but delivered nothing. Results follow the current socket
   and retry for at most two minutes, without invoking the plugin again. Replies
   retain their original Hub/token scope. Revocation or a changed identity stops
   delivery; RTC fallback also checks the original authorization identity.
5. Duplicate plugin completions lost stored ownership; late accepted messages
   could demote done to running. Preserve ownership and completed state. The new
   regression failed before the fix and passes afterward; foreign operators
   still cannot read the result through their own fingerprint.
6. Closing RTC cancelled its session context, which could then close the shared
   control WebSocket when reused for fallback writes. The regression fails with
   `context canceled` on the old code. Fallback now has its own five-second write
   deadline and retains the authorization identity check. A real WebSocket test
   verifies both the fallback result and the following control message arrive.
7. Completed panes had no reclamation lifecycle. All backends now share one
   registration path and retain the newest 256 completed panes globally, ordered
   by completion. Running/queued tasks and in-flight delivery references are
   untouched. Disk receipts are not deleted, so evicted recoverable output keeps
   its exit code and reports `output_unavailable`, never permission to rerun.
   Named persistent terminals are not closed. This bounds count, not bytes.

Both deployment guides now correctly distinguish independent one-shot `run`
calls from explicitly operator-scoped `fleet session NAME` terminals. Runtime
semantics were not changed for this documentation correction.

## Results

- Linux Go: 268 passed, 2 skipped on the retention build across Agent, pane, backend
  and policy, including opt-in real-process deduplication/disconnect tests.
  Git and Herdr dependent tests remain uncovered because those tools are absent.
- Retention unit tests passed 50 consecutive rounds. A real-process test evicts
  output, forces a disk receipt read, preserves exit code 7, denies a foreign
  operator and verifies one execution of the original request.
- Full `npm test`: 570 passed, 7 skipped; typecheck passes. Lint has no errors
  and two pre-existing promo component warnings. Windows amd64 and macOS arm64
  pane tests cross-compile; this is not a runtime validation on those platforms.
- RTC-specific regression passed 50 consecutive rounds, including real WS
  fallback, authorization identity and legacy protocol compatibility.
- Tool/Room/authentication Node: 236 passed, 1 skipped.
- Worker/DO TypeScript: 74 passed, including duplicate plugin results and
  backward compatibility with older Agents.
- Three complete final-build rounds passed 240 RPC, 120 stdio MCP and 60 Room
  tasks. They exercise four operators, four independent MCP stdio processes,
  shared and separate machines, unique outputs/correlations, selected machines,
  cwd/environment separation, cancellation ownership and foreign-result denial.
- Three Room runners have identical display names and route by identity/device,
  executing actual Fleet commands. Same-name persistent terminals retain only
  their own operator's cwd/environment across detach/reattach.
- Four Streamable HTTP and four classic SSE sessions passed 80 real tasks with
  isolated same-machine/cross-machine output and WS provenance metadata.
- A real RTC connection falls back to WS with the same correlation, without
  replaying the command.
- Six fault scenarios pass: 35-second network partition, Hub restart, plugin
  completion while offline, plugin completion across Hub restart, Agent restart
  receipt recovery, and unknown outcomes after a hard Agent crash.
- Official ACP passed 20 concurrent tasks, crash/timeout isolation and a
  ten-minute task on the retention build: 604.976 seconds with 118 result/heartbeat checks,
  without a second approval in `allow` mode.
- The earlier reconnect-only 30-minute concurrency soak passed 115 cycles / 920 short tasks; the
  29-minute job completed normally.
- Health observation: 2026-10-13 05:05:44–05:35:50 UTC. All 122 guest samples
  were online; all six services retained their PIDs, with zero restart deltas
  and no OOM. Agent logs contained no socket-closed or authentication failures.

## Retention baseline and scope

A passing functional window does not prove long-term memory stability. Service
cgroup memory (MiB, not individual-process RSS) was:

| Service | Start | End | Peak |
|---|---:|---:|---:|
| Agent A | 29 | 244 | 244 |
| Agent B | 8 | 79 | 79 |
| Local Hub | 272 | 511 | 514 |

Agent A had about 220 MiB of anonymous memory at closeout, so file cache alone
does not explain it. Code inspection confirms that `Supervisor.panes/order`
retains completed panes without reclamation. Further heap profiling is warranted;
the entire observed increase must not be attributed to one cause without it.

The user approved a global 256-completed-pane policy after this baseline.
The new experiment uses a fresh disposable Agent state namespace while retaining
all original receipts (2,890 on A, 949 on B). No receipt pruning was introduced;
the existing 4,096-receipt admission cap is unchanged. Legacy requests without
receipts cannot recover evicted output. Active-task concurrency and per-pane
output size remain separate concerns; this is not a hard process-memory limit.

## Retention build: repeated load and natural collection

Window: 2026-10-13 06:19:12–06:39:17 UTC. Four load waves completed 4,096
short tasks (512 per machine per wave), alongside the three complete integration
rounds, remote MCP tests and official ACP long task. Two 15-minute jobs survived
all four overflows and completed with their expected output. No forced GC or
Agent/Hub restart occurred in this window.

All 82 guest health samples were online; all six observed services retained
their PIDs, had zero restart deltas and no OOM. Values below are MiB:

| Metric | Agent A | Agent B | Local Hub service group |
|---|---:|---:|---:|
| cgroup end / peak | 113.4 / 114.0 | 108.1 / 118.9 | 604.7 / 629.3 |
| Anonymous end / peak | 96.5 / 97.9 | 94.6 / 104.5 | 483.0 / 504.0 |
| Agent process RSS end / peak | 105.0 / 105.4 | 105.1 / 105.2 | — |
| Agent RSS range over final 8 minutes | 67.8–105.4 | 103.6–105.2 | — |

The cache warmed, then stayed within the observed envelope instead of retaining
every completed pane. A naturally collected down-step is visible without
restarting the process. This is a bounded-count regression and a finite observed
plateau, not a claim of leak-free behavior for every workload or perpetual uptime.

After the steady window, the disposable Hub result cache was cleared. The old
request still returned exit code 7 and `output_unavailable`. Repeating the same
request ID left the execution counter at **one**, proving eviction did not permit
replay through the actual Hub/Tool/Agent path. Original receipt directories stayed
unchanged. Current evidence is `retention-final`, `retention-round-1/2/3`,
`sessions-retention-final`, `remote-retention-final`, `auth-retention-final`,
`plugins-retention-final` and `health-retention-final.ndjson`.

All six fault scenarios were rerun after this window on the retention build and
passed (`faults-retention-final`). Intentional fault restarts are not mixed into
the steady-window measurements. Both VMs were stopped after evidence collection;
their disks, old receipts and original working tree were preserved.

Redacted exported runs: `relay-round-1/2/3`, `remote-relay-final`,
`sessions-relay-final`, `auth-relay-final`, `faults-relay-final`,
`plugins-relay-final`, `soak-relay-final`; health is `health-relay-final.ndjson`.
The failed `unified-round-1` is retained as well.

## Failed runs and limits

At review time, parent PR #22 already has a failed Windows workflow:
`TestOperationUnavailableStoreNeverStartsCommand` expects `unknown`, while the
Windows filesystem path returns a refusal before execution (exit 126, cannot
persist intent). Linux/Web parent jobs pass. This patch does not change that
cross-platform status contract or claim that Windows CI is green.

During retention validation, a Node test launch on VM A lacked test-only Hub
sources and a shared JSON fixture. The complete fixture on VM B passed 236 tests
with one skip. Running the full Room CLI suite on macOS also fails 13 tests
because it requires Linux `/dev/shm`; those tests pass in VM B. Neither is counted
as a successful run on the unsupported/incomplete environment.

An initial Wrangler development run hit its 1 GiB cgroup limit. After raising it
to 2 GiB, another development process exited without a useful stack. These
failures exposed real reconnect/result-delivery bugs. The fixed-build runtime
uses the same business code and persisted DO state. Failed runs do not count
toward the final soak. There is no evidence that the later development-process
exit was a production Cloudflare failure.

The first parallel run after the admission fix also reproduced the RTC/WS
cancellation bug above. Its MCP failure and intentionally stopped soak remain
recorded failures/incomplete runs, not final passes. The clock restarts after
the fallback fix.

Operator routing separation is not a hostile-agent security boundary when all
agents share an administrator token. Plugin result retry is volatile and limited
to two minutes; process death or longer outages can still lose the result.
Unknown never means safe to rerun. A finite test window cannot prove perpetual
availability.

Real macOS/Windows, suspend/lid-close, public NAT, UI appearance and production
deployment are outside this validation. The existing Agent binary already has
`fleet start/status/--daemon`; no second Mac daemon was introduced.

[中文](../zh/linux-sandbox-validation.md)
