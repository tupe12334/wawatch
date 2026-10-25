import type { ChatRef, IncomingMessage, Transport, TransportSink } from './types.js';

const DEMO_CHATS: ChatRef[] = [
  { id: '111@s.whatsapp.net', name: 'Alice' },
  { id: '222@s.whatsapp.net', name: 'Bob' },
  { id: '333@g.us', name: 'Family trip' },
  { id: '444@g.us', name: 'Book club' },
];

const DEMO_LINES = ['Where do we meet tomorrow?', 'What time is the train?', 'Can you send the hotel address?', 'Thanks!'];

/** Fake WhatsApp for tests and `--demo`. No network. */
export class MockTransport implements Transport {
  sink?: TransportSink;
  sent: { chatId: string; text: string }[] = [];
  private timer?: NodeJS.Timeout;
  private n = 0;

  constructor(private opts: { chats?: ChatRef[]; demoIntervalMs?: number } = {}) {}

  async start(sink: TransportSink) {
    this.sink = sink;
    sink.status('open');
    sink.chats(this.opts.chats ?? DEMO_CHATS);
    if (this.opts.demoIntervalMs) {
      this.timer = setInterval(() => {
        const chat = DEMO_CHATS[this.n % DEMO_CHATS.length];
        this.inject({ chatId: chat.id, sender: chat.id.endsWith('@g.us') ? 'Dana' : chat.name, text: DEMO_LINES[this.n % DEMO_LINES.length] });
      }, this.opts.demoIntervalMs);
    }
  }

  /** Simulates an incoming message. */
  inject(m: Partial<IncomingMessage> & { chatId: string; text: string }) {
    this.sink!.message({ id: `in-${++this.n}`, sender: 'someone', fromMe: false, timestamp: Date.now(), ...m });
  }

  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return `out-${++this.n}`;
  }

  async stop() {
    clearInterval(this.timer);
  }
}
