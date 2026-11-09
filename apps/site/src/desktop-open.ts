import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
import { parseWorkspaceAddressedDeepLink } from '@rally/contracts/workspace-target';
import { reportDesktopHandoff } from './telemetry';

type DesktopHandoffType = Parameters<typeof reportDesktopHandoff>[0];

export function classifyDesktopHandoffTarget(value: string | null): {
  handoffType: DesktopHandoffType;
  validity: 'valid' | 'invalid';
} {
  if (!value) return { handoffType: 'unknown', validity: 'invalid' };
  try {
    const url = new URL(value);
    const destination = parseWorkspaceAddressedDeepLink(url)?.destination ?? url;
    const intent = parseDesktopDeepLinkIntent(value);
    const handoffType: DesktopHandoffType = destination.hostname === 'canvases'
      ? 'canvas'
      : destination.hostname === 'sidekicks'
        ? 'sidekick'
      : destination.hostname === 'settings'
        ? 'settings'
        : destination.hostname === 'automations' ? 'automation'
        : destination.hostname === 'activity' ? 'activity' : 'unknown';
    return { handoffType, validity: intent && handoffType !== 'unknown' ? 'valid' : 'invalid' };
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
