/**
 * The pilot offer card on the landing page. It slides in once the visitor has
 * been on the page for a few seconds, and stays away in this browser after
 * they close it or follow its sign-up link.
 *
 * Each visitor gets their own deadline, six days after the day they first saw
 * the card, and keeps it on every later visit; the card stops showing once it
 * passes. The deadline is real: whoever signs up by it gets the offer.
 */
const DISMISSED_KEY = 'rally.site.pilot-offer-dismissed.v1';
// How long the visitor reads the page before the offer appears.
const SHOW_AFTER_MS = 2_000;
const FIRST_SEEN_KEY = 'rally.site.pilot-offer-first-seen.v1';
const FIRST_SEEN_PARAM = 'pilotOfferFirstSeen';
// How many days after their first visit a visitor has to take the offer.
const OFFER_DAYS = 6;

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Without storage the offer simply returns on the next visit.
  }
}

/** A local calendar date as `YYYY-MM-DD`. */
function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The day this browser first saw the offer, or null if it never has. Kept as
 * the calendar date the visitor saw rather than an instant, so a later visit
 * from another time zone still shows the same deadline.
 */
function storedFirstSeen(): string | null {
  try {
    const stored = localStorage.getItem(FIRST_SEEN_KEY);
    return stored && /^\d{4}-\d{2}-\d{2}$/u.test(stored) && stored <= isoDate(new Date()) ? stored : null;
  } catch {
    return null;
  }
}

function rememberFirstSeen(day: string): void {
  try {
    localStorage.setItem(FIRST_SEEN_KEY, day);
  } catch {
    // Without storage every visit is a first visit.
  }
}

/** The last day of the offer that began on `firstSeen`, at local midnight. */
function lastDay(firstSeen: string): Date {
  const [year, month, day] = firstSeen.split('-').map(Number);
  return new Date(year!, month! - 1, day! + OFFER_DAYS);
}

/** Whether the whole of the offer's last day has passed. */
function ended(firstSeen: string): boolean {
  const last = lastDay(firstSeen);
  return Date.now() >= new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
}

/** Fills in the deadline and the sign-up link for an offer first seen on `firstSeen`. */
function present(offer: HTMLElement, firstSeen: string): void {
  const last = lastDay(firstSeen);
  const deadline = offer.querySelector<HTMLTimeElement>('.pilot-offer-deadline');
  if (deadline) {
    deadline.dateTime = isoDate(last);
    deadline.textContent = last.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  // The sign-up link carries the visitor's first-visit date, so the web app can
  // tell which deadline they were shown.
  const cta = offer.querySelector<HTMLAnchorElement>('.pilot-offer-cta');
  if (cta) {
    const destination = new URL(cta.href);
    destination.searchParams.set(FIRST_SEEN_PARAM, firstSeen);
    cta.href = destination.href;
  }
}

function initialize(offer: HTMLElement, firstSeen: string | null): void {
  const cta = offer.querySelector<HTMLAnchorElement>('.pilot-offer-cta');
  const close = (): void => {
    rememberDismissed();
    document.removeEventListener('keydown', onKey);
    // The exit animation ends in `hidden`; with reduced motion there is none to wait for.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      offer.hidden = true;
      return;
    }
    offer.classList.add('is-closing');
    // The text inside has entry animations of its own whose end events bubble
    // here; only the card's own exit may hide it.
    const hide = (event: AnimationEvent): void => {
      if (event.target !== offer) return;
      offer.hidden = true;
      offer.removeEventListener('animationend', hide);
    };
    offer.addEventListener('animationend', hide);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  offer.querySelector('.pilot-offer-close')?.addEventListener('click', close);
  // Following the link is an answer too; it opens in this tab, so only remember it.
  cta?.addEventListener('click', rememberDismissed);
  // A middle-click opens the link without firing `click`.
  cta?.addEventListener('auxclick', (event) => {
    if (event.button === 1) rememberDismissed();
  });
  setTimeout(() => {
    // The deadline starts when the visitor first sees the card, not when the
    // page loads, so leaving before it appears costs them nothing.
    const day = firstSeen ?? isoDate(new Date());
    if (!firstSeen) rememberFirstSeen(day);
    present(offer, day);
    offer.hidden = false;
    document.addEventListener('keydown', onKey);
  }, SHOW_AFTER_MS);
}

const offer = document.getElementById('pilot-offer');
if (offer && !dismissed()) {
  const firstSeen = storedFirstSeen();
  if (!firstSeen || !ended(firstSeen)) initialize(offer, firstSeen);
}

// A module, so the test can load it fresh for each visit.
export {};
