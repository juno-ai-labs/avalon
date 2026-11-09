import { vi } from 'vitest';
import type { Env } from '../../src/env';

/** The external provider binding is doubled; routes, claims and SQL stay real. */
export function mockAccessMail(env: Env) {
  const mail = vi.fn<(message: EmailMessageBuilder) => Promise<EmailSendResult>>();
  env.EMAIL = { send: mail };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ success: true, hostname: 'rallywith.ai', action: 'access_request' }));
  return mail;
}
