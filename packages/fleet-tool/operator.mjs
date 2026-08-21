/**
 * MCP operator surface. Last-used lives in this process only.
 * Do not write hub_sessions, ~/.fleet, or a workspace file.
 */

export const WAIT_MIN_MS = 1000;
export const WAIT_MAX_MS = 5 * 60 * 1000;
export const WAIT_TOOL_DEFAULT_MS = 30_000;
export const WAIT_POLL_MS = 100;

export const MISSING_DEVICE_MESSAGE =
  "device_id required — pass device_id or call set_computer";

export function clampWaitMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return WAIT_MIN_MS;
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, n));
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
  return { ...extra, corr, status: "running", device_id: deviceId };
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
        "Start a command on a device. Without wait_ms, returns {corr,status:\"running\"} immediately (job stays on the device). Optional wait_ms blocks this call up to that many ms (clamped 1s–5min); if still running, returns the corr handle plus any snapshot. Does not kill the job on timeout.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          device_id: deviceId,
          command: { type: "string" },
          wait_ms: {
            type: "number",
            description: "Optional. If set, wait up to this many ms (clamped 1s–5min) before returning. Default is immediate corr — do not omit this and then poll get_result in a loop; use wait.",
          },
        },
      },
    },
    {
      name: "get_result",
      description: "Non-blocking peek of a previous run by corr. Use wait to block server-side.",
      inputSchema: {
        type: "object",
        required: ["corr"],
        properties: { device_id: deviceId, corr: { type: "string" } },
      },
    },
    {
      name: "wait",
      description:
        "Block until a run finishes or timeout_ms elapses (default 30s, clamped 1s–5min). Polls get_result. Does not kill the job. Returns the full result if done, or {corr,status:\"running\"} plus any snapshot.",
      inputSchema: {
        type: "object",
        required: ["corr"],
        properties: {
          corr: { type: "string" },
          device_id: deviceId,
          timeout_ms: { type: "number" },
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
      description: "Show this process's last-used device and FLEET_DEVICE_ID start default.",
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

  async function peekResult(deviceId, corr) {
    const row = await rpc("/v1/get_result", { device_id: deviceId, corr });
    return withDevice(row, deviceId);
  }

  async function waitForResult(deviceId, corr, timeoutMs) {
    const budget = clampWaitMs(timeoutMs);
    const deadline = now() + budget;
    let snapshot = { corr, status: "running", device_id: deviceId };
    while (now() < deadline) {
      snapshot = await peekResult(deviceId, corr);
      if (isFinishedResult(snapshot)) return snapshot;
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(WAIT_POLL_MS, left));
    }
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
      };
    }

    if (name === "run") {
      const command = args.command == null ? "" : String(args.command);
      if (!command) throw new Error("command required");
      const deviceId = resolveDevice(args);
      const waitMs = parseOptionalMs(args.wait_ms, "wait_ms");
      const started = await rpc("/v1/run", { device_id: deviceId, command });
      const corr = started?.corr;
      rememberCorr(corr, deviceId);
      const out = withDevice({ ...started, corr, status: started?.status ?? "running" }, deviceId);
      if (waitMs == null) return out;
      return waitForResult(deviceId, corr, waitMs);
    }

    if (name === "get_result") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      return peekResult(deviceId, corr);
    }

    if (name === "wait") {
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const deviceId = resolveDevice(args, { corr });
      const timeoutMs = parseOptionalMs(args.timeout_ms, "timeout_ms") ?? WAIT_TOOL_DEFAULT_MS;
      return waitForResult(deviceId, corr, timeoutMs);
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
    getState: () => ({ lastUsed, envDefault, corrOwner }),
  };
}
