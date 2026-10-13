// ACP process/liveness fixture for the exact official Fleet ACP release.
// No model credentials, arbitrary execution or filesystem writes.
import { createInterface } from 'node:readline';
const send = row => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...row }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'plugin-lab' } });
  else if (m.method === 'session/prompt') {
    if (process.argv.includes('--crash')) process.exit(7);
    const text = JSON.stringify(m.params.prompt);
    const marker = text.match(/LABMARK_[a-zA-Z0-9_]+/)?.[0];
    const seconds = Number(text.match(/WAIT_(\d+)/)?.[1] || 1);
    if (!marker || seconds > 900) throw new Error('invalid fixture prompt');
    await new Promise(r => setTimeout(r, seconds * 1000));
    send({ method: 'session/update', params: { sessionId: 'plugin-lab', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
}
