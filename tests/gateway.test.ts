import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GatewayClient } from '../src/gateway-client.js';

test('HTTP bridge validates service identity, response shape and selected window', async () => {
  let mode = 'good'; let received: any;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') return void response.end(JSON.stringify({ service: mode === 'identity' ? 'wrong' : 'easyeda-bridge' }));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    if (mode === 'shape') return void response.end('{}');
    response.end(JSON.stringify({ success: true, result: 42, windowId: mode === 'window' ? 'wrong' : 'w' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const gateway = new GatewayClient({ baseUrl: `http://127.0.0.1:${address.port}`, autoSpawn: false });
    assert.equal(await gateway.execute('return 42;', 'w'), 42);
    assert.equal(received.windowId, 'w');
    mode = 'identity'; await assert.rejects(gateway.execute('return 42;', 'w'), /identity/);
    mode = 'shape'; await assert.rejects(gateway.execute('return 42;', 'w'), /unknown/);
    mode = 'window'; await assert.rejects(gateway.execute('return 42;', 'w'), /different window/);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
