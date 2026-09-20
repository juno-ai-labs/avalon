import { describe, expect, it } from 'vitest';

import { SessionImportRequestSchema } from './substream-content';

const request = {
  title: 'Imported research',
  source: { provider: 'chatgpt' as const, url: 'https://chatgpt.com/share/example' },
  content: { messages: [{ role: 'user' as const, text: 'Hello' }] },
  clientMessageId: '00000000-0000-4000-8000-000000000001',
  spaceIds: ['00000000-0000-7000-8000-000000000002'],
};

describe('SessionImportRequestSchema', () => {
  it('matches Channel creation limits for the imported title', () => {
    expect(SessionImportRequestSchema.safeParse({ ...request, title: 'x'.repeat(181) }).success).toBe(false);
  });

  it('refuses duplicate destination Spaces', () => {
    expect(SessionImportRequestSchema.safeParse({
      ...request,
      spaceIds: [request.spaceIds[0], request.spaceIds[0]],
    }).success).toBe(false);
  });
});
