/**
 * MCP operator surface. Last-used lives in this process only.
 * Do not write hub_sessions, ~/.fleet, or a workspace file.
 */

/** MCP-call wait budget only. Not a kill timeout. Hosts cancel tools at ~60s. */
export const WAIT_DEFAULT_MS = 0;
export const WAIT_MAX_MS = 30_000;
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
        "Start a command on a device. wait_ms default 0: returns {corr,status:\"running\"} immediately (POST /v1/run is not held). If wait_ms>0 and the job finishes in time, return the same payload get_result would. If the budget expires, return {corr,status:\"running\"} — the command continues. Never kill on wait expiry. Never re-issue run after status=running; poll get_result(wait_ms) or wait(wait_ms).",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          device_id: deviceId,
          command: { type: "string" },
          wait_ms: waitMsSchema({ defaultMs: WAIT_DEFAULT_MS, role: "Optional." }),
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
      description: "Snapshot the pane. Does not attach or stream.",
      inputSchema: {
        type: "object",
        properties: { device_id: deviceId, corr: { type: "string" } },
      },
    },
    {
      name: "type",
      description: "Fire-and-forget keystrokes into the pane stdin.",
      inputSchema: {
        type: "object",
        required: ["keys"],
        properties: { device_id: deviceId, keys: { type: "string" }, corr: { type: "string" } },
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
  /** @type {Map<string, string>} */
  const corrOwner = new Map();
  const tools = buildTools();

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

  async function peekResult(deviceId, corr) {
    const row = await rpc("/v1/get_result", { device_id: deviceId, corr });
    return decorateResult(row, deviceId);
  }

  async function waitForResult(deviceId, corr, timeoutMs) {
    const budget = clampWaitMs(timeoutMs);
    let snapshot = await peekResult(deviceId, corr);
    if (isFinishedResult(snapshot) || budget <= 0) {
      return isFinishedResult(snapshot) ? snapshot : runningSnapshot(snapshot, corr, deviceId);
    }
    const deadline = now() + budget;
    while (now() < deadline) {
      if (isFinishedResult(snapshot)) return snapshot;
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(WAIT_POLL_MS, left));
      snapshot = await peekResult(deviceId, corr);
    }
    if (isFinishedResult(snapshot)) return snapshot;
    return runningSnapshot(snapshot, corr, deviceId);
  }

  async function callTool(name, rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};

    if (name === "list_computers") {
      return rpc("/v1/list_computers", {});
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
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_DEFAULT_MS);
      const wrapped = wrapSessionCommand(command, lastCwd);
      const started = await rpc("/v1/run", { device_id: deviceId, command: wrapped });
      const corr = started?.corr;
      rememberCorr(corr, deviceId);
      const out = withDevice({ ...started, corr, status: started?.status ?? "running" }, deviceId);
      if (waitMs <= 0) return out;
      return waitForResult(deviceId, corr, waitMs);
    }

    if (name === "get_result") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_DEFAULT_MS);
      if (waitMs <= 0) return peekResult(deviceId, corr);
      return waitForResult(deviceId, corr, waitMs);
    }

    if (name === "wait") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_TOOL_DEFAULT_MS);
      return waitForResult(deviceId, corr, waitMs);
    }

    if (name === "read_screen") {
      const corr = trimId(args.corr) || undefined;
      const deviceId = resolveDevice(args, { corr });
      const body = { device_id: deviceId };
      if (corr) body.corr = corr;
      const row = await rpc("/v1/read_screen", body);
      return withDevice(row, deviceId);
    }

    if (name === "type") {
      if (args.keys == null) throw new Error("keys required");
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId, keys: args.keys };
      if (args.corr != null && String(args.corr) !== "") body.corr = args.corr;
      const row = await rpc("/v1/type", body);
      return withDevice(row, deviceId);
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
