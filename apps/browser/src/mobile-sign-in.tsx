import { useState } from 'react';
import { Button, ErrorNotice, RallyMark } from '@rally/ui/components/primitives';
import { MobileAuthStartSchema, MobileAuthTicketSchema } from '@rally/contracts';
import { MOBILE_AUTH_CALLBACK, MOBILE_SIGN_IN_PATH } from '../../mobile/src/auth-contract';
import { IDENTITY_REGION } from '@rally/contracts/regions';
import { BrowserEntry } from './entry';
import { browserRequest } from './transport';

/** Binding in the path survives Google redirects and emailed sign-in links.
 * It carries no secret and needs no shared localStorage across browser tabs. */
export function MobileSignIn() {
  const [binding] = useState(() => {
    const parts = location.pathname.slice(MOBILE_SIGN_IN_PATH.length + 1).split('/');
    return parts.length === 2 ? MobileAuthStartSchema.safeParse({ attemptId: parts[0], codeChallenge: parts[1] }) : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!binding?.success) return <main className="onboarding-shell signin-shell"><section className="signin-card"><h1>Open Rally to sign in</h1><p>This sign-in link is incomplete. Close this window and try again from the app.</p></section></main>;
  async function complete() {
    if (busy || !binding?.success) return;
    setBusy(true); setError(null);
    try {
      const ticket = await browserRequest(IDENTITY_REGION, '/mobile/handoff', MobileAuthTicketSchema, binding.data);
      const callback = new URL(MOBILE_AUTH_CALLBACK);
      callback.search = new URLSearchParams(ticket).toString();
      location.assign(callback.href);
    } catch { setError('Sign-in couldn’t finish. Please try again.'); }
    finally { setBusy(false); }
  }
  return <BrowserEntry renderAuthenticated={(session, signOut) => <main className="onboarding-shell signin-shell entry">
    <section className="signin-card entry-card" aria-busy={busy}>
      <RallyMark className="signin-mark" />
      <h1>Continue to Rally</h1>
      <p className="signed-in-identity">Signed in as {session.user.email}</p>
      <Button className="button-primary signin-button" disabled={busy} onClick={() => { void complete(); }}>{busy ? 'Opening Rally…' : 'Continue to Rally'}</Button>
      <button className="text-button onboarding-signout" disabled={busy} onClick={signOut}>Use another account</button>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  </main>} />;
}
