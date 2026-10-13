// Deterministic ACP test peer, not an LLM. Only fixed harmless commands.
import { createInterface } from 'node:readline';
const send = row => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...row }) + '\n');
let config;
const cancelled = new Set();
async function tool(name, args) {
  const env = Object.fromEntries(config.env.map(({ name, value }) => [name, value]));
  const res = await fetch(env.FLEET_ROOM_RPC + '/tool', { method: 'POST', headers: { authorization: `Bearer ${env.FLEET_ROOM_CAP}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  const row = await res.json(); if (!res.ok) throw new Error(JSON.stringify(row)); return row.result;
}
async function prompt(m) {
  try {
    const text = JSON.stringify(m.params.prompt);
    const marker = text.match(/LABMARK_[a-zA-Z0-9_]+/)?.[0];
    if (!marker) throw new Error('missing safe lab marker');
    let result = await tool('fleet_run', { command: `hostname; sleep 1; printf '${marker}\\n'` });
    for (let i = 0; i < 300 && ['pending', 'running'].includes(result.status); i++) {
      await new Promise(r => setTimeout(r, 100));
      result = await tool('fleet_result', { corr: result.corr });
    }
    if (cancelled.has(m.id)) return;
    send({ method: 'session/update', params: { sessionId: 'lab', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  } catch (e) { send({ id: m.id, error: { code: -32000, message: e.message } }); }
}
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === 'session/new') { config = m.params.mcpServers[0]; send({ id: m.id, result: { sessionId: 'lab' } }); }
  else if (m.method === 'session/prompt') void prompt(m);
}
