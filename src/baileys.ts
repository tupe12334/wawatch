import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  getContentType,
  isJidGroup,
  isJidStatusBroadcast,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import { join } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import type { ChatRef, IncomingMessage, Transport, TransportSink } from './types.js';

const SKIP_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo']);

/** Plain text of a message, or "[image]"-style placeholder. Undefined for protocol noise. */
export function messageText(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  const type = getContentType(content ?? undefined);
  if (!content || !type || SKIP_TYPES.has(type)) return undefined;
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption;
  if (text) return text;
  if (type === 'reactionMessage') return `[reaction ${content.reactionMessage?.text ?? ''}]`.trim();
  return `[${type.replace(/Message$/, '')}]`;
}

/** Real WhatsApp connection as a linked device, through Baileys. */
export class BaileysTransport implements Transport {
  private sock?: WASocket;
  private sink?: TransportSink;
  private ownIds = new Set<string>();
  private stopped = false;
  private logger = pino({ level: process.env.WAWATCH_DEBUG ? 'debug' : 'silent' });

  constructor(private dataDir: string) {}

  async start(sink: TransportSink) {
    this.sink = sink;
    await this.connect();
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(join(this.dataDir, 'auth'));
    const sock = makeWASocket({
      auth: state,
      logger: this.logger,
      browser: Browsers.macOS('wawatch'),
      syncFullHistory: false,
    });
    this.sock = sock;
    const sink = this.sink!;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        sink.status('qr', qr);
        console.log('Scan this QR in WhatsApp > Linked devices (or open the web UI):');
        console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      }
      if (connection === 'open') {
        sink.status('open');
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        sink.chats(Object.values(groups).map((g) => ({ id: g.id, name: g.subject })));
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        sink.status('closed');
        if (code === DisconnectReason.loggedOut) {
          console.error(`WhatsApp logged this device out. Delete ${join(this.dataDir, 'auth')} and restart to pair again.`);
        } else if (!this.stopped) {
          setTimeout(() => void this.connect(), 2000);
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      const refs: ChatRef[] = [
        ...chats.map((c) => ({ id: c.id ?? '', name: c.name ?? '' })),
        ...contacts.filter((c) => c.name || c.notify).map((c) => ({ id: c.id, name: (c.name || c.notify)! })),
      ];
      sink.chats(refs.filter((c) => c.id && !isJidStatusBroadcast(c.id)));
      for (const m of messages) this.forward(m, true);
    });

    sock.ev.on('chats.upsert', (chats) => sink.chats(chats.filter((c) => c.id).map((c) => ({ id: c.id!, name: c.name ?? '' }))));
    sock.ev.on('contacts.upsert', (contacts) =>
      sink.chats(contacts.filter((c) => c.name || c.notify).map((c) => ({ id: c.id, name: (c.name || c.notify)! }))),
    );
    sock.ev.on('groups.update', (groups) =>
      sink.chats(groups.filter((g) => g.id && g.subject).map((g) => ({ id: g.id!, name: g.subject! }))),
    );

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) this.forward(m, type !== 'notify');
    });
  }

  private forward(m: WAMessage, history: boolean) {
    const chatId = m.key.remoteJid;
    if (!chatId || isJidStatusBroadcast(chatId) || !m.key.id) return;
    // Messages wawatch sent are recorded by the hub already; skip their echo.
    if (this.ownIds.delete(m.key.id)) return;
    const text = messageText(m);
    if (text === undefined) return;
    const fromMe = !!m.key.fromMe;
    if (!fromMe && !isJidGroup(chatId) && m.pushName) this.sink!.chats([{ id: chatId, name: m.pushName }]);
    const msg: IncomingMessage = {
      id: m.key.id,
      chatId,
      sender: fromMe ? 'me' : m.pushName || m.key.participant || chatId,
      fromMe,
      text,
      timestamp: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(),
      history,
    };
    this.sink!.message(msg);
  }

  async send(chatId: string, text: string) {
    if (!this.sock) throw new Error('WhatsApp is not connected.');
    const messageId = generateMessageIDV2(this.sock.user?.id);
    this.ownIds.add(messageId);
    try {
      // Plain text: WhatsApp gets the exact characters, no list auto-formatting.
      await this.sock.sendMessage(chatId, { text }, { messageId });
    } catch (e) {
      this.ownIds.delete(messageId);
      throw e;
    }
    return messageId;
  }

  async stop() {
    this.stopped = true;
    this.sock?.end(undefined);
  }
}
