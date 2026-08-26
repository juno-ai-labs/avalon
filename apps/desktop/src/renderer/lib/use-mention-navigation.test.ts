import { describe, expect, it } from 'vitest';

import { draftWithMentionStarted } from './use-mention-navigation';

describe('mention toolbar insertion', () => {
  it('replaces a non-collapsed textarea selection', () => {
    expect(draftWithMentionStarted('Ask Samantha today', 4, 12)).toEqual({
      value: 'Ask @ today',
      caret: 5,
    });
  });
});
