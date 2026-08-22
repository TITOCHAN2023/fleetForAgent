#!/usr/bin/env node
/**
 * Operator tool. Same two values as the agent: website origin + hub token.
 *
 *   FLEET_URL=https://your.app FLEET_TOKEN=flt_... node index.mjs list
 *   FLEET_URL=... FLEET_TOKEN=... node index.mjs run <device_id> 'uname -a'
 *
 * No extra args → MCP stdio (Cursor / other agents).
 */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOperator, FLEET_VERSION, formatMcpText } from "./operator.mjs";

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

const argv = process.argv.slice(2);
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

async function rpc(path, body) {
  if (!url || !token) {
    throw new Error("Need FLEET_URL and FLEET_TOKEN (env or ~/.fleet/mcp.env)");
  }
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
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
  const { tools, callTool } = createOperator({ rpc, env: process.env });

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
          reply(id, { content: [{ type: "text", text: formatMcpText(msg.params?.name, out) }] });
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
