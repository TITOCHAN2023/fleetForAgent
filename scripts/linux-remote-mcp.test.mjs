import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteMcp } from './plugin-peer-vm/linux-remote-mcp.mjs';

for (const failure of ['initialize', 'session-only guard']) {
  test(`Linux SSE fixture cancels its stream when ${failure} fails before registration`, async () => {
    const original = globalThis.fetch;
    let cancelled = 0, connectionSignal, controller;
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(url);
      assert.equal(target.origin, 'http://fleet-hub.test:8787');
      if (!init.method) {
        connectionSignal = init.signal;
        return new Response(new ReadableStream({
          start(stream) {
            controller = stream;
            stream.enqueue(new TextEncoder().encode('event: endpoint\ndata: /mcp/sse?sessionId=fixture-session\n\n'));
          },
          cancel() { cancelled++; },
        }));
      }
      if (!init.headers.authorization) return new Response('{}', { status: 200 });
      const message = JSON.parse(init.body);
      if (failure === 'initialize') return new Response('{}', { status: 401 });
      controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n\n`));
      return new Response(null, { status: 202 });
    };
    try {
      await assert.rejects(remoteMcp('http://fleet-hub.test:8787', 'fixture-not-a-real-token', 'sse'));
      assert.equal(connectionSignal.aborted, true);
      assert.equal(cancelled, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
}
