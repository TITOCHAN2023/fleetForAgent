import { OFFICIAL_PLUGIN_CATALOG as GENERATED_PLUGIN_CATALOG, PLUGIN_REGISTRY_SOURCE } from "./official-plugins.generated.mjs";

/**
 * MCP operator surface. Last-used lives in this process only.
 * Do not write hub_sessions, ~/.fleet, or a workspace file.
 */

export const FLEET_VERSION = "0.5.0";

export { PLUGIN_REGISTRY_SOURCE };
export const OFFICIAL_PLUGIN_CATALOG = GENERATED_PLUGIN_CATALOG;

function installManifest(plugin) {
  return Object.freeze({
    schema_version: plugin.schema_version,
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    publisher: plugin.publisher,
    license: plugin.license,
    description: plugin.description.en,
    repository: plugin.repository,
    actions: plugin.actions,
    artifacts: plugin.artifacts,
  });
}

// Backward-compatible install manifests. Catalog-only entries live in
// OFFICIAL_PLUGIN_CATALOG and are never sent to a device.
export const OFFICIAL_PLUGINS = Object.freeze(
  OFFICIAL_PLUGIN_CATALOG.filter((plugin) => plugin.installable).map(installManifest),
);

export function officialPlugin(id) {
  return OFFICIAL_PLUGINS.find((plugin) => plugin.id === String(id || "").trim()) || null;
}

export function publicOfficialPlugins() {
  return OFFICIAL_PLUGIN_CATALOG.map((plugin) => ({
    schema_version: plugin.schema_version,
    id: plugin.id,
    order: plugin.order,
    name: plugin.name,
    version: plugin.version,
    publisher: plugin.publisher,
    license: plugin.license,
    repository: plugin.repository,
    homepage: plugin.homepage,
    categories: plugin.categories,
    description: plugin.description.en,
    descriptions: plugin.description,
    installable: plugin.installable,
    actions: plugin.actions,
    platforms: plugin.artifacts.map(({ os, arch }) => ({ os, arch })),
  }));
}

/** MCP-process fingerprint. HTTP header only — never a tool argument. */
export const FLEET_OPERATOR_HEADER = "X-Fleet-Operator";

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

export const MCP_INSTRUCTIONS =
  "Fleet: remote Windows/Linux/macOS machines via a cloud hub. list_computers, then set_computer (or pass device_id). run waits up to 30s; if the text is still running, call wait — do not run again. Official plugins are installed with install_plugin and always require approval at the device; poll get_plugin_task with its corr. delegate_to_acp uses the official fleet.acp bridge after configure_acp. Hub tokens are flt_1 values minted in website Settings. Stdio uses Fleet-OAEP; remote /mcp uses Streamable HTTP and /mcp/sse keeps classic SSE compatibility.";

export function buildPrompts() {
  return [
    {
      name: "hub_token",
      description: "How to generate or reset a Fleet hub token in Settings, and what reset does to old keys.",
    },
    {
      name: "hub_token_anatomy",
      description: "How a flt_1 hub token is composed (prefix, signed payload, RSA-2048) and how Fleet-OAEP is used instead of Bearer.",
    },
  ];
}

export function getPrompt(name) {
  if (name === "hub_token") {
    return {
      description: "Generate or reset a hub token",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Generate or reset a Fleet hub token on the website Settings page, not through this MCP server.",
              "",
              "- Sign in with Google or X (cookie session).",
              "- Settings → Generate token (first time) or Reset token (replaces the key).",
              "- Plaintext is shown once. Copy FLEET_TOKEN now. FLEET_URL is the site origin.",
              "- Reset revokes the old key first, sends a signed notice, then closes every live device WebSocket and direct RTC session. Re-paste the new token on every Agent and MCP client.",
              "- Do not put the token in git or wrangler [vars].",
            ].join("\n"),
          },
        },
      ],
    };
  }
  if (name === "hub_token_anatomy") {
    return {
      description: "flt_1 token composition",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "A Fleet hub token is flt_1.<payload>.<sig> (RSA-2048).",
              "",
              "- payload JSON, signed RSA-PSS-SHA256: v, aud, kid, pub, iat, sec",
              "- aud is HUB_ORIGIN (https://fleet.ginfo.cc), never the HTTP Host header",
              "- Agents and stdio MCP GET /v1/challenge?kid=… then send Authorization: Fleet-OAEP <kid>.<oaep({sec,nonce})>",
              "- Remote /mcp uses Streamable HTTP with Authorization: Bearer <token> and an opaque Mcp-Session-Id response header",
              "- Classic /mcp/sse sends Bearer once to open a server-side session; its random message URL contains no token",
              "- Reset mints a new keypair; the old kid will not complete the handshake",
            ].join("\n"),
          },
        },
      ],
    };
  }
  return null;
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

/** One UUID per MCP stdio process. Do not read FLEET_OPERATOR or any model-filled env. */
export function newOperatorFingerprint() {
  return crypto.randomUUID();
}

export function fleetHubHeaders({ token, authorization, fingerprint, extra } = {}) {
  const headers = {
    authorization: authorization || (token ? `Bearer ${token}` : ""),
    "content-type": "application/json",
    ...extra,
  };
  if (fingerprint) headers[FLEET_OPERATOR_HEADER] = fingerprint;
  return headers;
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

const RESULT_TRANSPORT = Symbol("fleet.result.transport");
const DEVICE_TRANSPORT_PATHS = new Set([
  "/v1/heartbeat",
  "/v1/run",
  "/v1/get_result",
  "/v1/read_screen",
  "/v1/type",
  "/v1/desktop_screenshot",
  "/v1/desktop_action",
  "/v1/plugin",
  "/v1/plugin_result",
]);

function normalizeTransport(value) {
  return value === "rtc" || value === "ws" ? value : null;
}

export function isDeviceTransportPath(path) {
  return DEVICE_TRANSPORT_PATHS.has(path);
}

/** Internal RPC wrapper. Transport provenance never enters the Fleet v1 envelope. */
export function wrapTransportRpc(raw, transport) {
  const normalized = normalizeTransport(transport);
  if (!normalized) return raw;
  if (raw && typeof raw === "object" && raw.__fleetTimed) {
    return {
      __fleetTransportRpc: true,
      json: raw.json,
      hop: raw.hop,
      transport: normalized,
    };
  }
  return {
    __fleetTransportRpc: true,
    json: raw,
    hop: null,
    transport: normalized,
  };
}

export function unwrapTimedRpc(raw) {
  if (raw && typeof raw === "object" && raw.__fleetTransportRpc) {
    return {
      json: raw.json,
      hop: raw.hop ?? null,
      transport: normalizeTransport(raw.transport),
    };
  }
  if (raw && typeof raw === "object" && raw.__fleetTimed) {
    return { json: raw.json, hop: raw.hop, transport: null };
  }
  return { json: raw, hop: null, transport: null };
}

function markResultTransport(out, transport) {
  const normalized = normalizeTransport(transport);
  if (normalized && out && (typeof out === "object" || typeof out === "function")) {
    Object.defineProperty(out, RESULT_TRANSPORT, {
      value: normalized,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return out;
}

/** Per-result lookup avoids a process-global "last transport" race between MCP calls. */
export function resultTransport(out) {
  if (!out || (typeof out !== "object" && typeof out !== "function")) return null;
  return normalizeTransport(out[RESULT_TRANSPORT]);
}

export function fleetResultMeta(out) {
  const transport = resultTransport(out);
  return transport ? { fleet_transport: transport } : null;
}

/** MCP content text. Shell tools (run / get_result / wait) are human output, not JSON.stringify of the envelope. */
export function formatMcpText(name, out, env = {}) {
  let text;
  if (!SHELL_RESULT_TOOLS.has(name)) {
    if (out == null) text = "";
    else if (typeof out === "string") text = out;
    else if (typeof out === "object") {
      const { timing: _timing, dev: _dev, image_b64: _img, ...rest } = out;
      text = JSON.stringify(rest);
    } else text = JSON.stringify(out);
  } else if (!out || typeof out !== "object") {
    text = out == null ? "" : String(out);
  } else if (!isFinishedResult(out)) {
    text = "still running";
  } else {
    const stdout = nonemptyText(out.stdout);
    const err = nonemptyText(out.error) || nonemptyText(out.stderr);
    const code = out.exit_code;
    const failed = out.ok === false || (code != null && Number(code) !== 0);
    if (!failed) {
      text = stdout;
      if (err !== "") {
        text = text === "" ? err : (text.endsWith("\n") ? text : text + "\n") + err;
      }
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
      `${role} MCP-call wait budget in milliseconds. Default ${defaultMs}. Capped at ${WAIT_MAX_MS} (30s) so the host cannot cancel with -32001 (clients ~60s). wait_ms never kills the remote command. A still-running reply is not an error — do not re-issue run; long-poll with get_result(wait_ms) or wait(wait_ms). Do not spam wait_ms=0.`,
  };
}

export function buildTools() {
  const deviceId = { type: "string", description: "Target machine. Optional after set_computer or a prior explicit device_id in this process. FLEET_DEVICE_ID is a start-of-process default only." };
  return [
    {
      name: "list_computers",
      description: "List machines in this hub account (id, name, os, online, lastSeen, agentVer). Never returns IPs. Call this first, then set_computer.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_computer",
      description:
        "Status of one machine from the same catalog as list_computers: online, lastSeen, agentVer, name, os. Never returns IPs. Optional device_id after set_computer or a prior explicit device_id in this process.",
      inputSchema: {
        type: "object",
        properties: { device_id: deviceId },
      },
    },
    {
      name: "heartbeat",
      description:
        "Ask a connected agent to report presence now. The hub stores lastSeen and agentVer from the reply so a just-upgraded client shows the new version. 409 if the device is offline or does not heartbeat. Optional device_id after set_computer. Do not invent a device id.",
      inputSchema: {
        type: "object",
        properties: { device_id: deviceId },
      },
    },
    {
      name: "run",
      description:
        "Run a shell command on a fleet machine. Default wait_ms 30000. wait_ms=0 returns immediately while the job keeps running. If the result is still running, call wait — do not run the same command again. wait_ms never kills the remote process.",
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
        "Snapshot this process's live session. wait_ms omitted/0 is instant; wait_ms>0 long-polls (max 30s). still running is not an error — poll again, do not re-run.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          wait_ms: waitMsSchema({ defaultMs: WAIT_DEFAULT_MS, role: "Optional." }),
        },
      },
    },
    {
      name: "wait",
      description:
        "Block until this process's live session finishes or wait_ms elapses (default 30s). Does not kill the remote command. still running → poll again, do not re-run.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          wait_ms: waitMsSchema({ defaultMs: WAIT_TOOL_DEFAULT_MS, role: "Explicit block." }),
        },
      },
    },
    {
      name: "read_screen",
      description: "Snapshot this process's pane current frame (rendered grid on a live PTY). Does not attach or stream.",
      inputSchema: {
        type: "object",
        properties: { device_id: deviceId },
      },
    },
    {
      name: "type",
      description:
        "Fire-and-forget keystrokes into this process's pane stdin. keys is a string (newlines become Enter/CR on the live PTY). Optional key is a named press like ssh_press: enter, ctrl+c, up. ctrl+c sends 0x03 and SIGINT to the foreground process group.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          keys: { type: "string", description: "Literal keystrokes. Still accepted. Newlines become CR on the live PTY." },
          key: { type: "string", description: "Named key (enter, ctrl+c, up, f5, ...). Optional; do not invent a sixth tool." },
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
    {
      name: "desktop_screenshot",
      description:
        "Capture the device primary display as a JPEG. Coordinates are pixels of this image, origin top-left. Requires get_computer.caps to include computer_use (Windows/macOS/Linux screenshot from Agent 0.3.0). Not the pane tool read_screen. Optional device_id after set_computer.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          max_width: { type: "number", description: "Viewport long-edge cap. Agent clamps to 320–1920, default 1280." },
          max_height: { type: "number" },
        },
      },
    },
    {
      name: "desktop_action",
      description:
        "HID on the primary display. x,y required for click/move/drag/scroll (pixels of the last screenshot, top-left origin, not native). left_click_drag also needs x2,y2. Actions: screenshot, left_click, right_click, double_click, middle_click, mouse_move, left_click_drag, scroll, type, key, wait. Optional frame_id from the screenshot. Requires computer_use. Not the pane tool type. Optional device_id after set_computer.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: deviceId,
          action: {
            type: "string",
            description: "screenshot | left_click | right_click | double_click | middle_click | mouse_move | left_click_drag | scroll | type | key | wait",
          },
          x: { type: "number" },
          y: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          text: { type: "string" },
          key: { type: "string" },
          keys: { description: "Named keys array, same as key joined with +" },
          scroll_x: { type: "number" },
          scroll_y: { type: "number" },
          duration_ms: { type: "number" },
          frame_id: { type: "string" },
        },
        required: ["action"],
      },
    },
    {
      name: "list_official_plugins",
      description: "List the signed-by-registry official Fleet plugins available to install. This is local catalog data and does not contact a device.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_plugins",
      description: "Ask a remote Fleet Agent for its installed plugins. Returns a corr ticket; call get_plugin_task with that corr.",
      inputSchema: { type: "object", properties: { device_id: deviceId } },
    },
    {
      name: "install_plugin",
      description: "Install or upgrade one official plugin by registry id. The hub supplies the approved URL and SHA-256; arbitrary URLs are not accepted. Always requires confirmation on the device. Returns a corr ticket.",
      inputSchema: {
        type: "object",
        required: ["plugin_id"],
        properties: { device_id: deviceId, plugin_id: { type: "string", description: "Official id from list_official_plugins, for example fleet.acp." } },
      },
    },
    {
      name: "uninstall_plugin",
      description: "Remove an installed official plugin and its private plugin data from the device. Always requires device confirmation. Returns a corr ticket.",
      inputSchema: {
        type: "object",
        required: ["plugin_id"],
        properties: { device_id: deviceId, plugin_id: { type: "string" } },
      },
    },
    {
      name: "invoke_plugin",
      description: "Invoke an action exposed by an installed official plugin. Device permit rules apply. Returns a corr ticket; poll get_plugin_task.",
      inputSchema: {
        type: "object",
        required: ["plugin_id", "action"],
        properties: {
          device_id: deviceId,
          plugin_id: { type: "string" },
          action: { type: "string" },
          input: { type: "object", additionalProperties: true },
          timeout_seconds: { type: "number", minimum: 1, maximum: 3600 },
        },
      },
    },
    {
      name: "get_plugin_task",
      description: "Read an install, uninstall, inventory, or plugin-action ticket. waiting_approval/running means poll this same corr; never submit the action again.",
      inputSchema: {
        type: "object",
        required: ["corr"],
        properties: { device_id: deviceId, corr: { type: "string" } },
      },
    },
    {
      name: "configure_acp",
      description: "Configure a named local ACP-agent stdio command for the installed fleet.acp plugin. This does not install that third-party ACP agent. Device permit rules apply; returns a corr ticket.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          device_id: deviceId,
          profile: { type: "string", default: "default" },
          command: { type: "string", description: "ACP-compatible executable already installed on the remote device." },
          args: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "delegate_to_acp",
      description: "Delegate one task to a configured ACP v1 agent on the remote machine. It runs initialize, session/new, and session/prompt and returns the streamed agent text through get_plugin_task. Nested ACP tool permissions reject by default; permission_mode=allow_once selects only an explicit allow_once option.",
      inputSchema: {
        type: "object",
        required: ["cwd", "prompt"],
        properties: {
          device_id: deviceId,
          profile: { type: "string", default: "default" },
          cwd: { type: "string", description: "Absolute workspace path on the remote device." },
          prompt: { type: "string" },
          additional_directories: { type: "array", items: { type: "string" } },
          permission_mode: { type: "string", enum: ["reject", "allow_once"], default: "reject" },
          timeout_seconds: { type: "number", minimum: 1, maximum: 3600, default: 900 },
        },
      },
    },
  ];
}

export function desktopMcpRow(row) {
  if (!row || typeof row !== "object") {
    return { ok: false, status: "error", code: "bad_request", error: "empty desktop reply", isError: true };
  }
  const out = { ...row, isError: row.ok === false || row.isError === true };
  return out;
}

async function desktopCall(trace, path, body, callRpc) {
  try {
    const row = await callRpc(trace, path, body);
    return desktopMcpRow(row);
  } catch (err) {
    if (err && typeof err === "object" && err.json) {
      return desktopMcpRow({
        ok: false,
        status: "error",
        code: err.json.code || "http_error",
        error: err.json.error || err.message,
        missing: err.json.missing,
        agentVer: err.json.agentVer,
        os: err.json.os,
        http_status: err.status,
        isError: true,
      });
    }
    throw err;
  }
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
  state = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof rpc !== "function") throw new Error("rpc required");

  let lastUsed = trimId(state.lastUsed) || null;
  let lastCwd = trimId(state.lastCwd) || null;
  const envDefault = trimId(env.FLEET_DEVICE_ID) || null;
  const fleetDev = isFleetDev(env);
  const tools = buildTools();

  function newTrace() {
    return { hops: [], started: now(), sleep_ms: 0, startedRow: null, transport: null };
  }

  async function callRpc(trace, path, body) {
    const payload = fleetDev && body && typeof body === "object" ? { ...body, dev: true } : body;
    const t_out = now();
    const raw = await rpc(path, payload);
    const t_in = now();
    const { json: row, hop: measured, transport } = unwrapTimedRpc(raw);
    if (trace && transport) trace.transport = transport;
    if (!trace) return row;
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
    let result = out;
    if (fleetDev && trace) {
      const hops = trace.hops.slice();
      const runHop = hops.find((h) => h.path === "/v1/run");
      const getHops = hops.filter((h) => h.path === "/v1/get_result");
      const startT = rowTime(trace.startedRow);
      const doneT = rowTime(out);
      const run_ms = startT != null && doneT != null ? doneT - startT : null;
      const client_run_gap_ms = runHop && getHops[0] ? getHops[0].t_in - runHop.t_out : null;
      result = {
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
    return markResultTransport(result, trace?.transport);
  }

  function currentDevice() {
    if (lastUsed) return { device_id: lastUsed, source: "last_used" };
    if (envDefault) return { device_id: envDefault, source: "env" };
    return { device_id: null, source: "none" };
  }

  function resolveDevice(args = {}) {
    const explicit = trimId(args.device_id);
    if (explicit) {
      lastUsed = explicit;
      return explicit;
    }
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

  async function peekResult(deviceId, trace, waitMs = 0) {
    const body = { device_id: deviceId };
    if (waitMs > 0) body.wait_ms = waitMs;
    const row = await callRpc(trace, "/v1/get_result", body);
    return decorateResult(row, deviceId);
  }

  async function waitForResult(deviceId, timeoutMs, trace, corr, hooks) {
    const budget = clampWaitMs(timeoutMs);
    const startedAt = now();
    const deadline = startedAt + budget;
    let snapshot = await peekResult(deviceId, trace, 0);
    if (isFinishedResult(snapshot) || budget <= 0) {
      return isFinishedResult(snapshot) ? snapshot : runningSnapshot(snapshot, corr, deviceId);
    }
    while (now() < deadline) {
      if (isFinishedResult(snapshot)) return snapshot;
      if (hooks?.isCancelled?.()) return runningSnapshot(snapshot, corr, deviceId);
      const left = deadline - now();
      if (left <= 0) break;
      hooks?.onProgress?.({ progress: budget - left, total: budget });
      const sl = Math.min(WAIT_POLL_MS, left);
      if (trace) trace.sleep_ms += sl;
      await sleep(sl);
      snapshot = await peekResult(deviceId, trace, 0);
    }
    if (isFinishedResult(snapshot)) return snapshot;
    return runningSnapshot(snapshot, corr, deviceId);
  }

  async function execOnDevice(deviceId, command, waitMs, trace, hooks) {
    const body = { device_id: deviceId, command };
    const t0 = now();
    const started = await callRpc(trace, "/v1/run", body);
    const corr = started?.corr;
    if (waitMs <= 0) {
      return withDevice({ ...started, corr, status: started?.status ?? "running" }, deviceId);
    }
    const finished = decorateResult({ ...started, corr }, deviceId);
    if (isFinishedResult(started) || isFinishedResult(finished)) return finished;
    const left = waitMs - Math.max(0, now() - t0);
    if (left <= 0) return runningSnapshot(started, corr, deviceId);
    return waitForResult(deviceId, left, trace, corr, hooks);
  }

  async function callTool(name, rawArgs, hooks = {}) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const trace = newTrace();

    if (name === "list_computers") {
      const row = await callRpc(trace, "/v1/list_computers", {});
      return withDev(row, trace);
    }

    if (name === "get_computer") {
      const deviceId = resolveDevice(args);
      const row = await callRpc(trace, "/v1/get_computer", { device_id: deviceId });
      return withDev(withDevice(row, deviceId), trace);
    }

    if (name === "heartbeat") {
      const deviceId = resolveDevice(args);
      const row = await callRpc(trace, "/v1/heartbeat", { device_id: deviceId });
      return withDev(withDevice(row, deviceId), trace);
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
      return withDev(await execOnDevice(deviceId, command, waitMs, trace, hooks), trace);
    }

    if (name === "get_result") {
      const deviceId = resolveDevice(args);
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_DEFAULT_MS);
      if (waitMs <= 0) return withDev(await peekResult(deviceId, trace), trace);
      return withDev(await waitForResult(deviceId, waitMs, trace, undefined, hooks), trace);
    }

    if (name === "wait") {
      const deviceId = resolveDevice(args);
      const waitMs = clampWaitMs(parseOptionalMs(args.wait_ms, "wait_ms") ?? WAIT_TOOL_DEFAULT_MS);
      return withDev(await waitForResult(deviceId, waitMs, trace, undefined, hooks), trace);
    }

    if (name === "read_screen") {
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId };
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
      const row = await callRpc(trace, "/v1/type", body);
      return withDev(withDevice(row, deviceId), trace);
    }

    if (name === "desktop_screenshot") {
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId };
      if (args.max_width != null) body.max_width = args.max_width;
      if (args.max_height != null) body.max_height = args.max_height;
      const row = await desktopCall(trace, "/v1/desktop_screenshot", body, callRpc);
      return withDev(withDevice(row, deviceId), trace);
    }

    if (name === "desktop_action") {
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId, action: args.action };
      for (const k of ["x", "y", "x2", "y2", "text", "key", "keys", "scroll_x", "scroll_y", "duration_ms", "frame_id"]) {
        if (args[k] != null) body[k] = args[k];
      }
      if (body.key && body.keys) {
        // key wins when both are set
        delete body.keys;
      }
      const row = await desktopCall(trace, "/v1/desktop_action", body, callRpc);
      return withDev(withDevice(row, deviceId), trace);
    }

    if (name === "list_official_plugins") {
      return { registry: PLUGIN_REGISTRY_SOURCE, plugins: publicOfficialPlugins() };
    }

    if (name === "get_plugin_task") {
      const deviceId = resolveDevice(args);
      const corr = trimId(args.corr);
      if (!corr) throw new Error("corr required");
      const row = await callRpc(trace, "/v1/plugin_result", { device_id: deviceId, corr });
      return withDev(withDevice(row, deviceId), trace);
    }

    if (["list_plugins", "install_plugin", "uninstall_plugin", "invoke_plugin", "configure_acp", "delegate_to_acp"].includes(name)) {
      const deviceId = resolveDevice(args);
      const body = { device_id: deviceId };
      if (name === "list_plugins") body.operation = "list";
      if (name === "install_plugin" || name === "uninstall_plugin") {
        const pluginId = trimId(args.plugin_id);
        if (!pluginId) throw new Error("plugin_id required");
        body.operation = name === "install_plugin" ? "install" : "uninstall";
        body.plugin_id = pluginId;
      }
      if (name === "invoke_plugin") {
        const pluginId = trimId(args.plugin_id);
        const action = trimId(args.action);
        if (!pluginId || !action) throw new Error("plugin_id and action required");
        Object.assign(body, { operation: "invoke", plugin_id: pluginId, action, input: args.input || {} });
        if (args.timeout_seconds != null) body.timeout_seconds = args.timeout_seconds;
      }
      if (name === "configure_acp") {
        const command = trimId(args.command);
        if (!command) throw new Error("command required");
        Object.assign(body, {
          operation: "invoke", plugin_id: "fleet.acp", action: "configure",
          input: { profile: trimId(args.profile) || "default", command, args: Array.isArray(args.args) ? args.args : [] },
        });
      }
      if (name === "delegate_to_acp") {
        const cwd = trimId(args.cwd);
        const prompt = args.prompt == null ? "" : String(args.prompt).trim();
        if (!cwd || !prompt) throw new Error("cwd and prompt required");
        Object.assign(body, {
          operation: "invoke", plugin_id: "fleet.acp", action: "delegate",
          input: {
            profile: trimId(args.profile) || "default", cwd, prompt,
            additional_directories: Array.isArray(args.additional_directories) ? args.additional_directories : [],
            permission_mode: args.permission_mode === "allow_once" ? "allow_once" : "reject",
            timeout_seconds: args.timeout_seconds == null ? 900 : args.timeout_seconds,
          },
          timeout_seconds: args.timeout_seconds == null ? 900 : args.timeout_seconds,
        });
      }
      const row = await callRpc(trace, "/v1/plugin", body);
      return withDev(withDevice(row, deviceId), trace);
    }

    throw new Error(`unknown tool ${name}`);
  }

  return {
    tools,
    prompts: buildPrompts(),
    getPrompt,
    callTool,
    resolveDevice,
    currentDevice,
    getState: () => ({ lastUsed, lastCwd, envDefault }),
  };
}
