/**
 * MCP operator surface. Last-used lives in this process only.
 * Do not write hub_sessions, ~/.fleet, or a workspace file.
 */

export const FLEET_VERSION = "0.2.8";

/** MCP-call wait budget only. Not a kill timeout. Hosts cancel tools at ~60s. */
export const WAIT_MAX_MS = 30_000;
/** get_result omitted/0: instant snapshot. */
export const WAIT_DEFAULT_MS = 0;
/** run omitted wait_ms: block like other exec MCPs, then ticket if still going. */
export const RUN_WAIT_DEFAULT_MS = WAIT_MAX_MS;
export const WAIT_TOOL_DEFAULT_MS = WAIT_MAX_MS;
export const WAIT_POLL_MS = 100;

export const MISSING_DEVICE_MESSAGE =
  "device_id required — pass device_id or call set_computer";

/** Trailer on wrapped /bin/sh -c runs. Process-memory cwd only — not env persistence. */
export const CWD_MARK = "__FLEET_META__";

/** POSIX single-quote wrap. Do not interpolate the path. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function wrapSessionCommand(command, cwd) {
  const lines = [
    "__fleet_ec=0",
    `trap '__fleet_ec=$?; printf "\\n${CWD_MARK} %s %s\\n" "$__fleet_ec" "$(pwd)"; exit "$__fleet_ec"' EXIT`,
  ];
  if (cwd) lines.push(`cd ${shQuote(cwd)} || exit $?`);
  lines.push(String(command));
  return lines.join("\n");
}

export function stripSessionMeta(stdout) {
  const text = stdout == null ? "" : String(stdout);
  const re = new RegExp(`(?:^|\\r?\\n)${CWD_MARK} (\\d+) ([^\\r\\n]*)\\s*$`);
  const m = text.match(re);
  if (!m) return { stdout: text, cwd: null, exit: null };
  const exit = Number(m[1]);
  const cwd = m[2] || null;
  let cleaned = text.slice(0, m.index);
  if (cleaned.endsWith("\r")) cleaned = cleaned.slice(0, -1);
  return { stdout: cleaned, cwd, exit: Number.isFinite(exit) ? exit : null };
}

export function clampWaitMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WAIT_MAX_MS, n);
}

export function parseOptionalMs(value, name) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function isFinishedResult(row) {
  if (!row || typeof row !== "object") return false;
  if (row.status === "pending" || row.status === "running") return false;
  if (row.status === "done") return true;
  return row.ok !== undefined || row.exit_code !== undefined;
}

const SHELL_RESULT_TOOLS = new Set(["run", "get_result", "wait"]);

function nonemptyText(value) {
  if (value == null) return "";
  return String(value);
}

export function isFleetDev(env = {}) {
  const v = String(env.FLEET_DEV ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Strip `--dev` and set FLEET_DEV=1. Same env the MCP clients use. */
export function applyCliDevFlag(args, env = process.env) {
  const out = [];
  let dev = false;
  for (const a of args) {
    if (a === "--dev") dev = true;
    else out.push(a);
  }
  if (dev) env.FLEET_DEV = "1";
  return out;
}

function numOrZero(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function stampOrNull(row, key) {
  if (!row || typeof row !== "object" || row[key] == null) return null;
  return row[key];
}

function rowTime(row) {
  if (!row || typeof row !== "object") return null;
  if (row.t != null && Number.isFinite(Number(row.t))) return Number(row.t);
  if (row.T != null && Number.isFinite(Number(row.T))) return Number(row.T);
  return null;
}

export function emptyDevStamps() {
  return {
    hub_recv_t: null,
    hub_reply_t: null,
    hub_ms: null,
    device_enqueue_t: null,
    device_done_t: null,
    device_run_ms: null,
  };
}

function isoOrNull(ms) {
  return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
}

export function finalizeHop(hop, path, row) {
  const t_out = hop?.t_out;
  const t_in = hop?.t_in;
  const wait_ms = numOrZero(hop?.wait_ms ?? hop?.gap_ms);
  return {
    path: path || hop?.path || "?",
    t_out,
    t_in,
    t_out_iso: hop?.t_out_iso || isoOrNull(t_out),
    t_in_iso: hop?.t_in_iso || isoOrNull(t_in),
    send_ms: numOrZero(hop?.send_ms),
    wait_ms,
    gap_ms: numOrZero(hop?.gap_ms ?? wait_ms),
    recv_ms: numOrZero(hop?.recv_ms),
    total_ms: numOrZero(
      hop?.total_ms ?? (Number.isFinite(Number(t_in)) && Number.isFinite(Number(t_out)) ? Number(t_in) - Number(t_out) : 0),
    ),
    http_status: hop?.http_status ?? null,
    split: hop?.split || "body",
    status: hop?.status ?? hopStatus(row),
  };
}

export function formatHopLine(h) {
  const path = String(h?.path || "?").padEnd(16);
  return `# hop ${path} out=${h.t_out} in=${h.t_in} send=${numOrZero(h.send_ms)}ms wait=${numOrZero(h.wait_ms)}ms recv=${numOrZero(h.recv_ms)}ms total=${numOrZero(h.total_ms)}ms`;
}

export function formatDevTrailer(dev) {
  if (!dev || typeof dev !== "object") return "";
  const hops = Array.isArray(dev.hops) ? dev.hops : [];
  const lines = ["# fleet-dev"];
  for (const h of hops) lines.push(formatHopLine(h));
  const parts = [];
  if (dev.run_ms != null) parts.push(`run_ms=${dev.run_ms}`);
  if (dev.client_run_gap_ms != null) parts.push(`client_gap=${dev.client_run_gap_ms}ms`);
  parts.push(`poll=${dev.poll_count ?? 0}`);
  if (numOrZero(dev.sleep_ms) > 0) parts.push(`sleep=${dev.sleep_ms}ms`);
  parts.push(`total=${numOrZero(dev.total_ms)}ms`);
  lines.push(`# ${parts.join(" ")}`);
  return lines.join("\n");
}

/**
 * fetch split as tightly as undici allows.
 * send_ms = JSON serialize only (write vs TTFB cannot be split).
 * wait_ms / gap_ms = serialize-done → response headers (TTFB, includes the TCP write).
 * recv_ms = headers → JSON parsed.
 * split=headers.
 */
export async function measureHubFetch(url, init = {}, clocks = {}) {
  const wall = clocks.wall || Date.now;
  const perf =
    clocks.perf ||
    (() => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()));
  const t_out = wall();
  const p0 = perf();
  const serialized = init.body == null ? "" : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const pSent = perf();
  const res = await fetch(url, { ...init, body: serialized === "" && init.body == null ? init.body : serialized });
  const pHeaders = perf();
  const json = await res.json();
  const pEnd = perf();
  const t_in = wall();
  const wait_ms = Math.max(0, pHeaders - pSent);
  return {
    ok: res.ok,
    status: res.status,
    json,
    hop: finalizeHop(
      {
        t_out,
        t_in,
        t_out_iso: isoOrNull(t_out),
        t_in_iso: isoOrNull(t_in),
        send_ms: Math.max(0, pSent - p0),
        wait_ms,
        gap_ms: wait_ms,
        recv_ms: Math.max(0, pEnd - pHeaders),
        total_ms: Math.max(0, t_in - t_out),
        http_status: res.status,
        split: "headers",
      },
      clocks.path,
    ),
  };
}

export function unwrapTimedRpc(raw) {
  if (raw && typeof raw === "object" && raw.__fleetTimed) {
    return { json: raw.json, hop: raw.hop };
  }
  return { json: raw, hop: null };
}

/** MCP content text. Shell tools (run / get_result / wait) are human output, not JSON.stringify of the envelope. */
export function formatMcpText(name, out, env = {}) {
  let text;
  if (!SHELL_RESULT_TOOLS.has(name)) {
    if (out == null) text = "";
    else if (typeof out === "string") text = out;
    else if (typeof out === "object") {
      const { timing: _timing, dev: _dev, ...rest } = out;
      text = JSON.stringify(rest);
    } else text = JSON.stringify(out);
  } else if (!out || typeof out !== "object") {
    text = out == null ? "" : String(out);
  } else if (!isFinishedResult(out)) {
    const corr = nonemptyText(out.corr).trim();
    text = corr ? `running corr=${corr}` : "running";
  } else {
    const stdout = nonemptyText(out.stdout);
    const err = nonemptyText(out.error) || nonemptyText(out.stderr);
    const code = out.exit_code;
    const failed = (code != null && Number(code) !== 0) || out.ok === false || err !== "";
    if (!failed) {
      text = stdout;
    } else {
      const lines = [];
      if (stdout !== "") lines.push(stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout);
      if (code != null && String(code) !== "") lines.push(`exit_code: ${code}`);
      if (err !== "") lines.push(err);
      text = lines.join("\n");
    }
  }
  if (!isFleetDev(env)) return text;
  const trailer = formatDevTrailer(out && typeof out === "object" ? out.dev : null);
  if (!trailer) return text;
  if (text === "") return trailer;
  return (text.endsWith("\n") ? text : text + "\n") + trailer;
}

export function deviceMismatchMessage(corr, owner, got) {
  return `corr ${corr} belongs to device ${owner}, not ${got}`;
}

function trimId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function withDevice(row, deviceId) {
  return { ...row, device_id: deviceId };
}

function runningSnapshot(row, corr, deviceId) {
  const extra = row && typeof row === "object" ? { ...row } : {};
  delete extra.status;
  delete extra.isError;
  return { ...extra, corr, status: "running", device_id: deviceId };
}

function waitMsSchema({ defaultMs, role }) {
  return {
    type: "number",
    default: defaultMs,
    minimum: 0,
    maximum: WAIT_MAX_MS,
    description:
      `${role} MCP-call wait budget in milliseconds. Default ${defaultMs}. Capped at ${WAIT_MAX_MS} (30s) so the host cannot cancel with -32001 (clients ~60s). wait_ms never kills the remote command. status=running is not an error — do not re-issue run; long-poll with get_result(wait_ms) or wait(wait_ms). Do not spam wait_ms=0.`,
  };
}

export function buildTools() {
  const deviceId = { type: "string", description: "Target machine. Optional after set_computer or a prior explicit device_id in this process. FLEET_DEVICE_ID is a start-of-process default only." };
  return [
    {
      name: "list_computers",
      description: "List machines in this hub account. Never returns IPs.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "run",
      description:
        "Start a command on a device and wait for the result (default wait_ms 30000). If it finishes in time, return the same payload get_result would. Explicit wait_ms=0 is the fire-and-forget ticket: immediate {corr,status:\"running\"} (TUIs / long jobs). POST /v1/run is held only when this client sends wait_ms>0; omitted/old clients still get an immediate ticket. If the budget expires, return {corr,status:\"running\"} — the command continues. Never kill on wait expiry. Never re-issue run after status=running; poll get_result(wait_ms) or wait(wait_ms).",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          device_id: deviceId,
          command: { type: "string" },
          wait_ms: waitMsSchema({
            defaultMs: RUN_WAIT_DEFAULT_MS,
            role: "Optional. Omitted waits up to 30s; 0 is the immediate ticket.",
          }),
        },
      },
    },
    {
      name: "get_result",
      description:
        "Peek a previous run by corr. wait_ms omitted/0 is an instant snapshot. wait_ms>0 long-polls until completion or the budget expires (max 30s). status=running is not an error and does not mean the process died. Never re-issue run after status=running; poll again with get_result(wait_ms=...) or wait(wait_ms). Do not spam wait_ms=0.",
      inputSchema: {
        type: "object",
        required: ["corr"],
        properties: {
          device_id: deviceId,
          corr: { type: "string" },
          wait_ms: waitMsSchema({ defaultMs: WAIT_DEFAULT_MS, role: "Optional." }),
        },
      },
    },
    {
      name: "wait",
      description:
        "Explicit block: wait until a run finishes or wait_ms elapses (default 30s cap, max 30s). Long-polls get_result. wait_ms never kills the remote command. If still going: {corr,status:\"running\"} — not an error. Never re-issue run after status=running; poll with wait(wait_ms) or get_result(wait_ms). Do not spam wait_ms=0.",
      inputSchema: {
        type: "object",
        required: ["corr"],
        properties: {
          corr: { type: "string" },
          device_id: deviceId,
          wait_ms: waitMsSchema({ defaultMs: WAIT_TOOL_DEFAULT_MS, role: "Explicit block." }),
        },
      },
    },
    {
      name: "read_screen",
      description: "Snapshot the pane current frame (rendered grid on a live PTY). Does not attach or stream.",
      inputSchema: {
        type: "object",
        properties: { device_id: deviceId, corr: { type: "string" } },
      },
    },
    {
      name: "type",
      description:
        "Fire-and-forget keystrokes into the pane stdin. keys is a string (newlines become Enter/CR on the live PTY). Optional key is a named press like ssh_press: enter, ctrl+c, up. ctrl+c sends 0x03 and SIGINT to the foreground process group.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          keys: { type: "string", description: "Literal keystrokes. Still accepted. Newlines become CR on the live PTY." },
          key: { type: "string", description: "Named key (enter, ctrl+c, up, f5, ...). Optional; do not invent a sixth tool." },
          corr: { type: "string" },
        },
      },
    },
    {
      name: "set_computer",
      description:
        "Remember a device for later tool calls in this MCP process only. Not written to the hub account, disk, or other clients.",
      inputSchema: {
        type: "object",
        required: ["device_id"],
        properties: { device_id: { type: "string" } },
      },
    },
    {
      name: "get_current_computer",
      description: "Show this process's last-used device, last cwd, and FLEET_DEVICE_ID start default.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function hopStatus(row) {
  if (!row || typeof row !== "object") return undefined;
  if (row.status != null) return row.status;
  if (row.ok === false) return "error";
  return undefined;
}

export function createOperator({
  rpc,
  env = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof rpc !== "function") throw new Error("rpc required");

  let lastUsed = null;
  let lastCwd = null;
  const envDefault = trimId(env.FLEET_DEVICE_ID) || null;
  const fleetDev = isFleetDev(env);
  /** @type {Map<string, string>} */
  const corrOwner = new Map();
  const tools = buildTools();

  function newTrace() {
    return { hops: [], started: now(), sleep_ms: 0, startedRow: null };
  }

  async function callRpc(trace, path, body) {
    const payload = fleetDev && body && typeof body === "object" ? { ...body, dev: true } : body;
    if (!trace) {
      const raw = await rpc(path, payload);
      return unwrapTimedRpc(raw).json;
    }
    const t_out = now();
    const raw = await rpc(path, payload);
    const t_in = now();
    const { json: row, hop: measured } = unwrapTimedRpc(raw);
    const hop = finalizeHop(
      measured || {
        t_out,
        t_in,
        send_ms: 0,
        wait_ms: Math.max(0, t_in - t_out),
        recv_ms: 0,
        total_ms: Math.max(0, t_in - t_out),
        http_status: null,
        split: "body",
      },
      path,
      row,
    );
    trace.hops.push(hop);
    if (path === "/v1/run" && !trace.startedRow) trace.startedRow = row;
    return row;
  }

  function withDev(out, trace) {
    if (!fleetDev || !trace) return out;
    const hops = trace.hops.slice();
    const runHop = hops.find((h) => h.path === "/v1/run");
    const getHops = hops.filter((h) => h.path === "/v1/get_result");
    const startT = rowTime(trace.startedRow);
    const doneT = rowTime(out);
    const run_ms = startT != null && doneT != null ? doneT - startT : null;
    const client_run_gap_ms = runHop && getHops[0] ? getHops[0].t_in - runHop.t_out : null;
    return {
      ...out,
      dev: {
        hops,
        poll_count: getHops.length,
        sleep_ms: trace.sleep_ms || 0,
        total_ms: Math.max(0, now() - trace.started),
        run_ms,
        client_run_gap_ms,
        ...emptyDevStamps(),
        hub_recv_t: stampOrNull(out, "hub_recv_t"),
        hub_reply_t: stampOrNull(out, "hub_reply_t"),
        hub_ms: stampOrNull(out, "hub_ms"),
        device_enqueue_t: startT,
        device_done_t: doneT,
        device_run_ms: run_ms,
      },
    };
  }

  function currentDevice() {
    if (lastUsed) return { device_id: lastUsed, source: "last_used" };
    if (envDefault) return { device_id: envDefault, source: "env" };
    return { device_id: null, source: "none" };
  }

  function rememberCorr(corr, deviceId) {
    if (corr && deviceId) corrOwner.set(corr, deviceId);
  }

  function resolveDevice(args = {}, { corr } = {}) {
    const explicit = trimId(args.device_id);
    const owner = corr ? corrOwner.get(corr) : undefined;

    if (explicit) {
      if (owner && explicit !== owner) {
        throw new Error(deviceMismatchMessage(corr, owner, explicit));
      }
      lastUsed = explicit;
      return explicit;
    }
    if (owner) return owner;
    if (lastUsed) return lastUsed;
    if (envDefault) return envDefault;
    throw new Error(MISSING_DEVICE_MESSAGE);
  }

  function decorateResult(row, deviceId) {
    let out = withDevice(row, deviceId);
    if (typeof out.stdout === "string") {
      const meta = stripSessionMeta(out.stdout);
      out = { ...out, stdout: meta.stdout };
      if (meta.cwd) lastCwd = meta.cwd;
    }
    if (isFinishedResult(out)) out = { ...out, cwd: lastCwd };
    return out;
  }

  async function peekResult(deviceId, corr, trace, waitMs = 0) {
    const body = { device_id: deviceId, corr };
    if (waitMs > 0) body.wait_ms = waitMs;
    const row = await callRpc(trace, "/v1/get_result", body);
    return decorateResult(row, deviceId);
  }

  async function waitForResult(deviceId, corr, timeoutMs, trace) {
    const budget = clampWaitMs(timeoutMs);
    const startedAt = now();
    const deadline = startedAt + budget;
    let snapshot = await peekResult(deviceId, corr, trace, budget);
    if (isFinishedResult(snapshot) || budget <= 0) {
      return isFinishedResult(snapshot) ? snapshot : runningSnapshot(snapshot, corr, deviceId);
    }
    while (now() < deadline) {
      if (isFinishedResult(snapshot)) return snapshot;
      const left = deadline - now();
      if (left <= 0) break;
      const sl = Math.min(WAIT_POLL_MS, left);
      if (trace) trace.sleep_ms += sl;
      await sleep(sl);
      snapshot = await peekResult(deviceId, corr, trace, Math.max(0, deadline - now()));
    }
    if (isFinishedResult(snapshot)) return snapshot;
    return runningSnapshot(snapshot, corr, deviceId);
  }

  async function callTool(name, rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const trace = fleetDev ? newTrace() : null;

    if (name === "list_computers") {
      const row = await callRpc(trace, "/v1/list_computers", {});
      return withDev(row, trace);
    }

    if (name === "set_computer") {
      const deviceId = trimId(args.device_id);
      if (!deviceId) throw new Error("device_id required");
      lastUsed = deviceId;
      return { ok: true, device_id: deviceId };
    }

    if (name === "get_current_computer") {
      const cur = currentDevice();
      return {
        device_id: cur.device_id,
        last_used: lastUsed,
        env_default: envDefault,
        source: cur.source,
        cwd: lastCwd,
      };
    }

    if (name === "run") {
      const command = args.command == null ? "" : String(args.command);
      if (!command) throw new Error("command required");
      const deviceId = resolveDevice(args);
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? RUN_WAIT_DEFAULT_MS);
      const body = { device_id: deviceId, command };
      if (waitMs > 0) body.wait_ms = waitMs;
      const t0 = now();
      const started = await callRpc(trace, "/v1/run", body);
      const corr = started?.corr;
      rememberCorr(corr, deviceId);
      if (waitMs <= 0) {
        return withDev(withDevice({ ...started, corr, status: started?.status ?? "running" }, deviceId), trace);
      }
      const finished = decorateResult({ ...started, corr }, deviceId);
      if (isFinishedResult(started) || isFinishedResult(finished)) {
        return withDev(finished, trace);
      }
      const left = waitMs - Math.max(0, now() - t0);
      if (left <= 0) return withDev(runningSnapshot(started, corr, deviceId), trace);
      return withDev(await waitForResult(deviceId, corr, left, trace), trace);
    }

    if (name === "get_result") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_DEFAULT_MS);
      if (waitMs <= 0) return withDev(await peekResult(deviceId, corr, trace), trace);
      return withDev(await waitForResult(deviceId, corr, waitMs, trace), trace);
    }

    if (name === "wait") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_TOOL_DEFAULT_MS);
      return withDev(await waitForResult(deviceId, corr, waitMs, trace), trace);
    }

    if (name === "read_screen") {
      const corr = trimId(args.corr) || undefined;
      const deviceId = resolveDevice(args, { corr });
      const body = { device_id: deviceId };
      if (corr) body.corr = corr;
      const row = await callRpc(trace, "/v1/read_screen", body);
      return withDev(withDevice(row, deviceId), trace);
    }

    if (name === "type") {
      if (args.keys == null && args.key == null) throw new Error("keys or key required");
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId };
      if (args.keys != null) body.keys = args.keys;
      if (args.key != null && String(args.key) !== "") body.key = String(args.key);
      if (body.keys == null && body.key) body.keys = body.key;
      if (args.corr != null && String(args.corr) !== "") body.corr = args.corr;
      const row = await callRpc(trace, "/v1/type", body);
      return withDev(withDevice(row, deviceId), trace);
    }

    throw new Error(`unknown tool ${name}`);
  }

  return {
    tools,
    callTool,
    resolveDevice,
    currentDevice,
    getState: () => ({ lastUsed, lastCwd, envDefault, corrOwner }),
  };
}
