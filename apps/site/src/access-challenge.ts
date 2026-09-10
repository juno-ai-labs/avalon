interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string; action: string; theme: string;
    callback(token: string): void;
    'expired-callback'(): void;
    'error-callback'(): void;
  }): string;
  reset(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }
declare const __RALLY_TURNSTILE_SITE_KEY__: string;

export function accessChallenge(onChange: (token: string | null) => void, onError: () => void): { reset(): void } {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local) { onChange('local-development'); return { reset: () => onChange('local-development') }; }
  const container = document.querySelector<HTMLElement>('#access-challenge');
  let widget: string | undefined;
  if (!container || !__RALLY_TURNSTILE_SITE_KEY__) { onError(); return { reset: () => {} }; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.addEventListener('error', onError);
  script.addEventListener('load', () => {
    if (!window.turnstile) { onError(); return; }
    widget = window.turnstile.render(container, {
      sitekey: __RALLY_TURNSTILE_SITE_KEY__, action: 'access_request', theme: 'dark',
      callback: onChange, 'expired-callback': () => onChange(null),
      'error-callback': () => { onChange(null); onError(); },
    });
  });
  document.head.append(script);
  return { reset: () => { onChange(null); if (widget !== undefined) window.turnstile?.reset(widget); } };
}
