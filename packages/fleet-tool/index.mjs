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
  fleetHubHeaders,
  formatMcpText,
  isFleetDev,
  measureHubFetch,
  newOperatorFingerprint,
} from "./operator.mjs";
import { highSecAuthorization } from "../fleet-worker/src/tokenv1.mjs";

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

async function hubHeaders() {
  const authorization = await highSecAuthorization(token, url);
  return fleetHubHeaders({ authorization, fingerprint: operatorFingerprint });
}

async function hubRpc(path, body, { timed = false } = {}) {
  if (!url || !token) {
    throw new Error("Need FLEET_URL and FLEET_TOKEN (env or ~/.fleet/mcp.env)");
  }
  const payload = body ?? {};
  const headers = await hubHeaders();
  if (timed && isFleetDev(process.env)) {
    const measured = await measureHubFetch(`${url}${path}`, {
      method: "POST",
      headers: { ...headers, "X-Fleet-Dev": "1" },
      body: { ...payload, dev: true },
    });
    if (!measured.ok) throw new Error(measured.json?.error || String(measured.status));
    return { __fleetTimed: true, json: measured.json, hop: { ...measured.hop, path } };
  }
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
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

async function rpc(path, body) {
  return hubRpc(path, body, { timed: false });
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
  throw new Error("commands: list | run | result | screen");
}

function mcp() {
  const { tools, callTool } = createOperator({
    rpc: (path, body) => hubRpc(path, body, { timed: true }),
    env: process.env,
  });

  const rl = readline();
  void (async () => {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "notifications/initialized") continue;
      const id = msg.id;
      try {
        if (msg.method === "initialize") {
          reply(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fleet", version: FLEET_VERSION },
          });
          continue;
        }
        if (msg.method === "tools/list") {
          reply(id, { tools });
          continue;
        }
        if (msg.method === "tools/call") {
          const out = await callTool(msg.params?.name, msg.params?.arguments ?? {});
          const payload = { content: [{ type: "text", text: formatMcpText(msg.params?.name, out, process.env) }] };
          const b64 =
            out &&
            out.ok === true &&
            typeof out.image_b64 === "string" &&
            out.image_b64.length > 0
              ? out.image_b64
              : "";
          if (b64) {
            payload.content.push({
              type: "image",
              mimeType: out.mime || "image/jpeg",
              data: b64,
            });
          }
          if (out && typeof out === "object" && (out.isError === true || out.ok === false)) {
            payload.isError = true;
          }
          if (out && typeof out === "object" && out.dev && Number.isFinite(out.dev.total_ms)) {
            payload._meta = { duration_ms: out.dev.total_ms, fleet_dev: out.dev };
          }
          reply(id, payload);
          continue;
        }
        reply(id, {});
      } catch (err) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }) + "\n",
        );
      }
    }
  })();
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
