export {};

const button = document.querySelector<HTMLAnchorElement>('#open-avalon');
const error = document.querySelector<HTMLElement>('#open-error');
const parameters = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
const target = parameters.get('target');

function allowedTarget(value: string | null): value is string {
  if (!value || parameters.size !== 1 || parameters.getAll('target').length !== 1) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'avalon:' || url.search || url.hash || url.username || url.password || url.port) return false;
    if (url.hostname === 'workstreams') return /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(url.pathname);
    if (url.hostname === 'settings') return url.pathname === '/connections' || url.pathname === '/digest';
    return url.hostname === 'automations' && url.pathname === '/new';
  } catch {
    return false;
  }
}

window.history.replaceState(null, document.title, window.location.pathname);

if (button && allowedTarget(target)) {
  button.href = target;
  button.removeAttribute('aria-disabled');
} else {
  button?.setAttribute('hidden', '');
  error?.removeAttribute('hidden');
}
