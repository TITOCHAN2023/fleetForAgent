# Runtime limits and remaining costs

These bounds apply to transient output, not authority or replay records. No change below resubmits a command, cancels a running task, changes heartbeat intervals, or removes an Agent operation receipt.

| Component | Default bound | Behavior at the boundary |
| --- | --- | --- |
| Classic MCP SSE, Worker and Node | 8 MiB queued encoded bytes per stream | Error and release the stream queue, clear keepalive/session state. The operation continues; use its original recovery handle to query, never repeat the operation merely because SSE disconnected. |
| Node result payloads | 32 MiB encoded key/value bytes, 4,096 entries, 15 minutes from last write | Oldest written payloads expire/evict. |
| Node screen payloads | 32 MiB encoded key/value bytes, 4,096 entries, 5 minutes from last write | Explicit missing correlation returns empty, never another task's latest screen. |
| Node completion summaries | 4 MiB, 16,384 entries, 24 hours | Summary says `status: unknown`, `code: RESULT_NOT_RETAINED`, not successful completion. |
| Worker result waits | One shared read loop per correlation, one-second fallback, existing 30-second request maximum | A persisted terminal result wakes all waiters immediately. No run dispatch occurs inside the waiter. |

These are encoded-payload budgets, not exact process RSS limits. Cache metadata and JS strings have additional overhead. Lookups do not extend TTL. Writes and lookups remove expired entries; an idle process may retain bounded expired payloads until its next cache access.

## Recovery and compatibility

`get_result` for an expired result sends only `get_result` to the Agent, including the original correlation and fingerprint. A positive `wait_ms` waits for refreshed output; if no output arrives, the expired-output summary remains explicit. Agent receipts and its retained output determine what can be recovered. Plugin results cannot be reconstructed by re-invoking the plugin: expired plugin output is reported unknown, never retried automatically.

The standalone Node Hub retains its existing owner/live/alive routing metadata. It can therefore prove that a handle finished even after the bounded completion-summary cache expires. The website Node runtime retains a compact set of completed device/handle identities for the same reason. These identity-only records remain **O(historical tasks)** until restart. This patch bounds the large payload caches, not all process memory; removing identity records safely needs a separate compatibility design. Unknown handles and running tasks are never inferred to be completed.

Worker waits use DO-instance-local notification state only; durable storage remains authoritative and is checked initially and on the fallback timer. Timeout or an available internal abort signal removes the waiter's timer/listener; the public request's signal is not newly propagated into operation dispatch. A disconnected caller can therefore leave an internal wait until the existing 30-second maximum, but cannot stop or replay the running task.

Tests use small injected budgets and clocks, synthetic devices on loopback, and concurrent isolated correlations. No production machine or destructive command is required.

## Other review changes and non-goals

The Agent bounds live single-line text at 64 KiB and marks truncation rather than stopping a task. Dirty-pane selection becomes fair, but it still scans O(P) panes: this is not an O(1) scheduler rewrite. Room SQLite prefix reads use index ranges; broader task-list pagination and assignee indexes are not part of this change. Device alias misses use a completed migration marker; changing an alias still scans O(D) account devices for compatibility checks.

The result/SSE boundaries deliberately change behavior for excessive output and slow consumers. They do not promise byte-for-byte output beyond those limits or constant total process memory. Permission checks, replay protection, plugin execution, and WS/RTC execution semantics remain separate from transient output retention.
