#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BaileysTransport } from './baileys.js';
import { Hub } from './hub.js';
import { MockTransport } from './mock.js';
import { createApp } from './server.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.WAWATCH_PORT ?? '4747' },
    data: { type: 'string', default: process.env.WAWATCH_DATA ?? join(homedir(), '.wawatch') },
    signature: { type: 'string', default: process.env.WAWATCH_SIGNATURE ?? '🤖 ' },
    'max-messages': { type: 'string', default: process.env.WAWATCH_MAX_MESSAGES ?? '5000' },
    webhook: { type: 'string', default: process.env.WAWATCH_WEBHOOK_URL },
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`wawatch - let AI agents watch and answer your WhatsApp chats

Usage: wawatch [--port 4747] [--data ~/.wawatch] [--signature "🤖 "] [--max-messages 5000] [--webhook URL] [--demo]

  --demo   fake chats, no WhatsApp connection (try the UI and MCP tools)

Env: WAWATCH_PORT, WAWATCH_DATA, WAWATCH_SIGNATURE, WAWATCH_MAX_MESSAGES, WAWATCH_WEBHOOK_URL, WAWATCH_WEBHOOK_SECRET`);
  process.exit(0);
}

const maxMessages = Number(args['max-messages']);
if (!Number.isInteger(maxMessages) || maxMessages < 1) {
  console.error('--max-messages must be a whole number of at least 1.');
  process.exit(1);
}

const transport = args.demo ? new MockTransport({ demoIntervalMs: 15000 }) : new BaileysTransport(args.data!);
const hub = new Hub({ transport, dataDir: args.demo ? undefined : args.data, signature: args.signature, maxMessages });
const webDir = join(dirname(fileURLToPath(import.meta.url)), 'web');
const app = createApp({ hub, webDir, webhookUrl: args.webhook, webhookSecret: process.env.WAWATCH_WEBHOOK_SECRET });

app.listen(Number(args.port), '127.0.0.1', () => {
  console.log(`wawatch UI:  http://127.0.0.1:${args.port}`);
  console.log(`MCP server:  http://127.0.0.1:${args.port}/mcp`);
});
await hub.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await hub.stop();
    process.exit(0);
  });
}
