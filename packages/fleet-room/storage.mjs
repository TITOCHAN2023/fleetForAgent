import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, fchmodSync, fstatSync, constants } from "node:fs";
import { dirname } from "node:path";

/** The authoritative Room ledger lives exclusively in the leader's private directory. */
export class RoomStorage {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    // Set private permissions before SQLite can write data; never follow a DB symlink.
    const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Room ledger must be a regular file");
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
    this.db = new DatabaseSync(filename);
    try { this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS room_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); }
    catch (error) { this.db.close(); throw error; }
    this.tail = Promise.resolve();
    this.api = {
      get: async (key) => { const r = this.db.prepare("SELECT value FROM room_kv WHERE key=?").get(key); return r ? JSON.parse(r.value) : undefined; },
      put: async (key, value) => { this.db.prepare("INSERT INTO room_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); },
      delete: async (key) => this.db.prepare("DELETE FROM room_kv WHERE key=?").run(key).changes > 0,
      list: async ({ prefix = "" } = {}) => new Map(this.db.prepare("SELECT key,value FROM room_kv WHERE substr(key,1,?)=? ORDER BY key").all([...prefix].length, prefix).map((r) => [r.key, JSON.parse(r.value)])),
    };
  }
  transaction(fn) {
    if (this.closing) return Promise.reject(new Error("Room storage is closed"));
    const op = this.tail.then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      let active = true;
      const tx = Object.fromEntries(Object.entries(this.api).map(([key, method]) => [key, async (...args) => {
        if (!active) throw new Error("Room transaction is no longer active");
        return method(...args);
      }]));
      try { const value = await fn(tx); active = false; this.db.exec("COMMIT"); return value; }
      catch (e) { this.db.exec("ROLLBACK"); throw e; }
      finally { active = false; }
    });
    this.tail = op.catch(() => {});
    return op;
  }
  async close() {
    if (!this.closing) this.closing = this.tail.then(() => this.db.close());
    await this.closing;
  }
}
