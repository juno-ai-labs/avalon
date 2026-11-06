import type { ConnectorOAuthProviderValue } from '@rally/contracts/connector-oauth-providers';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
import { reportDesktopHandoff } from './telemetry';

type ConnectorProvider = ConnectorOAuthProviderValue;

const connectorName: Record<ConnectorProvider, string> = {
  // A configured MCP server has no name Rally knows: the label the person gave
  // it lives on the connection, which this page never loads.
  custom_mcp: 'The MCP server',
  google: 'Google',
  github: 'GitHub',
  apollo: 'Apollo.io',
  ashby: 'Ashby',
  canva: 'Canva',
  fireflies: 'Fireflies',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
};

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
    || fragmentParameters.getAll('target').length !== 1
  ) return null;

  const rawTarget = fragmentParameters.get('target');
  if (!rawTarget) return null;

  const intent = parseDesktopDeepLinkIntent(rawTarget);
  return intent?.kind === 'identity-result' || intent?.kind === 'connector-result'
    ? new URL(rawTarget).toString()
    : null;
}

function initializeHandoff(): void {
  const link = document.querySelector<HTMLAnchorElement>('#open-rally');
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
    status.dataset.tone = 'error';
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
    status.dataset.tone = 'error';
    help.textContent = 'Rally will show the authorization result and let you try again.';
  } else if (error) {
    status.textContent = 'Sign-in could not be completed. Opening Rally…';
    status.dataset.tone = 'error';
    help.textContent = 'Return to Rally and try signing in again.';
  } else {
    status.textContent = 'Sign-in is complete. Opening Rally…';
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
