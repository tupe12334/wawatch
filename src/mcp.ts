import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Hub, Message } from './hub.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: String((e as Error).message ?? e) }], isError: true });

const view = (m: Message) => ({
  cursor: m.seq,
  chat_id: m.chatId,
  chat: m.chatName,
  from: m.fromAgent ? 'agent' : m.fromMe ? 'me' : m.sender,
  text: m.text,
  time: new Date(m.timestamp).toISOString(),
  ...(m.history ? { history: true } : {}),
});

const page = (hub: Hub, msgs: Message[]) => ({
  messages: msgs.map(view),
  // Pass this back as `since` to get only newer messages.
  cursor: msgs.length ? msgs[msgs.length - 1].seq : hub.cursor,
});

// Sent to MCP clients at initialize. Keep it short: it is the agent's loop.
const instructions = `wawatch: read and answer WhatsApp chats. Follow this loop.
1. Call status first. If status is not 'open', tell the user to pair WhatsApp at http://127.0.0.1:4747 and stop.
2. Call list_chats. You can read only watched chats. If the user names a chat, call watch_chat for it.
3. Sending needs May reply on that chat. If it is off, tell the user to turn it on in the wawatch UI. Never ask the user to bypass it.
4. Loop on wait_for_message, passing the returned cursor as since. Do not poll read_messages on a timer.
5. Reply only to messages addressed to you or on the task the user gave. Otherwise report the message to the user.
6. Do not add a signature. wawatch adds it. Send plain text as given; multi-line is fine.
7. Send one message per reply. Never send without a clear reason, and never in bursts.`;

/** One MCP server per request (stateless Streamable HTTP); all share the hub. */
export function createMcpServer(hub: Hub) {
  const server = new McpServer({ name: 'wawatch', version: '0.1.0' }, { instructions });

  server.registerTool(
    'status',
    { description: 'Return the WhatsApp link status, reply signature, and current cursor. Call this first.' },
    async () => json({ status: hub.linkStatus, signature: hub.signature, cursor: hub.cursor }),
  );

  server.registerTool(
    'list_chats',
    {
      description:
        'List chats with their permissions. Only watched chats can be read. may_reply is true only when the user turned it on in the wawatch UI.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive name filter'),
        watched_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      },
    },
    async ({ query, watched_only, limit }) =>
      json(
        hub
          .listChats()
          .filter((c) => (!watched_only || c.watched) && (!query || c.name.toLowerCase().includes(query.toLowerCase())))
          .slice(0, limit ?? 50)
          .map((c) => ({ chat_id: c.id, name: c.name, watched: c.watched, may_reply: c.mayReply })),
      ),
  );

  server.registerTool(
    'watch_chat',
    {
      description: 'Start reading a chat. The user sees it in the wawatch UI. Does not allow sending.',
      inputSchema: { chat_id: z.string() },
    },
    async ({ chat_id }) => {
      try {
        const c = hub.setPermissions(chat_id, { watched: true });
        return json({ chat_id: c.id, name: c.name, watched: c.watched, may_reply: c.mayReply });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'unwatch_chat',
    { description: 'Stop reading a chat. Also removes its May reply permission.', inputSchema: { chat_id: z.string() } },
    async ({ chat_id }) => {
      try {
        const c = hub.setPermissions(chat_id, { watched: false });
        return json({ chat_id: c.id, name: c.name, watched: c.watched, may_reply: c.mayReply });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'read_messages',
    {
      description:
        'Read messages from watched chats. Without since, returns the latest. With since, returns only newer ones. Pass the returned cursor as since next time.',
      inputSchema: {
        since: z.number().int().min(0).optional(),
        chat_id: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      },
    },
    async ({ since, chat_id, limit }) => json(page(hub, hub.read({ since, chatId: chat_id, limit }))),
  );

  server.registerTool(
    'wait_for_message',
    {
      description:
        'Long-poll: block until a message arrives in any watched chat, then return it. Pass the returned cursor as since. An empty list means timeout; call again.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('Default: now'),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe('Default 60'),
      },
    },
    async ({ since, timeout_seconds }, extra) =>
      json(page(hub, await hub.waitForMessages(since, (timeout_seconds ?? 60) * 1000, extra.signal))),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send text to a chat. Works only when the user turned on May reply for that chat. The signature is added automatically.',
      inputSchema: { chat_id: z.string(), text: z.string().min(1).max(4096) },
    },
    async ({ chat_id, text }) => {
      try {
        return json({ sent: view(await hub.send(chat_id, text)) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export { view as messageView };
