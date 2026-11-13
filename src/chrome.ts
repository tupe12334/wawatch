import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage as HttpRequest } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ChatRef, IncomingMessage, Transport, TransportSink } from './types.js';

/** Constant-time token check. A missing or wrong token fails. */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SEND_TIMEOUT_MS = 30_000;
/** How long a message we sent is recognised when WhatsApp echoes it back. */
const ECHO_WINDOW_MS = 60_000;

/** Messages from the extension, relayed by content.js. */
type Inbound =
  | { type: 'chats'; chats: ChatRef[] }
  | { type: 'message'; message: IncomingMessage }
  | { type: 'sent'; reqId: number; messageId: string }
  | { type: 'sendError'; reqId: number; error: string };

const echoKey = (chatId: string, text: string) => `${chatId}\n${text}`;

/**
 * WhatsApp Web through the wawatch Chrome extension. The extension connects to
 * ws://127.0.0.1:<port>/extension with the token from ~/.wawatch/extension-token.
 */
export class ChromeTransport implements Transport {
  private token = '';
  private sink?: TransportSink;
  private wss = new WebSocketServer({ noServer: true });
  private socket?: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (id: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** Texts the agent sent, so their echo from WhatsApp is not recorded twice. */
  private recentSends = new Map<string, number>();

  constructor(private dataDir: string) {}

  async start(sink: TransportSink) {
    this.sink = sink;
    const file = join(this.dataDir, 'extension-token');
    const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    this.token = saved || randomBytes(32).toString('hex');
    writeFileSync(file, this.token + '\n', { mode: 0o600 });
  }

  /** Wired to the HTTP server's "upgrade" event. Only /extension with the right token gets in. */
  handleUpgrade(req: HttpRequest, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/extension' || !tokenMatches(url.searchParams.get('token'), this.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocket) {
    this.socket?.close(); // one WhatsApp Web tab at a time: the newest wins
    this.socket = ws;
    this.sink!.status('open');
    ws.on('message', (data) => this.receive(data.toString()));
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.sink!.status('closed');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('The WhatsApp Web tab disconnected.'));
        this.pending.delete(id);
      }
    });
  }

  private receive(raw: string) {
    let msg: Inbound;
    try {
      msg = JSON.parse(raw) as Inbound;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'chats':
        this.sink!.chats(msg.chats);
        break;
      case 'message':
        this.onMessage(msg.message);
        break;
      case 'sent':
        this.settle(msg.reqId)?.resolve(msg.messageId);
        break;
      case 'sendError':
        this.settle(msg.reqId)?.reject(new Error(msg.error));
        break;
    }
  }

  private onMessage(m: IncomingMessage) {
    if (m.fromMe) {
      const key = echoKey(m.chatId, m.text);
      const expires = this.recentSends.get(key);
      this.recentSends.delete(key);
      if (expires && expires > Date.now()) return; // the hub already recorded this send
    }
    this.sink!.message(m);
  }

  private settle(reqId: number) {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    return p;
  }

  async send(chatId: string, text: string): Promise<string> {
    const ws = this.socket;
    if (!ws) throw new Error('The WhatsApp Web tab is not connected.');
    const reqId = ++this.reqId;
    const now = Date.now();
    for (const [k, expires] of this.recentSends) if (expires <= now) this.recentSends.delete(k);
    this.recentSends.set(echoKey(chatId, text), now + ECHO_WINDOW_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Sending timed out.'));
      }, SEND_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'send', reqId, chatId, text }));
    });
  }

  async repair() {
    throw new Error('Pair again in WhatsApp Web, then reload the page.');
  }

  async stop() {
    this.socket?.close();
    this.wss.close();
  }
}
