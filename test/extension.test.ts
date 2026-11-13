import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Runs bridge.js and content.js in one sandbox with stub WPP, window.postMessage and WebSocket.
// ponytail: postMessage dispatches synchronously; the browser queues it, which only changes timing.
// wa-js 4.x: WPP.chat.list() returns a Promise.
function loadExtension(list: () => Promise<unknown[]>) {
  const listeners: ((e: unknown) => void)[] = [];
  const sockets: { readyState: number; sent: unknown[]; onopen?: () => void; send(d: string): void }[] = [];
  let onReady = () => {};
  const handlers: Record<string, (m: unknown) => void> = {};
  const window: Record<string, unknown> = {
    addEventListener: (_type: string, fn: (e: unknown) => void) => listeners.push(fn),
    // The scripts call window.postMessage on the vm global, so `this` is the window they compare e.source to.
    postMessage(this: unknown, data: unknown) {
      listeners.forEach((fn) => fn({ source: this, data }));
    },
  };
  Object.assign(window, {
    window,
    console,
    setTimeout,
    document: { createElement: () => ({}), head: { appendChild() {} } },
    chrome: { runtime: { getURL: (f: string) => f }, storage: { local: { get: async () => ({ token: 't' }) } } },
    WPP: { loader: { onReady: (cb: () => void) => (onReady = cb) }, on: (ev: string, fn: (m: unknown) => void) => (handlers[ev] = fn), chat: { list } },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      sent: unknown[] = [];
      constructor() {
        sockets.push(this);
      }
      send(d: string) {
        this.sent.push(JSON.parse(d));
      }
    },
  });
  for (const file of ['bridge.js', 'content.js']) runInNewContext(readFileSync(`extension/${file}`, 'utf8'), window);
  return { sockets, ready: () => onReady(), emit: (ev: string, m: unknown) => handlers[ev](m) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const chat = { id: { _serialized: '111@s.whatsapp.net' }, formattedTitle: 'Alice' };

const chats = [{ id: '111@s.whatsapp.net', name: 'Alice' }];

describe('extension chat list', () => {
  it('posts the awaited chat list after WPP is ready', async () => {
    const ext = loadExtension(async () => [chat]);
    await tick(); // content.js reads the token, then opens the socket
    const ws = ext.sockets[0];
    ws.readyState = 1;
    ext.ready();
    await tick();
    expect(ws.sent).toEqual([{ type: 'chats', chats }]);
  });

  it('sends the chat list again when the hub socket opens after WPP is ready', async () => {
    const ext = loadExtension(async () => [chat]);
    ext.ready(); // chat list posted while no socket is open: dropped
    await tick();
    const ws = ext.sockets[0];
    expect(ws.sent).toEqual([]);
    ws.readyState = 1;
    ws.onopen!();
    await tick();
    expect(ws.sent).toEqual([{ type: 'chats', chats }]);
  });

  it('posts nothing when the chat list rejects', async () => {
    const ext = loadExtension(async () => {
      throw new Error('not loaded');
    });
    ext.ready();
    await tick();
    const ws = ext.sockets[0];
    ws.readyState = 1;
    ws.onopen!();
    await tick();
    expect(ws.sent).toEqual([]);
  });
});

describe('extension messages', () => {
  // Shaped like a wa-js MsgModel: fromMe on the MsgKey, contact on senderObj, sender a bare Wid.
  const msg = (fromMe: boolean) => ({
    id: { _serialized: 'k1', fromMe, remote: { _serialized: '111@s.whatsapp.net' } },
    from: { _serialized: '111@s.whatsapp.net' },
    sender: { _serialized: '111@s.whatsapp.net' },
    senderObj: { pushname: 'Alice' },
    body: 'hi',
    type: 'chat',
    t: 1700000000,
  });

  it.each([
    [false, 'Alice'],
    [true, 'me'],
  ])('maps a new message with fromMe=%s', async (fromMe, sender) => {
    const ext = loadExtension(async () => []);
    await tick();
    const ws = ext.sockets[0];
    ws.readyState = 1;
    ext.ready();
    await tick();
    ws.sent.length = 0;
    ext.emit('chat.new_message', msg(fromMe));
    expect(ws.sent).toEqual([
      {
        type: 'message',
        message: { id: 'k1', chatId: '111@s.whatsapp.net', sender, fromMe, text: 'hi', timestamp: 1700000000000 },
      },
    ]);
  });
});
