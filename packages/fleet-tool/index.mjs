#!/usr/bin/env node
/**
 * Operator tool. Same two values as the agent: website origin + hub token.
 *
 *   FLEET_URL=https://your.app FLEET_TOKEN=flt_1... node index.mjs list
 *   FLEET_URL=... FLEET_TOKEN=... node index.mjs run <device_id> 'uname -a'
 *   node index.mjs --dev list
 *
 * No extra args → MCP stdio (Cursor / other agents). `--dev` sets FLEET_DEV=1.
 */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCliDevFlag,
  createOperator,
  FLEET_VERSION,
  fleetResultMeta,
  fleetHubHeaders,
  formatMcpText,
  isFleetDev,
  isDeviceTransportPath,
  MCP_INSTRUCTIONS,
  measureHubFetch,
  newOperatorFingerprint,
  officialPlugin,
  unwrapTimedRpc,
  wrapTransportRpc,
} from "./operator.mjs";
import { createRtcManager } from "./rtc.mjs";
import { createFileTransferManager } from "./file-transfer-rtc.mjs";
import { startAndWaitFileTransfer } from "./file-transfer-cli.mjs";
import { McpStdioCallManager } from "./mcp-protocol.mjs";
import {
  highSecAuthorization,
  verifyFleetStatement,
  verifyTokenV1,
} from "../fleet-worker/src/tokenv1.mjs";

const operatorFingerprint = newOperatorFingerprint();

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

loadDotEnv(join(homedir(), ".fleet", "mcp.env"));

const url = (process.env.FLEET_URL || "").replace(/\/$/, "");
const token = process.env.FLEET_TOKEN || "";

const argv = applyCliDevFlag(process.argv.slice(2), process.env);

async function hubHeaders({ signal } = {}) {
  signal?.throwIfAborted?.();
  const authorization = await highSecAuthorization(
    token,
    url,
    (input, init = {}) => fetch(input, { ...init, signal }),
  );
  signal?.throwIfAborted?.();
  return fleetHubHeaders({ authorization, fingerprint: operatorFingerprint });
}

async function rawHubRpc(path, body, { timed = false, signal } = {}) {
  if (!url || !token) {
    throw new Error("Need FLEET_URL and FLEET_TOKEN (env or ~/.fleet/mcp.env)");
  }
  const payload = body ?? {};
  signal?.throwIfAborted?.();
  const headers = await hubHeaders({ signal });
  if (timed && isFleetDev(process.env)) {
    const measured = await measureHubFetch(`${url}${path}`, {
      method: "POST",
      headers: { ...headers, "X-Fleet-Dev": "1" },
      body: { ...payload, dev: true },
      signal,
    });
    if (!measured.ok) throw new Error(measured.json?.error || String(measured.status));
    return { __fleetTimed: true, json: measured.json, hop: { ...measured.hop, path } };
  }
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error || json.code || res.statusText);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

const rtcManager = createRtcManager({
  hubPost: (path, body, options) => rawHubRpc(path, body, { timed: false, ...options }),
  token,
  operatorId: operatorFingerprint,
  verifyTokenV1,
  verifyFleetStatement,
  officialPlugin,
});

const fileTransferManager = createFileTransferManager({
  hubPost: (path, body, options) => rawHubRpc(path, body, { timed: false, ...options }),
  token,
  operatorId: operatorFingerprint,
  verifyTokenV1,
  verifyFleetStatement,
  hubOrigin: url,
  authorization: async (options) => (await hubHeaders(options)).authorization,
});

async function hubRpc(path, body, { timed = false, signal } = {}) {
  signal?.throwIfAborted?.();
  const direct = await rtcManager.tryRpc(path, body, { signal });
  if (direct.handled) {
    return wrapTransportRpc(direct.value, isDeviceTransportPath(path) ? direct.transport || "rtc" : null);
  }
  const relayed = await rawHubRpc(path, body, { timed, signal });
  return wrapTransportRpc(relayed, isDeviceTransportPath(path) ? "ws" : null);
}

async function rpc(path, body) {
  return unwrapTimedRpc(await hubRpc(path, body, { timed: false })).json;
}

if (argv.length) {
  if (!url || !token) {
    console.error("Need FLEET_URL and FLEET_TOKEN (env or ~/.fleet/mcp.env)");
    process.exit(1);
  }
  void cli(argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  mcp();
}

async function cli(args) {
  const [cmd, a, ...rest] = args;
  if (cmd === "list") {
    console.log(JSON.stringify(await rpc("/v1/list_computers", {}), null, 2));
    return;
  }
  if (cmd === "run") {
    if (!a || rest.length === 0) throw new Error("usage: run <device_id> <command>");
    const out = await rpc("/v1/run", { device_id: a, command: rest.join(" ") });
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === "result") {
    console.log(JSON.stringify(await rpc("/v1/get_result", { device_id: a, corr: rest[0] }), null, 2));
    return;
  }
  if (cmd === "screen") {
    console.log(JSON.stringify(await rpc("/v1/read_screen", { device_id: a, corr: rest[0] }), null, 2));
    return;
  }
  if (cmd === "send-file") {
    const [deviceId, targetDirectory] = rest;
    if (!a || !deviceId || !targetDirectory) {
      throw new Error("usage: send-file <local_source_path> <target_device_id> <target_directory>");
    }
    await runFileTransferCLI({
      source: { kind: "tool", path: a },
      target: { kind: "device", device_id: deviceId, directory: targetDirectory },
    });
    return;
  }
  if (cmd === "receive-file") {
    const [sourcePath, localDirectory] = rest;
    if (!a || !sourcePath || !localDirectory) {
      throw new Error("usage: receive-file <source_device_id> <source_path> <local_directory>");
    }
    await runFileTransferCLI({
      source: { kind: "device", device_id: a, path: sourcePath },
      target: { kind: "tool", directory: localDirectory },
    });
    return;
  }
  if (cmd === "transfer-file") {
    const [sourcePath, targetDeviceId, targetDirectory] = rest;
    if (!a || !sourcePath || !targetDeviceId || !targetDirectory) {
      throw new Error("usage: transfer-file <source_device_id> <source_path> <target_device_id> <target_directory>");
    }
    await runFileTransferCLI({
      source: { kind: "device", device_id: a, path: sourcePath },
      target: { kind: "device", device_id: targetDeviceId, directory: targetDirectory },
    });
    return;
  }
  if (cmd === "transfer-status") {
    if (!a) throw new Error("usage: transfer-status <transfer_id>");
    console.log(JSON.stringify(await fileTransferManager.status(a), null, 2));
    return;
  }
  if (cmd === "transfer-cancel") {
    if (!a) throw new Error("usage: transfer-cancel <transfer_id>");
    console.log(JSON.stringify(await fileTransferManager.cancel(a), null, 2));
    return;
  }
  throw new Error("commands: list | run | result | screen | send-file | receive-file | transfer-file | transfer-status | transfer-cancel");
}

async function runFileTransferCLI(input) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const terminate = () => void fileTransferManager.shutdown();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    let phase = "";
    const result = await startAndWaitFileTransfer(fileTransferManager, input, {
      signal: controller.signal,
      onProgress(value) {
        const next = value?.local?.phase || value?.phase || "unknown";
        if (next === phase) return;
        phase = next;
        process.stderr.write(`${JSON.stringify({ transfer_id: value?.transfer_id || value?.session_id, phase: next })}\n`);
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

function mcp() {
  const { tools, prompts, getPrompt, callTool } = createOperator({
    rpc: (path, body, options) => hubRpc(path, body, { timed: true, ...options }),
    fileTransfer: fileTransferManager,
    env: process.env,
  });
  const calls = new McpStdioCallManager({
    shutdown: async () => {
      await Promise.allSettled([fileTransferManager.shutdown(), rtcManager.shutdown()]);
    },
  });

  const rl = readline();
  void (async () => {
    try {
      for await (const line of rl) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "notifications/cancelled") {
        const rid = msg.params?.requestId == null ? "" : String(msg.params.requestId);
        if (rid) calls.cancel(rid);
        continue;
      }
      if (msg.method === "notifications/initialized") continue;
      const id = msg.id;
      try {
        if (msg.method === "initialize") {
          reply(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "fleet", version: FLEET_VERSION },
            instructions: MCP_INSTRUCTIONS,
          });
          continue;
        }
        if (msg.method === "prompts/list") {
          reply(id, { prompts });
          continue;
        }
        if (msg.method === "prompts/get") {
          const prompt = getPrompt(msg.params?.name);
          if (!prompt) throw new Error(`unknown prompt ${msg.params?.name}`);
          reply(id, prompt);
          continue;
        }
        if (msg.method === "tools/list") {
          reply(id, { tools });
          continue;
        }
        if (msg.method === "tools/call") {
          const reqId = String(id);
          const progressToken = msg.params?._meta?.progressToken ?? id;
          const name = msg.params?.name;
          const args = msg.params?.arguments ?? {};
          const pending = calls.run(async (signal) => {
            const out = await callTool(name, args, {
              signal,
              isCancelled: () => signal.aborted,
              onProgress: ({ progress, total }) => {
                calls.write(() => notify("notifications/progress", { progressToken, progress, total }));
              },
            });
            const text = { type: "text", text: formatMcpText(name, out, process.env) };
            const b64 =
              out &&
              out.ok === true &&
              typeof out.image_b64 === "string" &&
              out.image_b64.length > 0
                ? out.image_b64
                : "";
            const content = [];
            if (b64) {
              content.push({
                type: "image",
                mimeType: out.mime || "image/jpeg",
                data: b64,
              });
            }
            content.push(text);
            const payload = { content };
            if (out && typeof out === "object" && (out.isError === true || out.ok === false)) {
              payload.isError = true;
            }
            const meta = fleetResultMeta(out) || {};
            if (out && typeof out === "object" && out.dev && Number.isFinite(out.dev.total_ms)) {
              Object.assign(meta, { duration_ms: out.dev.total_ms, fleet_dev: out.dev });
            }
            if (Object.keys(meta).length > 0) payload._meta = meta;
            return payload;
          }, { key: reqId });
          void pending.then(
            (payload) => calls.write(() => reply(id, payload)),
            (err) => calls.write(() => {
              process.stdout.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
                }) + "\n",
              );
            }),
          );
          continue;
        }
        reply(id, {});
      } catch (err) {
        calls.write(() => {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            }) + "\n",
          );
        });
      }
      }
    } finally {
      await calls.close();
    }
  })();
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function readline() {
  return {
    async *[Symbol.asyncIterator]() {
      let buf = "";
      for await (const chunk of process.stdin) {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          yield line;
        }
      }
    },
  };
}
