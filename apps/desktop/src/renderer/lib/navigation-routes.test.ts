import { describe, expect, it } from 'vitest';

import { channelRoute, homeChannelId, threadRoute } from './navigation-routes';

describe('navigation routes', () => {
  it('places a thread under its Channel, with its breakout, or on its own without one', () => {
    expect(channelRoute('a b')).toBe('/channels/a%20b');
    expect(threadRoute('t', 'c')).toBe('/channels/c/threads/t');
    expect(threadRoute('t', 'c', 'b')).toBe('/channels/c/threads/t?substream=b');
    expect(threadRoute('t', 'c', '0')).toBe('/channels/c/threads/t');
    expect(threadRoute('t', null)).toBe('/workstreams/t');
  });

  it('keeps a thread under the Channel asked for when it sits there, else its first', () => {
    expect(homeChannelId(['one', 'two'], 'two')).toBe('two');
    expect(homeChannelId(['one', 'two'], 'three')).toBe('one');
    expect(homeChannelId([], 'two')).toBeNull();
  });
});
