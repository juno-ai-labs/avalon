import { ConnectorOAuthProviders } from '@rally/contracts/connector-oauth-providers';
import { isDesktopDeepLinkProtocol } from '@rally/contracts/desktop-deep-link';
import { reportDesktopHandoff } from './telemetry';

const DESKTOP_HOST = 'auth';
const DESKTOP_PATH = '/complete';
const TICKET_PATTERN = /^[A-Za-z0-9_-]{20,500}$/u;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ERROR_PATTERN = /^[a-z0-9_-]{1,100}$/u;
const CONNECTION_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
type ConnectorProvider = (typeof ConnectorOAuthProviders)[number];

const connectorName: Record<ConnectorProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
};

const hasSingleValue = (parameters: URLSearchParams, name: string): boolean =>
  parameters.getAll(name).length === 1;

/**
 * Accept only the exact desktop authentication deep-link forms emitted by the
 * Rally API. The returned value is intentionally opaque to the UI.
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
    !isDesktopDeepLinkProtocol(target.protocol)
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
  const connection = target.searchParams.get('connection');
  const provider = target.searchParams.get('provider');
  const status = target.searchParams.get('status');
  const validRegion = region === 'global' || region === 'eu';
  const validProvider = ConnectorOAuthProviders.some((candidate) => candidate === provider);

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

  const validConnectorSuccessTarget =
    entries.length >= 4
    && entries.length <= 5
    && entries.every(([name]) => ['connection', 'status', 'region', 'attempt', 'provider'].includes(name))
    && ['connection', 'status', 'region', 'provider'].every((name) => hasSingleValue(target.searchParams, name))
    && connection !== null
    && CONNECTION_PATTERN.test(connection)
    && status === 'connected'
    && validRegion
    && (attempt === null || (hasSingleValue(target.searchParams, 'attempt') && ATTEMPT_PATTERN.test(attempt)))
    && validProvider
    && ticket === null
    && error === null;

  const validConnectorErrorTarget =
    entries.length >= 4
    && entries.length <= 5
    && entries.every(([name]) => ['status', 'error', 'region', 'attempt', 'provider'].includes(name))
    && ['status', 'error', 'region', 'provider'].every((name) => hasSingleValue(target.searchParams, name))
    && (status === 'denied' || status === 'failed')
    && error !== null
    && ERROR_PATTERN.test(error)
    && validRegion
    && validProvider
    && connection === null
    && ticket === null
    && (
      attempt === null
      || (hasSingleValue(target.searchParams, 'attempt') && ATTEMPT_PATTERN.test(attempt))
    );

  return validTicketTarget || validErrorTarget || validConnectorSuccessTarget || validConnectorErrorTarget
    ? target.toString()
    : null;
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
    reportDesktopHandoff('auth', 'presented', 'invalid');
    status.textContent = 'This sign-in response is incomplete or invalid.';
    help.textContent = 'Return to the Rally desktop app and start sign-in again.';
    link.removeAttribute('href');
    return;
  }

  reportDesktopHandoff('auth', 'presented', 'valid');

  const parsedTarget = new URL(target);
  const provider = parsedTarget.searchParams.get('provider') as ConnectorProvider | null;
  const result = parsedTarget.searchParams.get('status');
  const error = parsedTarget.searchParams.get('error');
  if (provider && result === 'connected') {
    status.textContent = `${connectorName[provider]} is connected. Opening the Rally desktop app…`;
  } else if (provider && error) {
    status.textContent = `${connectorName[provider]} could not be connected. Opening Rally…`;
    help.textContent = 'Rally will show the authorization result and let you try again.';
  } else if (error) {
    status.textContent = 'Sign-in could not be completed. Opening Rally…';
    help.textContent = 'Rally will show the sign-in result and let you try again.';
  } else {
    status.textContent = 'Sign-in is complete. Opening the Rally desktop app…';
  }
  link.href = target;
  link.setAttribute('aria-disabled', 'false');

  let attempted = false;
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    reportDesktopHandoff('auth', 'automatic', 'valid');
    window.location.assign(target);
  };

  link.addEventListener('click', () => {
    attempted = true;
    reportDesktopHandoff('auth', 'manual', 'valid');
    status.textContent = 'Opening Rally…';
  });
  window.setTimeout(openOnce, 120);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') initializeHandoff();
