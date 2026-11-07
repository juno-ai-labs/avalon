import { isRetiredLinkPath, linkDeepLink, parseLinkPathTarget, type LinkTarget } from '@rally/contracts/links';
import { apiBaseUrl, reportDesktopHandoff, storageRead, storageWrite } from './telemetry';

export {};

/** The web app, which opens every addressed path this page serves; the local one when this page is served locally. */
function browserAppOrigin(): string {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8794'
    : 'https://app.rallywith.ai';
}

/** Which app this browser last chose for a shared link, so a web-only reader is not sent to an app they lack. */
const OPEN_IN_KEY = 'rally.sharedLinks.openIn';

/** What this page does for a path: open a Canvas or Sidekick, say the thing is gone, or say the link is broken. */
export type HandoffPlan =
  | { kind: 'open'; target: LinkTarget }
  | { kind: 'gone' }
  | { kind: 'invalid' };

export function handoffPlan(pathname: string): HandoffPlan {
  const target = parseLinkPathTarget(pathname);
  if (target) return { kind: 'open', target };
  return isRetiredLinkPath(pathname) ? { kind: 'gone' } : { kind: 'invalid' };
}

/**
 * Every `/app/` path is served this one page by a rewrite in
 * `public/_redirects`, and the path stays in `window.location.pathname` for
 * this script to read. Nothing about the Canvas or Sidekick is fetched beyond
 * its name: the page hands off to the desktop app or the same path on the web
 * app, and either one applies the viewer's own permissions. See
 * `docs/links.md#the-handoff-page`.
 */
function initializeLinkHandoff(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-rally');
  const browser = document.querySelector<HTMLAnchorElement>('#open-browser');
  const title = document.querySelector<HTMLElement>('#link-title');
  const help = document.querySelector<HTMLElement>('#link-help');
  const gone = document.querySelector<HTMLElement>('#link-gone');
  const error = document.querySelector<HTMLElement>('#link-error');
  if (!button) return;

  const plan = handoffPlan(window.location.pathname);
  if (plan.kind !== 'open') {
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    if (plan.kind === 'gone') {
      // A Space, Channel, Breakout or Thread link: what it named was deleted
      // with them. Saying so is the answer; there is nothing to open.
      reportDesktopHandoff('workstream', 'presented', 'invalid');
      if (title) title.textContent = 'This link is to something that no longer exists';
      gone?.removeAttribute('hidden');
      if (browser) {
        browser.href = new URL('/', browserAppOrigin()).toString();
        browser.textContent = 'Go to Rally';
        browser.removeAttribute('hidden');
      }
    } else {
      reportDesktopHandoff('unknown', 'presented', 'invalid');
      error?.removeAttribute('hidden');
      if (title) title.textContent = 'This link did not lead to a Rally resource';
    }
    return;
  }

  const kind = plan.target.kind;
  reportDesktopHandoff(kind, 'presented', 'valid');
  if (title) void showResourceName(title);
  // Choosing the browser also cancels the app launch still pending on this page.
  let attempted = false;
  const webUrl = new URL(window.location.pathname, browserAppOrigin()).toString();
  if (browser) {
    browser.href = webUrl;
    browser.removeAttribute('hidden');
    browser.addEventListener('click', () => {
      attempted = true;
      rememberOpenIn('browser');
      reportDesktopHandoff(kind, 'browser', 'valid');
    });
  }

  const href = handoffAppLink(handoffDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints), plan.target);
  if (!href) {
    // No Rally app runs here, so the web app is the way in.
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    if (browser) {
      browser.className = 'handoff-open';
      browser.textContent = 'Open in browser';
    }
    return;
  }

  button.href = href;
  button.setAttribute('aria-disabled', 'false');
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    reportDesktopHandoff(kind, 'automatic', 'valid');
    window.location.assign(href);
  };
  button.addEventListener('click', () => {
    attempted = true;
    rememberOpenIn('app');
    reportDesktopHandoff(kind, 'manual', 'valid');
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

export type HandoffDevice = 'mac' | 'other';

/**
 * Whether this device runs the Mac app. Everything else has only the web app,
 * an iPad included: its Safari reports a Mac user agent, and only its touch
 * points tell it apart.
 */
export function handoffDevice(userAgent: string, platform: string, maxTouchPoints: number): HandoffDevice {
  if (/iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'other';
  return /Macintosh|Mac OS X/u.test(userAgent) ? 'mac' : 'other';
}

/** The desktop deep link this page opens on `device`, or null where no Rally app runs. */
export function handoffAppLink(device: HandoffDevice, target: LinkTarget): string | null {
  return device === 'mac' ? linkDeepLink(target) : null;
}

/** Without storage the page auto-opens the app every time, as it did before. */
function readOpenIn(): string | null {
  return storageRead(localStorage, OPEN_IN_KEY);
}

function rememberOpenIn(choice: 'app' | 'browser'): void {
  storageWrite(localStorage, OPEN_IN_KEY, choice);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initializeLinkHandoff();
}
