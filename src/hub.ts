import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRef, IncomingMessage, LinkStatus, Transport, TransportSink } from './types.js';

export interface Chat {
  id: string;
  name: string;
  watched: boolean;
  mayReply: boolean;
  lastMessageAt?: number;
}

export interface Message extends IncomingMessage {
  /** Cursor. Strictly increasing across all chats. */
  seq: number;
  chatName: string;
  /** True when the agent sent this message through wawatch. */
  fromAgent: boolean;
}

export interface HubOptions {
  transport: Transport;
  /** Folder for settings.json and messages.jsonl. Omit to keep everything in memory. */
  dataDir?: string;
  /** Prefix added to every message the agent sends. */
  signature?: string;
}

const DEFAULT_SIGNATURE = '🤖 ';

const MAX_MESSAGES = 5000;
const MAX_TEXT = 4096;

/**
 * Holds chat permissions and the message log, and enforces the safety rules:
 * the agent reads only watched chats and sends only to chats the user marked "may reply".
 */
export class Hub extends EventEmitter implements TransportSink {
  linkStatus: LinkStatus = 'starting';
  qr?: string;
  signature: string;
  private chatMap = new Map<string, Chat>();
  private log: Message[] = [];
  private seq = 0;
  private transport: Transport;
  private dataDir?: string;
  /** Set only after the user edits the signature in the UI; wins over the CLI value on start. */
  private savedSignature?: string;

  constructor(opts: HubOptions) {
    super();
    this.setMaxListeners(0); // one listener per pending wait_for_message call
    this.transport = opts.transport;
    // A blank --signature or WAWATCH_SIGNATURE would send replies without the AI notice.
    this.signature = opts.signature?.trim() ? opts.signature : DEFAULT_SIGNATURE;
    this.dataDir = opts.dataDir;
    if (this.dataDir) this.load(this.dataDir);
  }

  start() {
    return this.transport.start(this);
  }

  stop() {
    return this.transport.stop();
  }

  // ---- TransportSink ----

  status(s: LinkStatus, qr?: string) {
    this.linkStatus = s;
    this.qr = s === 'qr' ? qr : undefined;
    this.emit('state');
  }

  chats(list: ChatRef[]) {
    let changed = false;
    for (const c of list) {
      const existing = this.chatMap.get(c.id);
      if (!existing) {
        this.chatMap.set(c.id, { id: c.id, name: c.name || c.id, watched: false, mayReply: false });
        changed = true;
      } else if (c.name && existing.name !== c.name) {
        existing.name = c.name;
        changed = true;
      }
    }
    if (changed) this.emit('state');
  }

  message(m: IncomingMessage) {
    this.record(m, false);
  }

  // ---- user (UI) actions ----

  listChats(): Chat[] {
    return [...this.chatMap.values()].sort(
      (a, b) =>
        Number(b.watched) - Number(a.watched) ||
        (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }

  getChat(id: string) {
    return this.chatMap.get(id);
  }

  /** Changes permissions. Turning "watch" off also turns "may reply" off. */
  setPermissions(id: string, p: { watched?: boolean; mayReply?: boolean }): Chat {
    const chat = this.chatMap.get(id);
    if (!chat) throw new Error(`Unknown chat: ${id}`);
    if (p.watched !== undefined) chat.watched = p.watched;
    if (p.mayReply !== undefined) chat.mayReply = p.mayReply;
    if (p.mayReply) chat.watched = true; // replying needs reading
    if (!chat.watched) chat.mayReply = false;
    this.save();
    this.emit('state');
    return chat;
  }

  /** Changes the signature and saves it. Empty text is refused: every agent message must say it is AI. */
  setSignature(text: string): string {
    if (!text.trim()) throw new Error('Signature cannot be empty.');
    this.signature = this.savedSignature = text;
    this.save();
    this.emit('state');
    return text;
  }

  // ---- agent actions ----

  /** Messages with seq > since in watched chats (optionally one chat), oldest first. */
  read(opts: { since?: number; chatId?: string; limit?: number; includeAgent?: boolean } = {}): Message[] {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 50;
    const out = this.log.filter(
      (m) =>
        m.seq > since &&
        (opts.chatId === undefined || m.chatId === opts.chatId) &&
        this.chatMap.get(m.chatId)?.watched &&
        (opts.includeAgent !== false || !m.fromAgent),
    );
    // With no cursor, return the most recent messages; with a cursor, the next ones.
    return opts.since === undefined ? out.slice(-limit) : out.slice(0, limit);
  }

  get cursor() {
    return this.seq;
  }

  /**
   * Long-poll: resolves with new messages from other people in watched chats as soon as one
   * arrives, or with [] after timeoutMs.
   */
  waitForMessages(since: number | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Message[]> {
    const from = since ?? this.seq;
    const ready = this.read({ since: from, includeAgent: false });
    if (ready.length) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('message', onMsg);
        signal?.removeEventListener('abort', done);
        resolve(this.read({ since: from, includeAgent: false }));
      };
      const onMsg = (m: Message) => {
        if (!m.fromAgent && !m.history && this.chatMap.get(m.chatId)?.watched) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.on('message', onMsg);
      signal?.addEventListener('abort', done);
    });
  }

  /** Sends text to a chat the user allowed. The signature is prepended. */
  async send(chatId: string, text: string): Promise<Message> {
    const chat = this.chatMap.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    if (!chat.mayReply) {
      throw new Error(`Sending to "${chat.name}" is not allowed. Ask the user to turn on "May reply" for it in the wawatch UI.`);
    }
    if (!text.trim()) throw new Error('Message text is empty.');
    if (text.length > MAX_TEXT) throw new Error(`Message text is longer than ${MAX_TEXT} characters.`);
    if (this.linkStatus !== 'open') throw new Error(`WhatsApp is not connected (status: ${this.linkStatus}).`);
    const full = this.signature + text;
    const id = await this.transport.send(chatId, full);
    return this.record({ id, chatId, sender: 'me', fromMe: true, text: full, timestamp: Date.now() }, true);
  }

  // ---- internals ----

  private record(m: IncomingMessage, fromAgent: boolean): Message {
    let chat = this.chatMap.get(m.chatId);
    if (!chat) {
      chat = { id: m.chatId, name: m.chatId, watched: false, mayReply: false };
      this.chatMap.set(m.chatId, chat);
    }
    chat.lastMessageAt = Math.max(chat.lastMessageAt ?? 0, m.timestamp);
    const msg: Message = { ...m, seq: ++this.seq, chatName: chat.name, fromAgent };
    this.log.push(msg);
    if (this.log.length > MAX_MESSAGES) this.log.splice(0, this.log.length - MAX_MESSAGES);
    // Only watched chats and agent messages reach the disk.
    if (this.dataDir && (chat.watched || fromAgent)) {
      appendFileSync(join(this.dataDir, 'messages.jsonl'), JSON.stringify(msg) + '\n');
    }
    this.emit('message', msg);
    return msg;
  }

  private load(dir: string) {
    mkdirSync(dir, { recursive: true });
    const settings = join(dir, 'settings.json');
    if (existsSync(settings)) {
      const data = JSON.parse(readFileSync(settings, 'utf8')) as { chats: Chat[]; signature?: string };
      for (const c of data.chats) this.chatMap.set(c.id, { ...c });
      if (data.signature?.trim()) this.signature = this.savedSignature = data.signature;
    }
    const messages = join(dir, 'messages.jsonl');
    if (existsSync(messages)) {
      // shortcut: reads the whole file on start; rotate it if it grows past a few MB.
      for (const line of readFileSync(messages, 'utf8').split('\n')) {
        if (!line) continue;
        const m = JSON.parse(line) as Message;
        this.log.push(m);
        this.seq = Math.max(this.seq, m.seq);
      }
      if (this.log.length > MAX_MESSAGES) this.log.splice(0, this.log.length - MAX_MESSAGES);
    }
  }

  private save() {
    if (!this.dataDir) return;
    // Persist only chats with a permission, so the file holds no full chat list.
    const chats = [...this.chatMap.values()].filter((c) => c.watched || c.mayReply);
    writeFileSync(join(this.dataDir, 'settings.json'), JSON.stringify({ chats, signature: this.savedSignature }, null, 2));
  }
}
