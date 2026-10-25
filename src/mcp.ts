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

/** One MCP server per request (stateless Streamable HTTP); all share the hub. */
export function createMcpServer(hub: Hub) {
  const server = new McpServer({ name: 'wawatch', version: '0.1.0' });

  server.registerTool(
    'status',
    { description: 'WhatsApp link status, the signature added to sent messages, and the current cursor.' },
    async () => json({ status: hub.linkStatus, signature: hub.signature, cursor: hub.cursor }),
  );

  server.registerTool(
    'list_chats',
    {
      description:
        'List WhatsApp chats with their permissions. watched = the agent may read it; may_reply = the agent may send to it (only the user can grant this, in the wawatch UI).',
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
      description: 'Start reading a chat. The user sees every watched chat in the wawatch UI. Does not allow sending.',
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
    { description: 'Stop reading a chat. This also removes its "may reply" permission.', inputSchema: { chat_id: z.string() } },
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
        'Read messages from watched chats. Without `since`, returns the latest messages. With `since`, returns messages after that cursor. Returns a `cursor` to pass next time.',
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
        'Block until a new message arrives in any watched chat, then return it (long-poll). Returns an empty list on timeout; call again to keep listening. Pass the returned `cursor` as `since` so no message is missed between calls.',
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
        'Send a text message to a chat. Allowed only when the user turned on "may reply" for that chat. The configured signature is prepended. Text is sent exactly as given (multi-line is fine).',
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
