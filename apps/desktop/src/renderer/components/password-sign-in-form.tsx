import { KeyRound, LoaderCircle, Mail } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { PasswordLoginRequest } from '@rally/contracts/password-login';
import { Button, ErrorNotice } from './primitives';

/** Both hosts collect the same proof; each host owns its session transport. */
export function PasswordSignInForm({ onSubmit, onBack, disabled = false }: {
  onSubmit: (input: PasswordLoginRequest) => Promise<void>;
  onBack: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = busy || disabled;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (unavailable) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ email: email.trim().toLowerCase(), password });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in could not be completed. Try again.');
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return <form onSubmit={(event) => { void submit(event); }}>
    <label className="onboarding-field"><span>Email</span><span className="onboarding-input-wrap">
      <Mail aria-hidden="true" size={16} />
      <input type="email" name="email" autoComplete="username" placeholder="you@company.com" required
        disabled={unavailable} value={email} onChange={(event) => setEmail(event.target.value)} />
    </span></label>
    <label className="onboarding-field"><span>Password</span><span className="onboarding-input-wrap">
      <KeyRound aria-hidden="true" size={16} />
      <input type="password" name="password" autoComplete="current-password" required
        disabled={unavailable} value={password} onChange={(event) => setPassword(event.target.value)} />
    </span></label>
    <Button className="button-primary signin-button" type="submit" disabled={unavailable}>
      {busy && <LoaderCircle aria-hidden="true" className="spin" size={16} />}{busy ? 'Signing in…' : 'Sign in'}
    </Button>
    <button className="text-button onboarding-signout" type="button" disabled={unavailable} onClick={onBack}>Other sign-in options</button>
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </form>;
}
