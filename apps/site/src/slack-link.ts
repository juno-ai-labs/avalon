import { reportDesktopHandoff } from './telemetry';

const button = document.querySelector<HTMLAnchorElement>('#open-avalon');
const error = document.querySelector<HTMLElement>('#slack-link-error');
const parameters = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
const entries = [...parameters.entries()];
const token = parameters.get('token');
const valid =
  entries.length === 1
  && entries[0]?.[0] === 'token'
  && parameters.getAll('token').length === 1
  && token !== null
  && /^[A-Za-z0-9_-]{20,500}$/u.test(token);

// Keep the single-use bearer token out of the HTTP request, rendered DOM, and
// browser history after constructing the local desktop handoff.
window.history.replaceState(null, document.title, window.location.pathname);

if (button && valid && token) {
  reportDesktopHandoff('slack', 'presented', 'valid');
  const deepLink = new URL('rallywithai://slack/link');
  deepLink.searchParams.set('token', token);
  button.href = deepLink.toString();
  button.removeAttribute('aria-disabled');
  button.addEventListener('click', () => reportDesktopHandoff('slack', 'manual', 'valid'));
} else {
  reportDesktopHandoff('slack', 'presented', 'invalid');
  button?.setAttribute('hidden', '');
  error?.removeAttribute('hidden');
}
