import { isDesktopDeepLinkProtocol } from '@rally/contracts/desktop-deep-link';
import { parseWorkspaceTarget } from '@rally/contracts/workspace-target';
import { reportDesktopHandoff } from './telemetry';

type DesktopHandoffType = Parameters<typeof reportDesktopHandoff>[0];

export function classifyDesktopHandoffTarget(value: string | null): {
  handoffType: DesktopHandoffType;
  validity: 'valid' | 'invalid';
} {
  if (!value) return { handoffType: 'unknown', validity: 'invalid' };
  try {
    const url = new URL(value);
    const handoffType: DesktopHandoffType = url.hostname === 'workstreams'
      ? 'workstream'
      : url.hostname === 'settings'
        ? 'settings'
        : url.hostname === 'automations' ? 'automation' : 'unknown';
    const workspaceTarget = parseWorkspaceTarget(url.searchParams);
    const validRouting = !url.search || (
      [...url.searchParams.keys()].length === 2
      && [...url.searchParams.keys()].every((key) => key === 'region' || key === 'workspace')
      && workspaceTarget !== null
    );
    const commonValid = isDesktopDeepLinkProtocol(url.protocol)
      && validRouting && !url.hash && !url.username && !url.password && !url.port;
    const targetValid = handoffType === 'workstream'
      ? /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(url.pathname)
      : handoffType === 'settings'
        ? url.pathname === '/workspace' || url.pathname === '/connections' || url.pathname === '/digest'
        : handoffType === 'automation' && url.pathname === '/new';
    return { handoffType, validity: commonValid && targetValid ? 'valid' : 'invalid' };
  } catch {
    return { handoffType: 'unknown', validity: 'invalid' };
  }
}

function initializeDesktopHandoff(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-rally');
  const error = document.querySelector<HTMLElement>('#open-error');
  const parameters = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
  const target = parameters.get('target');
  const classification = classifyDesktopHandoffTarget(target);
  const exactParameter = parameters.size === 1 && parameters.getAll('target').length === 1;
  const valid = exactParameter && classification.validity === 'valid';

  window.history.replaceState(null, document.title, window.location.pathname);

  if (button && target && valid) {
    reportDesktopHandoff(classification.handoffType, 'presented', 'valid');
    button.href = target;
    button.removeAttribute('aria-disabled');
    button.addEventListener('click', () => reportDesktopHandoff(classification.handoffType, 'manual', 'valid'));
  } else {
    reportDesktopHandoff(classification.handoffType, 'presented', 'invalid');
    button?.setAttribute('hidden', '');
    error?.removeAttribute('hidden');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') initializeDesktopHandoff();
