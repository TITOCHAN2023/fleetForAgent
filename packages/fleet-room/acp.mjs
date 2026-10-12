import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One owned process group and one ACP session. No private-session attachment. */
export class AcpSession {
  constructor({ command, args = [], cwd, env = process.env, mcpServers = [], onUpdate, onPermission,
    openTimeoutMs = 30_000, promptTimeoutMs = 900_000, cancelTimeoutMs = 5_000,
    killTimeoutMs = 1_000, maxFrameBytes = 1 << 20, maxOutputBytes = 4 << 20 } = {}) {
    if (!command || !Array.isArray(args) || !args.every((arg) => typeof arg === "string") || !isAbsolute(cwd || "")) {
      throw new TypeError("ACP requires command, string args and absolute cwd");
    }
    for (const value of [openTimeoutMs, promptTimeoutMs, cancelTimeoutMs, killTimeoutMs, maxFrameBytes, maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("ACP limits must be positive integers");
    }
    Object.assign(this, { command, args, cwd, env, mcpServers, onUpdate, onPermission,
      openTimeoutMs, promptTimeoutMs, cancelTimeoutMs, killTimeoutMs, maxFrameBytes, maxOutputBytes });
    this.state = "new";
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.outputBytes = 0;
    this.active = null;
  }

  async open() {
    if (this.state !== "new") throw failure("acp_state", "ACP session already opened or closed");
    // POSIX process groups are required. Windows needs a Job Object host, not taskkill guesses.
    if (process.platform === "win32") throw failure("acp_unsupported", "ACP process containment requires a POSIX host");
    this.state = "opening";
    const child = this.child = spawn(this.command, this.args, {
      cwd: this.cwd, env: this.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      child.once("error", () => {
        this.fail(failure("acp_spawn", "Unable to start ACP process"));
        resolve();
      });
      child.once("exit", () => this.kill("SIGKILL")); // Sweep descendants, then drain stdout before settling.
      child.once("close", (code, signal) => {
        this.fail(failure("acp_exit", "ACP process exited", { exitCode: code, signal, outcome: this.active ? "unknown" : undefined }));
        resolve();
      });
    });
    child.stdout.on("data", (chunk) => this.receive(chunk));
    child.stdout.on("error", () => this.fail(failure("acp_transport", "ACP stdout failed")));
    child.stdin.on("error", () => this.fail(failure("acp_transport", "ACP stdin failed")));
    child.stderr.resume(); // Never retain or expose credentials from CLI diagnostics.
    const timer = setTimeout(() => this.fail(failure("acp_timeout", "ACP initialization timed out")), this.openTimeoutMs);
    try {
      this.initialized = await this.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "fleet-room", version: "0.1.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (this.initialized?.protocolVersion !== 1) throw failure("acp_protocol", "Unsupported ACP protocol version");
      const session = await this.request("session/new", { cwd: this.cwd, mcpServers: this.mcpServers });
      if (typeof session?.sessionId !== "string" || !session.sessionId) throw failure("acp_protocol", "ACP returned no session ID");
      this.sessionId = session.sessionId;
      if (this.state === "closed") throw failure("acp_closed", "ACP process closed during initialization");
      this.state = "ready";
      return this;
    } catch (error) {
      this.fail(error);
      await this.close();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async prompt(text, { signal } = {}) {
    if (this.state !== "ready") throw failure("acp_state", "ACP session is not ready");
    if (this.active) throw failure("acp_busy", "ACP session already has an active turn");
    if (typeof text !== "string" || !text.trim()) throw new TypeError("ACP prompt must be nonempty text");
    if (signal?.aborted) throw failure("acp_aborted", "ACP prompt aborted before submission", { outcome: "not_started" });
    const turn = this.active = { text: "", cancelling: false };
    this.outputBytes = 0;
    const abort = () => this.cancel(turn);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.promptTimeoutMs);
    turn.done = this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    try {
      const result = await turn.done;
      const reasons = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
      if (!reasons.includes(result?.stopReason)) throw failure("acp_protocol", "ACP returned invalid stop reason", { outcome: "unknown" });
      return { stopReason: result.stopReason, text: turn.text };
    } catch (error) {
      this.fail(error);
      await this.exited;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(turn.cancelTimer);
      signal?.removeEventListener("abort", abort);
      this.active = null;
    }
  }

  cancel(turn = this.active) {
    if (!turn || turn !== this.active || turn.cancelling) return;
    turn.cancelling = true; // Close permission gate before writing cancellation.
    try { this.send({ method: "session/cancel", params: { sessionId: this.sessionId } }); }
    catch (error) { this.fail(error); return; }
    turn.cancelTimer = setTimeout(() => this.fail(failure("acp_cancel_unconfirmed",
      "ACP cancellation was not confirmed; process closed, external effects unknown", { outcome: "unknown", sessionState: "closed" })), this.cancelTimeoutMs);
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  async shutdown() {
    if (this.active && this.state !== "closed") {
      this.cancel();
      await this.active.done.catch(() => {});
    }
    this.state = "closed";
    this.rejectPending(failure("acp_closed", "ACP session closed"));
    if (!this.child) return;
    this.child.stdin.destroy();
    this.kill("SIGTERM");
    await Promise.race([this.exited, delay(this.killTimeoutMs)]);
    this.kill("SIGKILL");
    await this.exited;
  }

  kill(signal) {
    if (!this.child?.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") this.child.kill(signal); }
  }

  fail(error) {
    if (this.active && !error.outcome) error.outcome = "unknown";
    this.state = "closed";
    this.rejectPending(error);
    this.child?.stdin.destroy();
    this.kill("SIGKILL");
  }

  rejectPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  send(message) {
    if (this.state === "closed") throw failure("acp_closed", "ACP session closed");
    const frame = JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw failure("acp_limit", "ACP request exceeds frame limit");
    if (this.child.stdin.writableLength + Buffer.byteLength(frame) > this.maxOutputBytes) throw failure("acp_limit", "ACP input backlog exceeds limit");
    this.child.stdin.write(frame);
  }

  receive(chunk) {
    if (this.state === "closed") return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > this.maxOutputBytes) return this.fail(failure("acp_limit", "ACP output exceeds byte limit", { outcome: this.active ? "unknown" : undefined }));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      let end;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        if (end > this.maxFrameBytes) throw failure("acp_limit", "ACP frame exceeds byte limit");
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1);
        this.dispatch(JSON.parse(line));
        if (this.state === "closed") return;
      }
      if (this.buffer.length > this.maxFrameBytes) throw failure("acp_limit", "ACP frame exceeds byte limit");
    } catch (error) {
      this.fail(error.code?.startsWith("acp_") ? error : failure("acp_protocol", "Invalid ACP frame"));
    }
  }

  dispatch(message) {
    if (!message || message.jsonrpc !== "2.0") throw failure("acp_protocol", "Invalid ACP JSON-RPC envelope");
    if (message.method === "session/update") {
      if (message.params?.sessionId !== this.sessionId) return;
      const update = message.params.update;
      if (this.active && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") this.active.text += update.content.text;
      if (this.onUpdate) Promise.resolve(this.onUpdate(update)).catch(() => this.fail(failure("acp_callback", "ACP update handler failed")));
      return;
    }
    if (message.method && message.id !== undefined) {
      if (message.method === "session/request_permission") {
        void this.permission(message).catch(() => this.fail(failure("acp_permission", "ACP permission response failed")));
      } else this.send({ id: message.id, error: { code: -32601, message: "Client method not supported" } });
      return;
    }
    if (message.method) return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // Responses are correlated by ID, never by arrival order.
    this.pending.delete(message.id);
    if (message.error) pending.reject(failure("acp_rpc", "ACP request failed", { rpcCode: message.error.code }));
    else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(failure("acp_protocol", "ACP response has no result"));
  }

  async permission(message) {
    const turn = this.active;
    const params = message.params;
    const allowed = () => this.state === "ready" && this.active === turn && turn && !turn.cancelling && params?.sessionId === this.sessionId;
    let optionId;
    if (allowed() && this.onPermission) {
      try { optionId = await this.onPermission(params); } catch { /* deny */ }
    }
    if (this.state === "closed") return;
    const options = Array.isArray(params?.options) ? params.options : [];
    // Only a fresh, explicit one-shot grant is accepted. Never persist a grant.
    const selected = allowed() && options.find((option) => option.optionId === optionId && option.kind === "allow_once");
    const rejected = allowed() && options.find((option) => option.kind === "reject_once");
    const outcome = selected || rejected;
    this.send({ id: message.id, result: { outcome: outcome
      ? { outcome: "selected", optionId: outcome.optionId } : { outcome: "cancelled" } } });
  }
}
