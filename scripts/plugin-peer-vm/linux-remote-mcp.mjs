// Real HTTP/SSE clients for the private lab. Credentials never enter evidence.
import assert from 'node:assert/strict';

export async function remoteMcp(hub, token, transport) {
  assert.equal(hub, 'http://fleet-hub.test:8787');
  let sequence = 0, session, reader;
  const pending = new Map(), abort = new AbortController();
  let endpointResolve, endpointReject;
  const endpointReady = new Promise((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
  endpointReady.catch(() => {});
  async function readEvents() {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed');
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = event.match(/^event: (.+)$/m)?.[1];
          const data = event.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
          if (type === 'endpoint') {
            const url = new URL(data, hub);
            assert.equal(url.origin, hub); assert.equal(url.pathname, '/mcp/sse');
            assert(!data.includes(token)); session = url.href; endpointResolve();
          } else if (type === 'message') {
            const message = JSON.parse(data), waiter = pending.get(message.id);
            if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
          }
        }
      }
    } catch (error) {
      endpointReject(error);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      pending.clear();
    }
  }
  if (transport === 'sse') {
    const response = await fetch(hub + '/mcp/sse', { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
    assert.equal(response.status, 200);
    reader = response.body.getReader(); void readEvents();
    await Promise.race([endpointReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE endpoint timeout')), 15000);
      endpointReady.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
  } else assert.equal(transport, 'http');
  async function request(method, params = {}) {
    const id = ++sequence, body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    let message;
    if (transport === 'http') {
      const response = await fetch(hub + '/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : { authorization: `Bearer ${token}` }),
      }, body, signal: AbortSignal.timeout(30000) });
      assert(response.ok, `HTTP MCP status ${response.status}`);
      session ||= response.headers.get('mcp-session-id'); assert(session);
      message = await response.json();
    } else {
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('SSE reply timeout')); }, 30000);
        pending.set(id, { resolve, reject, timer });
      });
      reply.catch(() => {});
      const response = await fetch(session, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
      assert(response.ok, `SSE MCP status ${response.status}`); await response.arrayBuffer();
      message = await reply;
    }
    assert.equal(message.id, id); assert(!message.error, JSON.stringify(message.error));
    return message.result;
  }
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolated-linux-lab', version: '1' } });
  return {
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      if (!['run', 'get_result', 'wait'].includes(name)) return JSON.parse(result.content[0].text);
      assert.equal(result._meta?.fleet_transport, 'ws');
      if (result.content[0].text === 'still running') return { status: 'running' };
      const snapshot = await request('tools/call', { name: 'recover_session', arguments: { device_id: args.device_id } });
      const row = JSON.parse(snapshot.content[0].text).result;
      assert.equal(typeof row?.stdout, 'string', JSON.stringify({ name, visible: result, recovered: snapshot }));
      assert.equal(row.stdout.trim(), result.content[0].text.trim()); return row;
    },
    async close() {
      if (transport === 'http') await fetch(hub + '/mcp', { method: 'DELETE', headers: { 'mcp-session-id': session }, signal: AbortSignal.timeout(10000) });
      else { abort.abort(); await reader.cancel().catch(() => {}); }
    },
  };
}
