import { createInterface } from "node:readline";
const id = `runner-fixture-${process.pid}`;
let promptId, servers = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const finish = (text) => {
  send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  send({ id: promptId, result: { stopReason: "end_turn" } }); promptId = null;
};
async function tool(name, args = {}) {
  const env = Object.fromEntries(servers[0].env.map(({ name, value }) => [name, value]));
  const response = await fetch(`${env.FLEET_ROOM_RPC}/tool`, { method: "POST", headers: {
    authorization: `Bearer ${env.FLEET_ROOM_CAP}`, "content-type": "application/json",
  }, body: JSON.stringify({ name, arguments: args }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.code || body.error);
  return body.result;
}
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") { servers = m.params.mcpServers; send({ id: m.id, result: { sessionId: id } }); }
  if (m.method === "session/prompt") {
    promptId = m.id;
    const text = m.params.prompt[0].text;
    try {
      if (text.includes("CANCEL_WAIT")) {
        const discussion = await tool("room_read");
        await tool("room_send", { text: `ACP_STARTED_${process.pid}`, expectedContextRev: discussion.contextRev });
        continue;
      }
      if (text.includes("DELEGATE_THREE")) {
        if (text.includes("RESUME from checkpoint")) {
          finish([0, 1, 2].every((n) => text.includes(`CHILD_TAIL_${n}`)) ? "PARENT_RESUME_OK" : "TRUNCATED_CHILD_CONTEXT");
        } else {
          for (let i = 0; i < 3; i++) await tool("room_delegate", { assigneeId: "leader", description: `CHILD_${i}`, completionCriteria: "Return the child result" });
          finish("Waiting for children");
        }
      } else if (/Task: CHILD_\d/.test(text)) {
        const n = text.match(/Task: CHILD_(\d)/)[1]; finish("x".repeat(14500) + `CHILD_TAIL_${n}`);
      } else if (text.includes("CHECK_CONTEXT")) {
        finish(text.includes("HISTORY_FIRST") && text.includes("HISTORY_LAST") ? "CONTEXT_COMPLETE" : "MISSING_CONTEXT");
      } else if (text.includes("CHECK_TOOLS")) {
        const { agents } = await tool("room_agents");
        let forbidden = false;
        try { await tool("rooms.create", { roomId: "escape" }); } catch { forbidden = true; }
        finish(agents.map((a) => a.id).sort().join(",") === "follower,leader" && forbidden && !process.env.FLEET_TOKEN ? "TOOLS_SCOPED" : "TOOLS_FAILED");
      } else finish("TASK_COMPLETE");
    } catch (error) { finish(`FIXTURE_ERROR:${error.message}`); }
  }
  if (m.method === "session/cancel" && promptId) { send({ id: promptId, result: { stopReason: "cancelled" } }); promptId = null; }
}
