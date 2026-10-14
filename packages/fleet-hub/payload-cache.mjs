const encoder = new TextEncoder();
export function expiredResult() {
  return {
    status: "unknown", code: "RESULT_NOT_RETAINED", output_available: false,
    error: "Hub result payload expired or exceeded its cache budget; query the Agent with the original handle, never replay the operation.",
  };
}

/** FIFO-by-write cache; lookup does not extend retention or copy payloads. */
export class PayloadCache {
  constructor({ maxBytes = 32 << 20, maxEntries = 4096, ttlMs = 15 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntries, ttlMs, now });
    this.rows = new Map();
    this.bytes = 0;
  }
  delete(key) {
    const row = this.rows.get(key);
    if (!row) return;
    this.bytes -= row.bytes;
    this.rows.delete(key);
  }
  sweep() {
    const now = this.now();
    for (const [key, row] of this.rows) {
      if (row.expiresAt > now) break;
      this.delete(key);
    }
  }
  set(key, value) {
    this.sweep();
    this.delete(key);
    const bytes = encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;
    if (bytes > this.maxBytes || this.maxEntries <= 0) return;
    while (this.rows.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.rows.keys().next().value);
    }
    this.rows.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
  }
  get(key) {
    this.sweep();
    // Wall-clock corrections can put a newer write ahead of an older expiry.
    const row = this.rows.get(key);
    if (row && row.expiresAt <= this.now()) this.delete(key);
    return this.rows.get(key)?.value;
  }
  clear() { this.rows.clear(); this.bytes = 0; }
}

export function isTerminalResult(row) {
  if (!row || ["pending", "running", "conflict"].includes(row.status)) return false;
  return row.ok !== undefined || row.exit_code !== undefined || row.status === "done" || row.status === "unknown";
}

/** Payloads only. Never stores/evicts session ownership or replay receipts. */
export class HubPayloads {
  constructor(options = {}) {
    this.results = new PayloadCache(options);
    this.screens = new PayloadCache({ ...options, ttlMs: options.ttlMs ?? 5 * 60_000 });
    this.completed = new PayloadCache({
      maxBytes: options.summaryMaxBytes ?? 4 << 20,
      maxEntries: options.summaryMaxEntries ?? 16384,
      now: options.now ?? Date.now,
      ttlMs: options.summaryTtlMs ?? 24 * 60 * 60_000,
    });
  }
  key(device, corr) { return JSON.stringify([device, corr]); }
  putScreen(device, corr, body) {
    this.screens.set(this.key(device, corr || ""), body);
    // Legacy no-corr readers retain their latest-screen behavior only.
    if (corr) this.screens.set(this.key(device, ""), body);
  }
  getScreen(device, corr) { return this.screens.get(this.key(device, corr || "")); }
  putResult(device, corr, row) {
    const key = this.key(device, corr);
    if (!isTerminalResult(row) && this.completed.get(key)) return;
    if (isTerminalResult(row)) this.completed.set(key, expiredResult());
    this.results.set(key, row);
  }
  getResult(device, corr) {
    const key = this.key(device, corr);
    return this.results.get(key) ?? this.completed.get(key);
  }
  clear() { this.results.clear(); this.screens.clear(); this.completed.clear(); }
}
