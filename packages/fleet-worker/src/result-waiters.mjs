/** Ephemeral notification fan-out. Durable result storage remains authoritative. */
export class ResultWaiters {
  constructor({ read, isDone, fallbackMs = 1000 }) {
    this.read = read;
    this.isDone = isDone;
    this.fallbackMs = fallbackMs;
    this.entries = new Map();
  }

  wait(corr, waitMs, signal) {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (waitMs <= 0) return this.read(corr);
    let entry = this.entries.get(corr);
    if (!entry) {
      entry = { waiters: new Set(), timer: null, reading: false, row: undefined, revision: 0 };
      this.entries.set(corr, entry);
    }
    const group = entry;
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        group.waiters.delete(finish);
        if (group.waiters.size === 0) {
          clearTimeout(group.timer);
          if (this.entries.get(corr) === group) this.entries.delete(corr);
        }
        if (error) reject(error); else resolve(group.row);
      };
      const onAbort = () => finish();
      const timer = setTimeout(() => finish(), waitMs);
      group.waiters.add(finish);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!group.reading && !group.timer) void this.check(corr, group);
    });
  }

  async check(corr, entry) {
    entry.reading = true;
    const revision = entry.revision;
    try {
      const row = await this.read(corr);
      if (this.entries.get(corr) !== entry) return;
      if (entry.revision === revision) this.notify(corr, row);
      if (entry.waiters.size > 0) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.check(corr, entry);
        }, this.fallbackMs);
      }
    } catch (error) {
      for (const finish of [...entry.waiters]) finish(error);
    } finally {
      entry.reading = false;
    }
  }

  notify(corr, row) {
    const entry = this.entries.get(corr);
    if (!entry) return;
    entry.revision++;
    entry.row = row;
    if (this.isDone(row)) for (const finish of [...entry.waiters]) finish();
  }
}
