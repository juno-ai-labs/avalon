import {
  parseSidekickLinkPathTarget,
  parseSpaceLinkPathTarget,
  parseWorkstreamLinkPathTarget,
  sidekickDeepLink,
  spaceDeepLink,
  workstreamDeepLinkFromParsedTarget,
  type ParsedWorkstreamLinkTarget,
  type SidekickLinkTarget,
  type SpaceLinkTarget,
} from '@rally/contracts/workstream-links';
import { reportDesktopHandoff } from './telemetry';

export {};

/** The web app, which opens every addressed path this page serves. */
const BROWSER_APP_ORIGIN = 'https://app.rallywith.ai';

/** Which app this browser last chose for a shared link, so a web-only reader is not sent to an app they lack. */
const OPEN_IN_KEY = 'rally.sharedLinks.openIn';

/**
 * Current workspace-addressed and legacy ID-only work-stream paths are served by a
 * rewrite in `public/_redirects`: every id under that prefix renders this one
 * page, and the id stays in `window.location.pathname` for this script to read.
 * Nothing about the work stream is fetched or rendered here — the page hands off
 * to the desktop app or the same path on the web app, and either one applies the
 * viewer's own permissions.
 */
function initializeWorkstreamHandoff(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-rally');
  const browser = document.querySelector<HTMLAnchorElement>('#open-browser');
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
  const noun = kind.toLowerCase();
  document.title = `Open ${noun} in Rally`;
  if (kindLabel) kindLabel.textContent = kind;
  if (title) title.textContent = `Opening this ${noun} in Rally`;
  if (status) status.textContent = `This ${noun} opens with your existing Rally session and organization permissions.`;

  // An ID-only link from before workspace addressing names no Organization,
  // and the web app opens a resource only inside one.
  const webUrl = workstreamTarget?.region === null ? null : new URL(window.location.pathname, BROWSER_APP_ORIGIN).toString();
  if (browser && webUrl) {
    browser.href = webUrl;
    browser.removeAttribute('hidden');
    browser.addEventListener('click', () => {
      rememberOpenIn('browser');
      reportDesktopHandoff('workstream', 'browser', 'valid');
    });
  }

  const target = handoffAppTarget(
    handoffDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    { workstream: workstreamTarget, space: spaceTarget, sidekick: sidekickTarget },
  );
  if (!target) {
    // No Rally app can open this here, so the web app is the way in.
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    if (title) title.textContent = `Open this ${noun} in Rally`;
    if (browser && webUrl) {
      browser.className = 'handoff-open';
      browser.textContent = 'Open in browser';
      if (status) status.textContent = `This ${noun} opens in your browser with your Rally account.`;
    } else if (status) {
      status.textContent = `This ${noun} opens in Rally for Mac. Ask the sender for a new link to open it in a browser.`;
    }
    return;
  }

  button.href = target.href;
  button.setAttribute('aria-disabled', 'false');
  if (target.app === 'ios') {
    button.textContent = 'Open in Rally';
    help?.setAttribute('hidden', '');
  }

  let attempted = false;
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    reportDesktopHandoff('workstream', 'automatic', 'valid');
    window.location.assign(target.href);
  };

  button.addEventListener('click', () => {
    attempted = true;
    rememberOpenIn('app');
    reportDesktopHandoff('workstream', 'manual', 'valid');
  });
  // The app stays the first choice, but a reader who last chose the browser
  // gets to pick again rather than a launch prompt for an app they may lack.
  if (readOpenIn() !== 'browser') window.setTimeout(openOnce, 120);
}

export type HandoffDevice = 'mac' | 'ios' | 'other';

/** Which Rally app this device can run. Windows, Linux and Android have none, only the web app. */
export function handoffDevice(userAgent: string, platform: string, maxTouchPoints: number): HandoffDevice {
  if (isIosDevice(userAgent, platform, maxTouchPoints)) return 'ios';
  return /Macintosh|Mac OS X/u.test(userAgent) ? 'mac' : 'other';
}

/**
 * The app link this page opens on `device`, or null when no app there can.
 * iOS has Channel and Breakout views but no Space or Sidekick screen, so those
 * stay on the web instead of launching the app into an unrelated conversation.
 */
export function handoffAppTarget(
  device: HandoffDevice,
  targets: { workstream: ParsedWorkstreamLinkTarget | null; space: SpaceLinkTarget | null; sidekick: SidekickLinkTarget | null },
): { app: 'mac' | 'ios'; href: string } | null {
  if (device === 'other') return null;
  if (device === 'ios') return targets.workstream ? { app: 'ios', href: legacyIosWorkstreamHandoff(targets.workstream) } : null;
  if (targets.workstream) return { app: 'mac', href: workstreamDeepLinkFromParsedTarget(targets.workstream) };
  if (targets.space) return { app: 'mac', href: spaceDeepLink(targets.space) };
  return targets.sidekick ? { app: 'mac', href: sidekickDeepLink(targets.sidekick) } : null;
}

function readOpenIn(): string | null {
  try {
    return localStorage.getItem(OPEN_IN_KEY);
  } catch {
    return null;
  }
}

function rememberOpenIn(choice: 'app' | 'browser'): void {
  try {
    localStorage.setItem(OPEN_IN_KEY, choice);
  } catch {
    // Without storage the page auto-opens the app every time, as it did before.
  }
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
