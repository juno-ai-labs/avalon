const DESKTOP_PROTOCOL = 'avalon:';
const DESKTOP_HOST = 'auth';
const DESKTOP_PATH = '/complete';
const TICKET_PATTERN = /^[A-Za-z0-9_-]{20,500}$/u;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ERROR_PATTERN = /^[a-z0-9_-]{1,100}$/u;

const hasSingleValue = (parameters: URLSearchParams, name: string): boolean =>
  parameters.getAll(name).length === 1;

/**
 * Accept only the exact desktop authentication deep-link forms emitted by the
 * Avalon API. The returned value is intentionally opaque to the UI.
 */
export function parseDesktopTarget(fragment: string): string | null {
  if (!fragment.startsWith('#')) return null;
  const fragmentValue = fragment.slice(1);
  const fragmentParameters = new URLSearchParams(fragmentValue);
  const fragmentEntries = [...fragmentParameters.entries()];
  if (
    fragmentEntries.length !== 1
    || fragmentEntries[0]?.[0] !== 'target'
    || !hasSingleValue(fragmentParameters, 'target')
  ) return null;

  const rawTarget = fragmentParameters.get('target');
  if (!rawTarget) return null;

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return null;
  }

  if (
    target.protocol !== DESKTOP_PROTOCOL
    || target.hostname !== DESKTOP_HOST
    || target.pathname !== DESKTOP_PATH
    || target.username !== ''
    || target.password !== ''
    || target.port !== ''
    || target.hash !== ''
  ) return null;

  const entries = [...target.searchParams.entries()];
  const ticket = target.searchParams.get('ticket');
  const error = target.searchParams.get('error');
  const region = target.searchParams.get('region');
  const attempt = target.searchParams.get('attempt');
  const validRegion = region === 'global' || region === 'eu';

  const validTicketTarget =
    entries.length === 3
    && entries.every(([name]) => name === 'ticket' || name === 'region' || name === 'attempt')
    && hasSingleValue(target.searchParams, 'ticket')
    && hasSingleValue(target.searchParams, 'region')
    && hasSingleValue(target.searchParams, 'attempt')
    && error === null
    && ticket !== null
    && TICKET_PATTERN.test(ticket)
    && attempt !== null
    && ATTEMPT_PATTERN.test(attempt)
    && validRegion;

  const validErrorTarget =
    entries.length >= 1
    && entries.length <= 3
    && entries.every(([name]) => name === 'error' || name === 'region' || name === 'attempt')
    && hasSingleValue(target.searchParams, 'error')
    && ticket === null
    && error !== null
    && ERROR_PATTERN.test(error)
    && (region === null || (hasSingleValue(target.searchParams, 'region') && validRegion))
    && (
      attempt === null
      || (
        region !== null
        && hasSingleValue(target.searchParams, 'attempt')
        && ATTEMPT_PATTERN.test(attempt)
      )
    );

  return validTicketTarget || validErrorTarget ? target.toString() : null;
}

function initializeHandoff(): void {
  const link = document.querySelector<HTMLAnchorElement>('#open-avalon');
  const status = document.querySelector<HTMLElement>('#auth-status');
  const help = document.querySelector<HTMLElement>('#auth-help');
  if (!link || !status || !help) return;

  const target = parseDesktopTarget(window.location.hash);

  // Remove the single-use ticket from the browser address bar and history as
  // soon as it has been validated. It is never rendered or logged.
  window.history.replaceState(null, document.title, window.location.pathname);

  if (!target) {
    status.textContent = 'This sign-in response is incomplete or invalid.';
    help.textContent = 'Return to the Avalon desktop app and start sign-in again.';
    link.removeAttribute('href');
    return;
  }

  status.textContent = 'Sign-in is complete. Opening the Avalon desktop app…';
  link.href = target;
  link.setAttribute('aria-disabled', 'false');

  let attempted = false;
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    window.location.assign(target);
  };

  link.addEventListener('click', () => {
    attempted = true;
    status.textContent = 'Opening Avalon…';
  });
  window.setTimeout(openOnce, 120);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') initializeHandoff();
