import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hub } from '../src/hub.js';
import { MockTransport } from '../src/mock.js';

async function setup(dataDir?: string) {
  const transport = new MockTransport();
  const hub = new Hub({ transport, signature: '🤖 ', dataDir });
  await hub.start();
  return { hub, transport };
}

describe('Hub', () => {
  it('uses the default signature when the configured one is blank', async () => {
    for (const signature of ['', '   ']) {
      const hub = new Hub({ transport: new MockTransport(), signature });
      expect(hub.signature).toBe('🤖 ');
    }
  });

  it('hides messages from chats that are not watched', async () => {
    const { hub, transport } = await setup();
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'secret' });
    expect(hub.read()).toEqual([]);
    hub.setPermissions('111@s.whatsapp.net', { watched: true });
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'hello' });
    expect(hub.read().map((m) => m.text)).toEqual(['secret', 'hello']);
  });

  it('reads only messages after the cursor', async () => {
    const { hub, transport } = await setup();
    hub.setPermissions('111@s.whatsapp.net', { watched: true });
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'one' });
    const cursor = hub.cursor;
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'two' });
    expect(hub.read({ since: cursor }).map((m) => m.text)).toEqual(['two']);
  });

  it('refuses to send unless the user allowed replies, then adds the signature', async () => {
    const { hub, transport } = await setup();
    hub.setPermissions('111@s.whatsapp.net', { watched: true });
    await expect(hub.send('111@s.whatsapp.net', 'hi')).rejects.toThrow(/not allowed/);
    hub.setPermissions('111@s.whatsapp.net', { mayReply: true });
    const sent = await hub.send('111@s.whatsapp.net', 'line 1\n1. line 2');
    expect(transport.sent).toEqual([{ chatId: '111@s.whatsapp.net', text: '🤖 line 1\n1. line 2' }]);
    expect(sent.fromAgent).toBe(true);
  });

  it('turning watch off also turns may-reply off', async () => {
    const { hub } = await setup();
    hub.setPermissions('111@s.whatsapp.net', { mayReply: true });
    expect(hub.getChat('111@s.whatsapp.net')).toMatchObject({ watched: true, mayReply: true });
    hub.setPermissions('111@s.whatsapp.net', { watched: false });
    expect(hub.getChat('111@s.whatsapp.net')).toMatchObject({ watched: false, mayReply: false });
  });

  it('wait wakes on a live watched message, ignores others, and times out', async () => {
    const { hub, transport } = await setup();
    hub.setPermissions('333@g.us', { watched: true });
    const waiting = hub.waitForMessages(undefined, 5000);
    transport.inject({ chatId: '111@s.whatsapp.net', text: 'not watched' });
    transport.inject({ chatId: '333@g.us', text: 'old', history: true });
    transport.inject({ chatId: '333@g.us', text: 'live' });
    expect((await waiting).map((m) => m.text)).toEqual(['old', 'live']);
    expect(await hub.waitForMessages(undefined, 20)).toEqual([]);
  });

  it('keeps permissions and watched messages across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wawatch-'));
    const first = await setup(dir);
    first.hub.setPermissions('222@s.whatsapp.net', { mayReply: true });
    first.transport.inject({ chatId: '222@s.whatsapp.net', text: 'kept' });
    first.transport.inject({ chatId: '111@s.whatsapp.net', text: 'not stored' });
    const second = await setup(dir);
    expect(second.hub.getChat('222@s.whatsapp.net')).toMatchObject({ watched: true, mayReply: true });
    expect(second.hub.read().map((m) => m.text)).toEqual(['kept']);
    expect(second.hub.cursor).toBeGreaterThanOrEqual(1);
  });
});
