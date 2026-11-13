import { describe, expect, it, vi } from 'vitest';
import { ChromeTransport, tokenMatches } from '../src/chrome.js';

describe('tokenMatches', () => {
  it('accepts only the exact bridge token', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc124', 'abc123')).toBe(false);
    expect(tokenMatches('abc12', 'abc123')).toBe(false);
    expect(tokenMatches(null, 'abc123')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});

describe('ChromeTransport echo', () => {
  it('drops the fromMe echo of a message the agent just sent, once', () => {
    const t = new ChromeTransport('/nonexistent');
    const message = vi.fn();
    // ponytail: reach the private socket/sink/receive directly instead of a real WebSocket.
    const priv = t as unknown as { sink: unknown; socket: unknown; receive(raw: string): void };
    priv.sink = { message };
    priv.socket = { send() {} };
    void t.send('111@c.us', 'hi').catch(() => {});
    const echo = { id: 'k1', chatId: '111@c.us', sender: 'me', fromMe: true, text: 'hi', timestamp: 1 };
    priv.receive(JSON.stringify({ type: 'message', message: echo }));
    expect(message).not.toHaveBeenCalled();
    priv.receive(JSON.stringify({ type: 'message', message: echo })); // sent from the phone: recorded
    expect(message).toHaveBeenCalledWith(echo);
    priv.receive(JSON.stringify({ type: 'sent', reqId: 1, messageId: 'k1' })); // settles send(), clears its 30 s timer
  });
});
