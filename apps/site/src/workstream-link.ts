import {
  parseSidekickLinkPathTarget,
  parseSpaceLinkPathTarget,
  parseWorkstreamLinkPathTarget,
  sidekickDeepLink,
  spaceDeepLink,
  workstreamDeepLinkFromParsedTarget,
  type ParsedWorkstreamLinkTarget,
} from '@rally/contracts/workstream-links';
import { reportDesktopHandoff } from './telemetry';

export {};

/**
 * Current workspace-addressed and legacy ID-only work-stream paths are served by a
 * rewrite in `public/_redirects`: every id under that prefix renders this one
 * page, and the id stays in `window.location.pathname` for this script to read.
 * Nothing about the work stream is fetched or rendered here — the page only
 * hands off to the desktop app, which applies the viewer's own permissions.
 */
function initializeWorkstreamHandoff(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-rally');
  const title = document.querySelector<HTMLElement>('#workstream-title');
  const status = document.querySelector<HTMLElement>('#workstream-status');
  const kindLabel = document.querySelector<HTMLElement>('#resource-kind');
  const help = document.querySelector<HTMLElement>('#workstream-help');
  const error = document.querySelector<HTMLElement>('#workstream-error');
  if (!button) return;

  const workstreamTarget = parseWorkstreamLinkPathTarget(window.location.pathname);
  const spaceTarget = parseSpaceLinkPathTarget(window.location.pathname);
  const sidekickTarget = parseSidekickLinkPathTarget(window.location.pathname);
  if (!workstreamTarget && !spaceTarget && !sidekickTarget) {
    reportDesktopHandoff('workstream', 'presented', 'invalid');
    kindLabel?.setAttribute('hidden', '');
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    error?.removeAttribute('hidden');
    if (title) title.textContent = 'This link did not lead to a Rally resource';
    if (status) status.textContent = 'Ask the sender for the link again.';
    return;
  }

  reportDesktopHandoff('workstream', 'presented', 'valid');

  const kind = spaceTarget ? 'Space' : sidekickTarget ? 'Sidekick' : workstreamTarget?.substreamId ? 'Breakout' : 'Channel';
  document.title = `Open ${kind.toLowerCase()} in Rally`;
  if (kindLabel) kindLabel.textContent = kind;
  if (title) title.textContent = `Opening this ${kind.toLowerCase()} in Rally`;
  if (status) status.textContent = `This ${kind.toLowerCase()} opens with your existing Rally session and organization permissions.`;

  // iOS has Channel and Breakout views but no Space or Sidekick screen. Leave
  // those URLs on the web instead of launching the app into an unrelated
  // conversation.
  if ((spaceTarget || sidekickTarget) && isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) {
    document.title = `Open this ${kind} on desktop`;
    if (title) title.textContent = `Open this ${kind} on desktop`;
    if (status) status.textContent = spaceTarget ? 'Space dashboards are available in Rally for Mac.' : 'Sidekicks are available in Rally for Mac.';
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    return;
  }

  const target = workstreamTarget
    ? isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
      ? legacyIosWorkstreamHandoff(workstreamTarget)
      : workstreamDeepLinkFromParsedTarget(workstreamTarget)
    : spaceTarget ? spaceDeepLink(spaceTarget) : sidekickDeepLink(sidekickTarget!);
  button.href = target;
  button.setAttribute('aria-disabled', 'false');

  let attempted = false;
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    reportDesktopHandoff('workstream', 'automatic', 'valid');
    window.location.assign(target);
  };

  button.addEventListener('click', () => {
    attempted = true;
    reportDesktopHandoff('workstream', 'manual', 'valid');
  });
  window.setTimeout(openOnce, 120);
}

export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/** Old iPhone builds understand this addressed path, but not Base58 /s/ /c/ /b/. */
export function legacyIosWorkstreamHandoff(target: ParsedWorkstreamLinkTarget): string {
  if (!target.region || !target.workspaceId) return workstreamDeepLinkFromParsedTarget(target);
  return `rallywithai://handoff/workspaces/${target.region}/${target.workspaceId}/workstreams/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ''}`;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initializeWorkstreamHandoff();
}
