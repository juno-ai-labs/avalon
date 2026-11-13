import { describe, expect, it } from 'vitest';
import { readAuthCallback } from './auth-callback';

const attempt = 'a'.repeat(43);
const proof = `ticket=abcdefghijklmnopqrst&region=global&attemptId=${attempt}`;
describe('system sign-in callback', () => {
  it('accepts only the current attempt at the registered callback', () => {
    expect(readAuthCallback(`rally-mobile://auth/complete?${proof}`, attempt)).toEqual({ ticket: 'abcdefghijklmnopqrst', region: 'global', attemptId: attempt });
    for (const url of [
      `https://auth/complete?${proof}`, `rally-mobile://other/complete?${proof}`,
      `rally-mobile://user@auth/complete?${proof}`, `rally-mobile://auth/other?${proof}`,
      `rally-mobile://auth/complete?${proof}#fragment`, `rally-mobile://auth/complete?${proof}&ticket=another-ticket`,
      `rally-mobile://auth/complete?${proof}&redirect=https://other.example`,
    ]) expect(() => readAuthCallback(url, attempt)).toThrow();
    expect(() => readAuthCallback(`rally-mobile://auth/complete?${proof}`, 'b'.repeat(43))).toThrow();
  });
});
