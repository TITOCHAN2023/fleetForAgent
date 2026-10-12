import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const mode = process.argv[2] || "normal";
const sid = `fixture-${process.pid}`;
let prompt;
let descendant;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (text) => send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (mode === "hang-open") continue;
    if (m.params.clientCapabilities.terminal !== false || m.params.clientCapabilities.fs.writeTextFile !== false) process.exit(4);
    send({ id: 99999, result: { unrelated: true } });
    reply(m.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (m.method === "session/new") {
    if (mode === "mcp" && m.params.mcpServers[0]?.name !== "room") process.exit(5);
    reply(m.id, { sessionId: sid });
  } else if (m.method === "session/prompt") {
    prompt = m.id;
    if (mode === "crash") { process.stderr.write("SECRET-DO-NOT-PRINT"); process.exit(7); }
    if (mode === "bad-frame") { process.stdout.write("not json\n"); continue; }
    if (mode === "large-frame") { process.stdout.write("x".repeat(2048)); continue; }
    if (mode === "large-output") { for (let i = 0; i < 40; i++) update("x".repeat(100)); continue; }
    if (mode === "descendant") {
      descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      update(String(descendant.pid));
      continue;
    }
    if (mode === "permission" || mode === "permission-cancel") {
      send({ id: "permission-1", method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "write file" }, options: [
        { optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" },
      ] } });
      continue;
    }
    if (mode === "hang" || mode === "cancel") continue;
    send({ id: "unsupported", method: "fs/read_text_file", params: { sessionId: sid } });
    send({ method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WRONG" } } } });
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } } } }) + "\n");
    const index = frame.indexOf(Buffer.from("你"));
    process.stdout.write(frame.subarray(0, index + 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(frame.subarray(index + 1));
    reply(m.id, { stopReason: "end_turn" });
  } else if (m.method === "session/cancel") {
    if (mode !== "hang" && mode !== "descendant" && prompt) {
      reply(prompt, { stopReason: "cancelled" });
      prompt = null;
    }
  } else if (m.id === "permission-1") {
    update(m.result.outcome.optionId || m.result.outcome.outcome);
    if (prompt) reply(prompt, { stopReason: "end_turn" });
    prompt = null;
  }
}
