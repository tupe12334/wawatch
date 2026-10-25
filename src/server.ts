import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import type { Hub, Message } from './hub.js';
import { createMcpServer, messageView } from './mcp.js';

export interface ServerOptions {
  hub: Hub;
  /** Folder with the built web UI (index.html). */
  webDir?: string;
  /** POST every new incoming message in a watched chat to this URL. */
  webhookUrl?: string;
  /** If set, webhook requests carry X-Wawatch-Signature: sha256=<hmac of body>. */
  webhookSecret?: string;
  /** Waits before each webhook retry. Tests shorten these. */
  webhookRetryDelays?: number[];
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Blocks cross-site requests from web pages the user visits: writes must be JSON
 * (forces a CORS preflight we never approve) and must not come from a foreign Origin.
 * Host-header checks against DNS rebinding come from createMcpExpressApp.
 */
function sameOriginWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: 'Foreign origin' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Use Content-Type: application/json' });
  next();
}

/** POSTs one webhook. Retries network errors, 5xx and 429 with backoff; other 4xx give up at once. */
async function deliverWebhook(url: string, headers: Record<string, string>, body: string, delays: number[]) {
  for (let attempt = 1; ; attempt++) {
    let retry = true;
    let why: string;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'X-Wawatch-Attempt': String(attempt) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      why = `HTTP ${res.status}`;
      retry = res.status >= 500 || res.status === 429;
    } catch (e) {
      why = (e as Error).message;
    }
    if (!retry || attempt > delays.length) {
      console.error(`Webhook failed after ${attempt} attempt(s): ${why}`);
      return;
    }
    await new Promise((r) => setTimeout(r, delays[attempt - 1]));
  }
}

export function createApp({ hub, webDir, webhookUrl, webhookSecret, webhookRetryDelays = [1000, 4000, 16000] }: ServerOptions) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.use(sameOriginWrites);

  // ---- MCP (Streamable HTTP, stateless) ----
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(hub);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST' }));

  // ---- UI + REST API ----
  const state = async () => ({
    status: hub.linkStatus,
    qr: hub.qr ? await QRCode.toDataURL(hub.qr, { margin: 1, width: 320 }) : undefined,
    signature: hub.signature,
    webhook: Boolean(webhookUrl),
    chats: hub.listChats(),
    messages: hub.read({ limit: 200 }),
  });

  app.get('/api/state', async (_req, res) => res.json(await state()));

  app.patch('/api/chats/:id', (req, res) => {
    const { watched, mayReply } = req.body ?? {};
    if ((watched !== undefined && typeof watched !== 'boolean') || (mayReply !== undefined && typeof mayReply !== 'boolean')) {
      return res.status(400).json({ error: 'watched and mayReply must be booleans' });
    }
    try {
      res.json(hub.setPermissions(req.params.id, { watched, mayReply }));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // Pair again after a logout. Not an MCP tool: only the web UI may unlink the saved session.
  app.post('/api/repair', async (_req, res) => {
    try {
      await hub.repair();
      res.json({ status: hub.linkStatus });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.patch('/api/signature', (req, res) => {
    const { signature } = req.body ?? {};
    if (typeof signature !== 'string') return res.status(400).json({ error: 'signature must be a string' });
    try {
      res.json({ signature: hub.setSignature(signature) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // For non-MCP agents: read and send over plain HTTP.
  app.get('/api/messages', (req, res) => {
    const since = req.query.since === undefined ? undefined : Number(req.query.since);
    const msgs = hub.read({ since, chatId: req.query.chat_id as string | undefined, limit: Number(req.query.limit) || 50 });
    res.json({ messages: msgs.map(messageView), cursor: msgs.at(-1)?.seq ?? hub.cursor });
  });

  app.post('/api/send', async (req, res) => {
    const { chat_id, text } = req.body ?? {};
    if (typeof chat_id !== 'string' || typeof text !== 'string') {
      return res.status(400).json({ error: 'chat_id and text must be strings' });
    }
    try {
      res.json({ sent: messageView(await hub.send(chat_id, text)) });
    } catch (e) {
      res.status(403).json({ error: (e as Error).message });
    }
  });

  // Live updates for the UI (Server-Sent Events).
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const onState = () => res.write('event: state\ndata: {}\n\n');
    const onMessage = (m: Message) => {
      if (m.fromAgent || hub.getChat(m.chatId)?.watched) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    hub.on('state', onState);
    hub.on('message', onMessage);
    req.on('close', () => {
      clearInterval(ping);
      hub.off('state', onState);
      hub.off('message', onMessage);
    });
  });

  if (webDir && existsSync(webDir)) app.use(express.static(webDir));

  // ---- outbound webhook ----
  if (webhookUrl) {
    hub.on('message', (m: Message) => {
      if (m.fromAgent || m.history || !hub.getChat(m.chatId)?.watched) return;
      const body = JSON.stringify({ event: 'message', message: messageView(m) });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (webhookSecret) headers['X-Wawatch-Signature'] = 'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex');
      void deliverWebhook(webhookUrl, headers, body, webhookRetryDelays);
    });
  }

  return app;
}
