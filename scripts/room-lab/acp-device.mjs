// Deterministic ACP peer for the two-container lab. It really calls Fleet on the target device.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let config, pending;
async function tool(name, args) {
  const env = Object.fromEntries(config.env.map(({ name, value }) => [name, value]));
  const r = await fetch(env.FLEET_ROOM_RPC + "/tool", { method: "POST", headers: { authorization: `Bearer ${env.FLEET_ROOM_CAP}`, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
  const body = await r.json(); if (!r.ok) throw new Error(body.error); return body.result;
}
async function prompt(id) {
  try {
    let result = await tool("fleet_run", { command: "hostname" });
    for (let i = 0; i < 100 && ["pending", "running"].includes(result.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      result = await tool("fleet_result", { corr: result.corr });
    }
    if (pending !== id) return;
    send({ method: "session/update", params: { sessionId: "lab", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } } } });
    send({ id, result: { stopReason: "end_turn" } }); pending = null;
  } catch (e) { send({ id, error: { code: -32000, message: e.message } }); }
}
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === "session/new") { config = m.params.mcpServers[0]; send({ id: m.id, result: { sessionId: "lab" } }); }
  else if (m.method === "session/prompt") { pending = m.id; void prompt(m.id); }
  else if (m.method === "session/cancel" && pending) { send({ id: pending, result: { stopReason: "cancelled" } }); pending = null; }
}
