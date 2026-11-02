import { describe, expect, it } from 'vitest';
import { tokenMatches } from '../src/chrome.js';

describe('tokenMatches', () => {
  it('accepts only the exact bridge token', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc124', 'abc123')).toBe(false);
    expect(tokenMatches('abc12', 'abc123')).toBe(false);
    expect(tokenMatches(null, 'abc123')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});
