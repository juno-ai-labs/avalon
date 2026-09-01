import { reportDesktopHandoff } from './telemetry';
import { parseWorkspaceTarget } from '@rally/contracts/workspace-target';

export function parseSlackLinkFragment(fragment: string): {
  token: string;
  workspaceTarget: ReturnType<typeof parseWorkspaceTarget>;
} | null {
  const parameters = new URLSearchParams(fragment.replace(/^#/u, ''));
  const entries = [...parameters.entries()];
  const token = parameters.get('token');
  const workspaceTarget = parseWorkspaceTarget(parameters);
  const validLegacy = entries.length === 1 && entries[0]?.[0] === 'token';
  const validAddressed = entries.length === 3
    && entries.every(([name]) => name === 'token' || name === 'region' || name === 'workspace')
    && workspaceTarget !== null;
  return (validLegacy || validAddressed)
    && parameters.getAll('token').length === 1
    && token !== null
    && /^[A-Za-z0-9_-]{20,500}$/u.test(token)
    ? { token, workspaceTarget }
    : null;
}

function initializeSlackLink(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-rally');
  const error = document.querySelector<HTMLElement>('#slack-link-error');
  const parsed = parseSlackLinkFragment(window.location.hash);

  // Keep the single-use bearer token out of the HTTP request, rendered DOM,
  // and browser history after constructing the local desktop handoff.
  window.history.replaceState(null, document.title, window.location.pathname);

  if (button && parsed) {
    reportDesktopHandoff('slack', 'presented', 'valid');
    const deepLink = new URL('rallywithai://slack/link');
    deepLink.searchParams.set('token', parsed.token);
    if (parsed.workspaceTarget) {
      deepLink.searchParams.set('region', parsed.workspaceTarget.region);
      deepLink.searchParams.set('workspace', parsed.workspaceTarget.workspaceId);
    }
    button.href = deepLink.toString();
    button.removeAttribute('aria-disabled');
    button.addEventListener('click', () => reportDesktopHandoff('slack', 'manual', 'valid'));
  } else {
    reportDesktopHandoff('slack', 'presented', 'invalid');
    button?.setAttribute('hidden', '');
    error?.removeAttribute('hidden');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') initializeSlackLink();
