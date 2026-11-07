import { describe, expect, it } from 'vitest';
import { canvasNeedsAttention, sidekickNeedsAttention } from './sidebar-attention';

describe('canvasNeedsAttention', () => {
  it('counts a Canvas only when it holds something unread', () => {
    expect(canvasNeedsAttention({ unread: true })).toBe(true);
    expect(canvasNeedsAttention({ unread: false })).toBe(false);
  });
});

describe('sidekickNeedsAttention', () => {
  it('counts a Sidekick waiting on input or holding something unread', () => {
    expect(sidekickNeedsAttention({ needsInput: true, unread: false })).toBe(true);
    expect(sidekickNeedsAttention({ needsInput: false, unread: true })).toBe(true);
    expect(sidekickNeedsAttention({ needsInput: true, unread: true })).toBe(true);
    expect(sidekickNeedsAttention({ needsInput: false, unread: false })).toBe(false);
    expect(sidekickNeedsAttention({})).toBe(false);
  });
});
