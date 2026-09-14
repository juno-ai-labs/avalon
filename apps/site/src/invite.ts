import { isConfiguredRegion } from '@rally/contracts/regions';
import { reportDesktopHandoff } from './telemetry';

const button = document.querySelector<HTMLAnchorElement>('#open-rally');
const error = document.querySelector<HTMLElement>('#invite-error');
const parameters = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
const entries = [...parameters.entries()];
const token = parameters.get('token');
const region = parameters.get('region');
const valid =
  entries.length === 2
  && entries.every(([name]) => name === 'token' || name === 'region')
  && parameters.getAll('token').length === 1
  && parameters.getAll('region').length === 1
  && token !== null
  && /^[A-Za-z0-9_-]{20,500}$/u.test(token)
  && isConfiguredRegion(region);

// Remove the bearer-like invitation token from browser history/address UI as
// soon as it has been copied into local variables. It is never sent to the
// static host, rendered, or logged.
window.history.replaceState(null, document.title, window.location.pathname);

if (button && valid && token && region) {
  reportDesktopHandoff('invite', 'presented', 'valid');
  const deepLink = new URL('rallywithai://invitations/accept');
  deepLink.searchParams.set('region', region);
  deepLink.searchParams.set('token', token);
  button.href = deepLink.toString();
  button.removeAttribute('aria-disabled');
  button.addEventListener('click', () => reportDesktopHandoff('invite', 'manual', 'valid'));
} else {
  reportDesktopHandoff('invite', 'presented', 'invalid');
  button?.setAttribute('hidden', '');
  error?.removeAttribute('hidden');
}
