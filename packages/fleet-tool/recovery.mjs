import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// A checkpoint belongs to ONE operator, hub and credential generation. Never
// default to a shared home-directory file: that would merge independent agents.
export function openRecovery(path, { url, token }) {
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("FLEET_SESSION_PATH must be an absolute path unique to this agent session");
  const binding = createHash("sha256").update(`${url}\0${token}`).digest("hex");
  const lock = `${path}.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Fleet session is already locked (EEXIST). Do not share its path; after a hard crash verify the old process is gone before removing this exact .lock file.");
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    unlinkSync(lock);
  };
  try {
    writeFileSync(fd, String(process.pid));
    let saved = { version: 1, binding, fingerprint: randomUUID(), state: {} };
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 128 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new Error("unsafe Fleet session file (requires a private regular file <=128 KiB)");
      }
      saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.version !== 1 || saved.binding !== binding || typeof saved.fingerprint !== "string" || !saved.fingerprint) {
        throw new Error("Fleet session checkpoint belongs to a different hub or token; use a new session path");
      }
    }
    let persisted = "";
    const save = (state) => {
      // Explicit allowlist: no command, output, environment or token on disk.
      const next = { ...saved, state: {
        lastUsed: state.lastUsed || null,
        lastCwd: state.lastCwd || null,
        corrByDevice: state.corrByDevice || {},
        cwdByDevice: state.cwdByDevice || {},
        requestByDevice: state.requestByDevice || {},
      } };
      const data = JSON.stringify(next);
      if (data === persisted) return;
      if (Buffer.byteLength(data) > 128 * 1024) throw new Error("Fleet session checkpoint is full");
      const temp = `${path}.${randomUUID()}.tmp`;
      const out = openSync(temp, "wx", 0o600);
      try {
        try { writeFileSync(out, data); fsyncSync(out); } finally { closeSync(out); }
        renameSync(temp, path);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
      saved = next;
      persisted = data;
    };
    save(saved.state);
    return { fingerprint: saved.fingerprint, state: saved.state, save, close };
  } catch (error) { close(); throw error; }
}
