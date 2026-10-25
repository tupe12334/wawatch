import type { WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { messageText, nextBackoff } from '../src/baileys.js';

const msg = (message: WAMessage['message']) => ({ key: { id: 'x', remoteJid: '1@s.whatsapp.net' }, message }) as WAMessage;

describe('nextBackoff', () => {
  it('doubles the reconnect delay and caps it at 60 s', () => {
    expect(nextBackoff(2000)).toBe(4000);
    expect(nextBackoff(32000)).toBe(60000);
    expect(nextBackoff(60000)).toBe(60000);
  });
});

describe('messageText', () => {
  it('reads plain, extended and caption text', () => {
    expect(messageText(msg({ conversation: 'hi' }))).toBe('hi');
    expect(messageText(msg({ extendedTextMessage: { text: 'link https://x.y' } }))).toBe('link https://x.y');
    expect(messageText(msg({ imageMessage: { caption: 'view' } }))).toBe('view');
  });

  it('uses a placeholder for media without text and skips protocol messages', () => {
    expect(messageText(msg({ audioMessage: {} }))).toBe('[audio]');
    expect(messageText(msg({ protocolMessage: {} }))).toBeUndefined();
    expect(messageText(msg(undefined))).toBeUndefined();
  });
});
