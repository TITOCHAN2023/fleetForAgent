#!/usr/bin/env node
import { createInterface } from "node:readline";

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
export const ROOM_TOOLS = [
  { name: "room_read", description: "Read the current Room discussion before replying; follow nextCursor while hasMore.", inputSchema: object({ afterSeq: { type: "integer" }, limit: { type: "integer" } }) },
  { name: "room_send", description: "Reply against the context revision you actually read. Optional toAgentId wakes one existing member.", inputSchema: object({ text: str, expectedContextRev: { type: "integer" }, toAgentId: str }, ["text", "expectedContextRev"]) },
  { name: "room_agents", description: "List collaboration agents; only current Room members can receive tasks.", inputSchema: object({}) },
  { name: "room_delegate", description: "Delegate asynchronously to an existing Room member. Summarize and end your turn to wait for the child result.", inputSchema: object({ assigneeId: str, description: str, completionCriteria: str, deviceId: str }, ["assigneeId", "description", "completionCriteria"]) },
  { name: "room_task", description: "Read a task and its result in the current Room.", inputSchema: object({ taskId: str }, ["taskId"]) },
  { name: "fleet_run", description: "Run a command on the task's frozen target device, or explicitly override with an authorized deviceId.", inputSchema: object({ command: str, deviceId: str }, ["command"]) },
  { name: "fleet_result", description: "Read a Fleet command result; specify the same device used for the command.", inputSchema: object({ corr: str, deviceId: str }, ["corr"]) },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let m;
  try {
    if (Buffer.byteLength(line) > 32_000) continue;
    m = JSON.parse(line); if (m.id === undefined) continue;
    if (m.method === "initialize") reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fleet-room", version: "0.1.0" } });
    else if (m.method === "tools/list") reply(m.id, { tools: ROOM_TOOLS });
    else if (m.method === "ping") reply(m.id, {});
    else if (m.method === "tools/call") {
      if (!ROOM_TOOLS.some((t) => t.name === m.params?.name)) throw new Error("Unknown Room tool");
      const url = new URL(process.env.FLEET_ROOM_RPC);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Room capability endpoint must be loopback");
      const res = await fetch(`${url.origin}/tool`, { method: "POST", headers: { authorization: `Bearer ${process.env.FLEET_ROOM_CAP || ""}`, "content-type": "application/json" }, body: JSON.stringify(m.params), signal: AbortSignal.timeout(30_000) });
      const body = await res.json();
      reply(m.id, { content: [{ type: "text", text: JSON.stringify(body.result ?? body) }], isError: !res.ok });
    } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\n");
  } catch (e) {
    if (m?.id !== undefined) reply(m.id, { content: [{ type: "text", text: e.message }], isError: true });
  }
}
