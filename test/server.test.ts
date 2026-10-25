import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/hub.js';
import { MockTransport } from '../src/mock.js';
import { createApp } from '../src/server.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(opts: { webhookUrl?: string; webhookSecret?: string } = {}) {
  const transport = new MockTransport();
  const hub = new Hub({ transport, signature: '[bot] ' });
  await hub.start();
  const base = await listen(createApp({ hub, ...opts }) as unknown as RequestListener);
  return { hub, transport, base };
}

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe('MCP server', () => {
  it('lists chats, waits for a message, and sends only when allowed', async () => {
    const { hub, transport, base } = await setup();
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['list_chats', 'read_messages', 'send_message', 'status', 'unwatch_chat', 'wait_for_message', 'watch_chat']);

    const chats = parse(await client.callTool({ name: 'list_chats', arguments: { query: 'family' } }));
    expect(chats).toEqual([{ chat_id: '333@g.us', name: 'Family trip', watched: false, may_reply: false }]);

    await client.callTool({ name: 'watch_chat', arguments: { chat_id: '333@g.us' } });
    const waiting = client.callTool({ name: 'wait_for_message', arguments: { timeout_seconds: 5 } });
    setTimeout(() => transport.inject({ chatId: '333@g.us', sender: 'Dana', text: 'When is the train?' }), 50);
    const got = parse(await waiting);
    expect(got.messages).toMatchObject([{ chat: 'Family trip', from: 'Dana', text: 'When is the train?' }]);

    const denied = await client.callTool({ name: 'send_message', arguments: { chat_id: '333@g.us', text: '9:15' } });
    expect(denied.isError).toBe(true);

    hub.setPermissions('333@g.us', { mayReply: true }); // the user flips the switch in the UI
    const sent = parse(await client.callTool({ name: 'send_message', arguments: { chat_id: '333@g.us', text: '9:15' } }));
    expect(sent.sent).toMatchObject({ from: 'agent', text: '[bot] 9:15' });
    expect(transport.sent).toEqual([{ chatId: '333@g.us', text: '[bot] 9:15' }]);
    await client.close();
  });
});

describe('HTTP API safety', () => {
  it('rejects non-JSON and foreign-origin writes, and foreign Host headers', async () => {
    const { base } = await setup();
    const url = base + '/api/chats/' + encodeURIComponent('111@s.whatsapp.net');
    const body = '{"watched":true}';
    const plain = await fetch(url, { method: 'PATCH', body, headers: { 'Content-Type': 'text/plain' } });
    expect(plain.status).toBe(415);
    const foreign = await fetch(url, {
      method: 'PATCH',
      body,
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const ok = await fetch(url, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json' } });
    expect(await ok.json()).toMatchObject({ watched: true });
    // fetch() cannot override Host, so use node:http for the DNS-rebinding case.
    const status = await new Promise<number>((resolve, reject) =>
      request(base + '/api/state', { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode!))
        .on('error', reject)
        .end(),
    );
    expect(status).toBe(403);
  });
});

describe('reply signature', () => {
  it('saves a new signature over HTTP, refuses empty ones, and keeps the saved one after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wawatch-test-'));
    try {
      const transport = new MockTransport();
      const hub = new Hub({ transport, signature: '🤖 ', dataDir });
      await hub.start();
      hub.setPermissions('111@s.whatsapp.net', { mayReply: true });
      const base = await listen(createApp({ hub }) as unknown as RequestListener);
      const url = base + '/api/signature';
      const patch = (body: string) => fetch(url, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json' } });

      expect((await patch(JSON.stringify({ signature: '   ' }))).status).toBe(400);
      expect((await patch(JSON.stringify({ signature: 42 }))).status).toBe(400);
      expect(hub.signature).toBe('🤖 ');

      expect((await patch(JSON.stringify({ signature: '🧪 ' }))).status).toBe(200);
      await hub.send('111@s.whatsapp.net', 'hi');
      expect(transport.sent).toEqual([{ chatId: '111@s.whatsapp.net', text: '🧪 hi' }]);

      // After a restart the saved value wins over the CLI value.
      const restarted = new Hub({ transport: new MockTransport(), signature: '🤖 ', dataDir });
      expect(restarted.signature).toBe('🧪 ');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('pairing and logout', () => {
  it('reports each link status and the QR code through /api/state', async () => {
    const { transport, base } = await setup();
    const state = async () => (await fetch(base + '/api/state')).json();
    transport.sink!.status('qr', 'qr-data');
    expect(await state()).toMatchObject({ status: 'qr' });
    expect((await state()).qr).toMatch(/^data:image\/png;base64,/);
    for (const status of ['connecting', 'open', 'loggedOut'] as const) {
      transport.sink!.status(status);
      const s = await state();
      expect(s.status).toBe(status);
      expect(s.qr).toBeUndefined();
    }
  });

  it('repairs only after a logout, refuses foreign origins, and restarts the transport', async () => {
    const { hub, transport, base } = await setup();
    const repair = vi.spyOn(transport, 'repair');
    const url = base + '/api/repair';
    const json = { 'Content-Type': 'application/json' };
    const foreign = await fetch(url, { method: 'POST', body: '{}', headers: { ...json, Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect((await fetch(url, { method: 'POST', body: '{}', headers: json })).status).toBe(409);
    expect(repair).not.toHaveBeenCalled();

    transport.sink!.status('loggedOut');
    const ok = await fetch(url, { method: 'POST', body: '{}', headers: json });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'qr' });
    expect(repair).toHaveBeenCalledOnce();
    expect(hub.linkStatus).toBe('qr');
  });
});

describe('webhook', () => {
  it('posts new messages from watched chats with an HMAC signature', async () => {
    const received: { body: string; sig?: string }[] = [];
    const hookUrl = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, sig: req.headers['x-wawatch-signature'] as string });
        res.end();
      });
    });
    const { hub, transport } = await setup({ webhookUrl: hookUrl, webhookSecret: 's3cret' });
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'ignored' });
    hub.setPermissions('111@s.whatsapp.net', { watched: true });
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'hello' });
    await expect.poll(() => received.length).toBe(1);
    expect(JSON.parse(received[0].body).message).toMatchObject({ text: 'hello', chat_id: '111@s.whatsapp.net' });
    expect(received[0].sig).toBe('sha256=' + createHmac('sha256', 's3cret').update(received[0].body).digest('hex'));
  });
});
