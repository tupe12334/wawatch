import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Runs bridge.js and content.js in one sandbox with stub WPP, window.postMessage and WebSocket.
// ponytail: postMessage dispatches synchronously; the browser queues it, which only changes timing.
function loadExtension(list: () => unknown[]) {
  const listeners: ((e: unknown) => void)[] = [];
  const sockets: { readyState: number; sent: unknown[]; onopen?: () => void; send(d: string): void }[] = [];
  let onReady = () => {};
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
    WPP: { loader: { onReady: (cb: () => void) => (onReady = cb) }, on() {}, chat: { list } },
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
  return { sockets, ready: () => onReady() };
}

const chat = { id: { _serialized: '111@s.whatsapp.net' }, formattedTitle: 'Alice' };

describe('extension resync', () => {
  it('sends the chat list again when the hub socket opens after WPP is ready', async () => {
    const ext = loadExtension(() => [chat]);
    ext.ready(); // chat list posted while no socket is open: dropped
    await new Promise((r) => setTimeout(r, 0)); // content.js reads the token, then opens the socket
    const ws = ext.sockets[0];
    expect(ws.sent).toEqual([]);
    ws.readyState = 1;
    ws.onopen!();
    expect(ws.sent).toEqual([{ type: 'chats', chats: [{ id: '111@s.whatsapp.net', name: 'Alice' }] }]);
  });

  it('posts nothing when the chat list throws', async () => {
    const ext = loadExtension(() => {
      throw new Error('not loaded');
    });
    expect(() => ext.ready()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const ws = ext.sockets[0];
    ws.readyState = 1;
    expect(() => ws.onopen!()).not.toThrow();
    expect(ws.sent).toEqual([]);
  });
});
