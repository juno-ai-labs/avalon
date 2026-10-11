import type { TelemetryBootstrapRequest, TelemetryEventProperties } from '@rally/contracts/telemetry';

/**
 * The page's half of traffic classification (docs/site-traffic-classification.md).
 * Each check is a yes/no answer about this page load; nothing it reads is kept
 * or sent beyond the answer.
 */

type StartSignal = NonNullable<TelemetryBootstrapRequest['pageSignals']>[number];
type LeaveSignal = NonNullable<TelemetryEventProperties<'site_page_left'>['pageSignals']>[number];

const IOS_UA = /\b(?:iPhone|iPad|iPod)\b/u;

/** True when this script runs on V8, whose stack frames read "    at …". WebKit and Gecko write "fn@url". */
function runsOnV8(): boolean {
  return /\n\s+at /u.test(new Error('engine').stack ?? '');
}

/** The checks that can answer before telemetry starts. */
export function pageStartSignals(): StartSignal[] {
  const signals: StartSignal[] = [];
  try {
    if (navigator.webdriver === true) signals.push('webdriver');
    if ('__playwright__binding__' in window || '__pwInitScripts' in window) signals.push('automation_globals');
    // Every iOS browser, Chrome and X's in-app view included, runs WebKit.
    // An iOS user agent on Chromium's engine is a desktop browser in disguise.
    if (IOS_UA.test(navigator.userAgent) && ('userAgentData' in navigator || runsOnV8())) signals.push('engine_mismatch');
  } catch {
    // A check that cannot run reports nothing.
  }
  return signals;
}

/** The page's IANA time zone, for the API to compare with its address's. */
export function pageTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u.test(zone) && zone.length <= 64 ? zone : undefined;
  } catch {
    return undefined;
  }
}

// Starting points the team owns: the vertical travel that makes a touch a
// swipe, the screen margin where back and forward gestures start, and how
// long a swipe's scroll may take to begin.
const SWIPE_MIN_PX = 30;
const SWIPE_EDGE_PX = 24;
const SWIPE_SETTLE_MS = 500;

const INPUT_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'keydown', 'wheel'] as const;
const CONTROLS = 'a[href],button,summary,input,select,textarea,label,[role="button"]';

/**
 * Watches this page's input until it is left, and returns what it saw.
 *
 * - `human_input`: a trusted input that did something — the page scrolled
 *   after it, or it activated a link or control. Trusted alone is not enough:
 *   a script can scroll the page itself.
 * - `untrusted_input`: an input event the page's own script made.
 * - `swipe_no_scroll`: a vertical swipe on a page that could move in that
 *   direction, and nothing scrolled.
 * - `never_visible`: the page was never shown.
 */
export function watchPageInput(): () => LeaveSignal[] {
  const seen = new Set<LeaveSignal>();
  let trustedInput = false;
  let lastScrollAt = 0;
  let wasVisible = document.visibilityState === 'visible';
  let swipe: { x: number; y: number; top: number; at: number } | null = null;
  const options = { capture: true, passive: true } as const;
  const scroller = (): Element => document.scrollingElement ?? document.documentElement;

  const onInput = (event: Event): void => {
    if (!event.isTrusted) seen.add('untrusted_input');
    else if (document.visibilityState === 'visible') trustedInput = true;
  };
  for (const type of INPUT_EVENTS) document.addEventListener(type, onInput, options);

  document.addEventListener('scroll', () => {
    lastScrollAt = performance.now();
    if (trustedInput) seen.add('human_input');
  }, options);

  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest(CONTROLS)) seen.add('human_input');
  }, options);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wasVisible = true;
  });

  document.addEventListener('touchstart', (event) => {
    // A script can fire a bare `Event` named touchstart, with no touch list.
    const touch = event.touches?.length === 1 ? event.touches[0] : undefined;
    swipe = touch ? { x: touch.clientX, y: touch.clientY, top: scroller().scrollTop, at: performance.now() } : null;
  }, options);

  document.addEventListener('touchend', (event) => {
    const start = swipe;
    swipe = null;
    const touch = event.changedTouches?.[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) < 2 * Math.abs(dx)) return;
    if (start.x < SWIPE_EDGE_PX || start.x > window.innerWidth - SWIPE_EDGE_PX) return;
    const page = scroller();
    const maxTop = page.scrollHeight - page.clientHeight;
    // A finger moving up scrolls the page down, which needs room below; down needs room above.
    if (maxTop < 1 || (dy < 0 ? start.top >= maxTop : start.top <= 0)) return;
    window.setTimeout(() => {
      if (lastScrollAt < start.at && scroller().scrollTop === start.top) seen.add('swipe_no_scroll');
    }, SWIPE_SETTLE_MS);
  }, options);

  return () => {
    if (!wasVisible) seen.add('never_visible');
    return [...seen].sort();
  };
}
