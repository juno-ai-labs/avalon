import { describe, expect, it } from 'vitest';

import { openResourceRequest, openResourceState } from './navigation-routes';

describe('navigation routes', () => {
  it('reads back the artifact a navigation asked a conversation to open, and nothing else', () => {
    expect(openResourceRequest(openResourceState('canvas', 'sheet'))).toEqual({ conversationId: 'canvas', resourceId: 'sheet' });
    expect(openResourceRequest({ openResource: { threadId: 'canvas', resourceId: 'sheet' } })).toBeNull();
    expect(openResourceRequest(null)).toBeNull();
  });
});
