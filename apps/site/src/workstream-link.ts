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
import { apiBaseUrl, reportDesktopHandoff } from './telemetry';

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
  const help = document.querySelector<HTMLElement>('#workstream-help');
  const error = document.querySelector<HTMLElement>('#workstream-error');
  if (!button) return;

  const workstreamTarget = parseWorkstreamLinkPathTarget(window.location.pathname);
  const spaceTarget = parseSpaceLinkPathTarget(window.location.pathname);
  const sidekickTarget = parseSidekickLinkPathTarget(window.location.pathname);
  if (!workstreamTarget && !spaceTarget && !sidekickTarget) {
    reportDesktopHandoff('workstream', 'presented', 'invalid');
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    error?.removeAttribute('hidden');
    if (title) title.textContent = 'This link did not lead to a Rally resource';
    return;
  }

  reportDesktopHandoff('workstream', 'presented', 'valid');

  // An ID-only link from before workspace addressing names no Organization,
  // so there is no name to look up and no web app to open it in.
  const addressed = workstreamTarget?.region !== null;
  if (addressed && title) void showResourceName(title);
  const webUrl = addressed ? new URL(window.location.pathname, BROWSER_APP_ORIGIN).toString() : null;
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
    if (browser && webUrl) {
      help?.setAttribute('hidden', '');
      browser.className = 'handoff-open';
      browser.textContent = 'Open in browser';
    } else if (help) {
      help.textContent = 'This link opens only in Rally for Mac. Ask the sender for a new link to open it in a browser.';
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

/** Past this many characters a name is cut, so a long one cannot push the buttons off the page. */
const HEADING_NAME_LIMIT = 40;

/** The heading for a resource called `name`, cut at {@link HEADING_NAME_LIMIT} characters. */
export function handoffHeading(name: string): string {
  const characters = Array.from(name.trim());
  const shown = characters.length > HEADING_NAME_LIMIT
    ? `${characters.slice(0, HEADING_NAME_LIMIT).join('').trimEnd()}…`
    : characters.join('');
  return `Opening “${shown}” in Rally`;
}

/**
 * Put the linked resource's name in the heading. Holding the link is what
 * lets anyone see its name, so the lookup needs no sign-in. A miss leaves the
 * generic heading: the buttons work the same without it.
 */
async function showResourceName(heading: HTMLElement): Promise<void> {
  try {
    const response = await fetch(`${apiBaseUrl()}/links/title?${new URLSearchParams({ path: window.location.pathname })}`, { cache: 'no-store' });
    if (!response.ok) return;
    const body: unknown = await response.json();
    const name = typeof body === 'object' && body !== null && 'title' in body ? body.title : null;
    if (typeof name !== 'string' || !name.trim()) return;
    heading.textContent = handoffHeading(name);
    document.title = heading.textContent;
  } catch {
    // Offline or the API is down: the generic heading stands.
  }
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
