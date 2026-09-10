import { accessCopy } from './access-copy';

interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string; action: string;
    theme: 'light' | 'dark' | 'auto';
    appearance: 'always' | 'execute' | 'interaction-only';
    callback(token: string): void;
    'expired-callback'(): void;
    'error-callback'(): void;
  }): string;
  reset(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }
declare const __RALLY_TURNSTILE_SITE_KEY__: string;

// The widget is interaction-only, so Cloudflare reveals it only when the visitor
// has to interact. Spacing and the screen-reader note follow its rendered height
// rather than Turnstile's callbacks; see docs/private-access.md.
function followWidget(container: HTMLElement, note: HTMLElement | null): void {
  new ResizeObserver((entries) => {
    const revealed = entries.some((entry) => entry.contentRect.height > 0);
    if (revealed) container.dataset.revealed = ''; else delete container.dataset.revealed;
    if (note) note.textContent = revealed ? accessCopy.verification : '';
  }).observe(container);
}

export function accessChallenge(onChange: (token: string | null) => void, onError: () => void): { reset(): void } {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local) { onChange('local-development'); return { reset: () => onChange('local-development') }; }
  const container = document.querySelector<HTMLElement>('#access-challenge');
  let widget: string | undefined;
  if (!container || !__RALLY_TURNSTILE_SITE_KEY__) { onError(); return { reset: () => {} }; }
  const note = document.querySelector<HTMLElement>('#access-challenge-note');
  followWidget(container, note);
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.addEventListener('error', onError);
  script.addEventListener('load', () => {
    if (!window.turnstile) { onError(); return; }
    widget = window.turnstile.render(container, {
      sitekey: __RALLY_TURNSTILE_SITE_KEY__, action: 'access_request', theme: 'dark', appearance: 'interaction-only',
      // A proof ends the ask even though Cloudflare leaves a passed widget in view.
      callback: (token) => { if (note) note.textContent = ''; onChange(token); },
      'expired-callback': () => onChange(null),
      'error-callback': () => { onChange(null); onError(); },
    });
  });
  document.head.append(script);
  return { reset: () => { onChange(null); if (widget !== undefined) window.turnstile?.reset(widget); } };
}
