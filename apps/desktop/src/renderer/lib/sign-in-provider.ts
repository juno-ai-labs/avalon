/** The OAuth providers a person signs in with; the API's `LoginProvider`. */
export type SignInProvider = 'google' | 'apple';

const providerName: Record<SignInProvider, string> = { google: 'Google', apple: 'Apple' };

/** The provider a sign-in failure code names, from its `google_`/`apple_` prefix. */
export function signInProviderOfCode(code: string): SignInProvider | null {
  if (code.startsWith('google_')) return 'google';
  if (code.startsWith('apple_')) return 'apple';
  return null;
}

/**
 * What a failed provider sign-in says, by the code its callback returned. One
 * wording for the desktop and the browser; `fallback` is each host's own advice
 * for an unnamed failure, since only the browser offers email sign-in.
 */
export function providerSignInError(provider: SignInProvider, code: string, fallback: string): string {
  const name = providerName[provider];
  if (code === `${provider}_oauth_denied`) return `${name} sign-in was cancelled.`;
  if (code === `${provider}_state_mismatch` || code === 'invalid_oauth_state') return `That ${name} sign-in expired. Try again.`;
  if (code === `${provider}_email_in_use`) return `This ${name} account's email address is already used by another Rally account.`;
  return `${name} sign-in did not complete. ${fallback}`;
}

const REMEMBERED_PROVIDER_KEY = 'rally.sign-in-provider';

/**
 * Remembers which provider this device last started a sign-in with, so that
 * reconnecting the account identity later reopens that provider rather than
 * always Google. Recorded at the start, since the ticket exchange does not
 * say which provider verified the person, so a sign-in started and then
 * abandoned still counts. A missing or blocked store reconnects through
 * Google, as before Apple sign-in existed.
 */
export function rememberSignInProvider(provider: SignInProvider): void {
  try { window.localStorage.setItem(REMEMBERED_PROVIDER_KEY, provider); } catch { /* Reconnect falls back to Google. */ }
}

export function rememberedSignInProvider(): SignInProvider {
  try {
    return window.localStorage.getItem(REMEMBERED_PROVIDER_KEY) === 'apple' ? 'apple' : 'google';
  } catch {
    return 'google';
  }
}
