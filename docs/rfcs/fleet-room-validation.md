# Fleet Room local validation — 2026-09-29

Branch: `feat/fleet-room`, based on `a660775`. Validation recorded before PR publication; no production deployment.

## Result

- Existing regression suite: 537 passed, 7 explicitly skipped.
- Room tests: 102 passed, including state machine, SQLite, real WebSocket relay, two runners, ACP processes, MCP compatibility and Worker authorization.
- Go machine service: 309 tests/subtests passed, 3 skipped because the minimal image lacks Python/Git; `go vet ./...` passed. The final display-metadata addition also passed five focused Go RoomView tests and vet. Reproduced in a 1 CPU / 1 GiB `--init` container on an isolated internal bridge. The host subreaper affected an old PPID assertion; no-network mode prevented WebRTC ICE candidates. Both original tests passed in the correct isolated environment without changing assertions.
- Two-endpoint private Docker lab: Hub and each endpoint capped at 1 CPU / 1 GiB. A member called the actual target Fleet device, got `pod-a` using the room default and `pod-b` using an explicit override. Only the leader had a Room database.
- Browser against the built Worker static page and real local Hub/leader state: room creation, 96-character agent identity, invitation, delegation/completion, full result, message persistence and offline clearing passed. Only login was mocked. No Room text in browser persistent storage.
- Fleet Sandbox local page: nine browser checks with actual Go services and real leader SQLite passed, including Chinese 30+5 pagination, room switching, member empty state, Hub-offline reads, credential filtering, and clearing after the local runner stops. The Grok Bot-inspired workspace additionally passed desktop, 390px mobile and dark-mode checks; machine settings, permission controls, search and language switching remain accessible. Registered agent names and stable IDs are visible, including on mobile. Two same-name Codex agents remain distinct; the leader role and machine name are separate. User authors cannot borrow an agent identity, and 96-character IDs do not overflow.
- Actual workerd: real account/OAEP authentication, one-use handshake revalidation, cookie writes, cross-origin rejection, cross-account isolation and live token revocation passed. Test-only Worker exports were separated from the production entrypoint so workerd can start.
- App routing: six real PGLite/BetterAuth/OAEP integration tests passed, including native and Nitro/crossws WebSockets; no mocked authorization or SQL.
- Actual Grok and pinned Codex ACP adapters: separate sessions, parallel completion and cancellation passed. The Docker/browser fixtures are deterministic ACP peers; these are separate kinds of evidence.
- Typecheck, development build, Worker dry-run bundle and lint passed. Lint retains two pre-existing promo component warnings.

Reproduce with `npm test`, `npm run test:room`, `npm run test:room:intranet` and `node scripts/room-lab/browser.mjs` / `node scripts/room-lab/sandbox-browser.mjs` using Node 22.16+. Browser script accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an installed Chromium; see its header for other options.

## Independent review

Five findings were fixed and rechecked: empty first-page task cursor; oversized composed session IDs; Chinese UTF-8 split across HTTP chunks; blocked sessions starving later queue pages; and half-open WebSocket connections retaining identity ownership. Regression evidence exists for each; all five findings are closed. Real workerd additionally caught reuse of a one-use OAEP challenge during upload revalidation; revalidation now checks the resolved key instead, and the regression is covered.

Risk classification remains **high** because this adds an authenticated execution and coordination surface. Automated review is not a production approval.

## Risk reflection

- **Reserved-path / shared-state collision**: Leader state lives under the explicitly configured data directory, with private SQLite files and Hub/identity/credential binding. Followers cannot create a Room ledger; their known CLI state directories must be owned private tmpfs, with an exclusive runtime lock. MCP identity seeds use exclusive creation and do not overwrite existing state.
- **Bookkeeping consistency**: Leader transactions are the sole source of truth; Hub directory and pending calls are transient. Writes update message/task state atomically; membership removal revokes new work while allowing exact-epoch stopped receipts. Display-name edits retain identity; changing defaults preserves already-frozen task targets. Home-directory aliases are supported while the discovery directory itself cannot be a symlink (covered by a regression using an aliased home). Local discovery descriptors contain no Room text, are created exclusively, and normal shutdown removes only the same runner instance. Room deletion/rename and leader transfer are not exposed, so no unsupported cross-view mutation is claimed. Offline browser views are removed rather than backed by persistent caches.
- **Blast radius**: Existing Node Hub, Worker authorization, Fleet Tool protocol and packaged artifact suites passed in addition to new Room tests. The Docker lab exercised real Go device execution; the browser used actual leader state, catching interface errors that permissive mocks missed. New tests are included in CI.
- **Reversibility**: Before any deployment, stop runners and retain a copy of leader SQLite plus WAL/SHM as appropriate for SQLite backup. Disabling the new UI/relay routes removes new ingress; old device endpoints are unchanged. Do not delete the leader ledger or replay unknown tasks. Cloudflare migration v6 adds an otherwise empty RoomRelayDO namespace; a rollback must keep its class/binding until existing connections are drained, rather than blindly removing a migrated class from the Worker.
- **Follow-ups identified**: See the boundary register below. None is represented as completed or as a guarantee of this implementation.

## Boundary register

| ID | Boundary / disposition |
| --- | --- |
| ROOM-01 | Only known Grok/Codex state paths are redirected. OS swap, model-provider retention and arbitrary adapter writes are outside this guarantee. Members fail closed without verified tmpfs. |
| ROOM-02 | Existing Fleet command/result retention remains unchanged. Hub is a trusted plaintext relay for Room traffic; no E2E or malicious-Hub resistance claim. |
| ROOM-03 | Leader migration and credential rotation need explicit account-verified ledger migration. Binding mismatch stops startup; deleting history is not a recovery procedure. |
| ROOM-04 | Unknown executions require confirming the old process stopped before any operator-directed retry; no automatic failover or exactly-once shell guarantee. |
| ROOM-05 | Member CLI-state containment currently requires Linux. Windows runtime process containment and macOS volatile-state provisioning are not implemented. |
| ROOM-06 | Nitro production preview reports an `ssr_exports` module error. Rebuilding the untouched `a660775` tree with the same locked dependencies reproduces the identical invalid export in `_ssr/ssr.mjs`; this predates Room. Development-browser validation and Worker bundling do not claim that preview passed. Production rollout must resolve or isolate it. |
| ROOM-07 | The App relay is process-local. Auto-scaled Vercel HTTP and WebSocket connections lack account-level instance routing; a single-process App or the Worker account-scoped relay is required. Successful Nitro adapter tests do not establish multi-instance hosting support. |

## Windows CI follow-up

The first PR run passed the Web/Worker and Linux jobs but failed two local-view tests on Windows. Those tests assumed that `Mkdir(0700)` / `WriteFile(0600)` establish POSIX private permissions. Windows exposes different mode semantics, so the existing discovery guard correctly refused them before reaching the local leader. The Room runner already requires POSIX; Windows ACL-based local discovery remains unimplemented.

The tests now separate POSIX private-file integration from platform-independent HTTP protections. Windows explicitly verifies an empty view without a runner and refusal of unverifiable discovery without contacting the endpoint or exposing the capability. Redirect and response-limit tests call the HTTP reader directly on every platform, preventing an earlier filesystem rejection from falsely satisfying those tests. The permission test restores a valid URL before loosening file permissions, so it cannot pass because of an unrelated URL error. No production permission check or workflow gate is weakened.

Local follow-up verification: all six Linux RoomView tests and Go vet passed. The PR's Windows job provides native runtime verification; cross-compilation alone is not evidence of a Windows runtime pass.

## Joint pre-merge validation with terminal backends

On 2026-09-29, the combined tree of PR #20 (`3c125b5`) and PR #21 (`7835479`) was exercised in a separate integration worktree. The package-script conflict was resolved by retaining both the terminal/intranet scripts and Room suites. PR #20 correctly rejects cookie writes without browser origin metadata; the Room workerd harness now supplies `Origin` on token issuance and rotation, just as it already does for Room writes. Production origin checks are unchanged.

- Combined existing JavaScript regression suite: **549 passed, 7 skipped**; Room suite: **102 passed**.
- Full Go suite and vet passed in a disposable PID-isolated container.
- Real Worker + two Linux endpoints + Tool direct RTC: tmux/Herdr/PTY interrupts, persistent detach/reattach and retained shell state, explicit close, and long temporary-path handling passed on both endpoints. Every runtime container was capped at 1 CPU / 1 GiB.
- Separate Room two-endpoint lab passed default-device and explicit-device delegation; only the leader had SQLite.
- Actual-backend Worker-page and local Sandbox-page browser suites passed **nine checks each**, including same-name agent identities and local reading after Hub shutdown.
- Real workerd passed account isolation, same-origin cookie writes, OAEP and live token revocation with the combined source.
- Typecheck, lint (two existing warnings), production build and Worker dry-run passed. The build used an empty `DATABASE_URL` and did not run production database migrations. The pre-existing Nitro runtime-preview limitation in ROOM-06 remains; a successful build does not supersede it.

The integration runs used only disposable accounts, processes and containers, which were cleaned up. No hosted deployment was performed by these tests. Native macOS execution and Windows Room hosting are still outside the validated scope.

The first combined GitHub run also caught a procfs race in the descendant-shutdown assertion: if the process is reaped after `/proc/<pid>/stat` is opened but before it is read, Linux can return `ESRCH` instead of `ENOENT`. Both indicate that the descendant is gone. The test now accepts those two specific disappearance errors and still fails on a live descendant or any other read error. All ten ACP tests and twenty repeated real-process shutdown checks passed locally; production process termination was not changed.
