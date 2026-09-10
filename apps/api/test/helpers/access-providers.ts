import { vi } from 'vitest';

/** Only external HTTP is doubled; routes, claims and schema execute normally. */
export function mockAccessMail() {
  const mail = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json({ success: true, hostname: 'rallywith.ai', action: 'access_request' });
    }
    return mail(input, init);
  });
  return mail;
}
