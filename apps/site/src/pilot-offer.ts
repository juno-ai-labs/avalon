/**
 * The pilot offer card on the landing page. It slides in once the visitor has
 * been on the page for a few seconds, and stays away in this browser after
 * they close it or follow its sign-up link.
 *
 * Each visitor gets their own deadline, six days after the day they first saw
 * the page, and keeps it on every later visit; the card stops showing once it
 * passes. The deadline is real: whoever signs up by it gets the offer.
 */
const DISMISSED_KEY = 'rally.site.pilot-offer-dismissed.v1';
// How long the visitor reads the page before the offer appears.
const SHOW_AFTER_MS = 2_000;
const FIRST_SEEN_KEY = 'rally.site.pilot-offer-first-seen.v1';
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

/** When this browser first saw the offer, recorded now if it never has. */
function firstSeen(): Date {
  const now = new Date();
  try {
    const stored = Number(localStorage.getItem(FIRST_SEEN_KEY));
    if (Number.isFinite(stored) && stored > 0 && stored <= now.getTime()) return new Date(stored);
    localStorage.setItem(FIRST_SEEN_KEY, String(now.getTime()));
  } catch {
    // Without storage every visit is a first visit.
  }
  return now;
}

/** The last day of the offer, in the visitor's time zone. */
function lastDay(seen: Date): Date {
  return new Date(seen.getFullYear(), seen.getMonth(), seen.getDate() + OFFER_DAYS);
}

function initialize(offer: HTMLElement, last: Date): void {
  const deadline = offer.querySelector<HTMLTimeElement>('.pilot-offer-deadline');
  if (deadline) {
    deadline.dateTime = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    deadline.textContent = last.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  const close = (): void => {
    rememberDismissed();
    document.removeEventListener('keydown', onKey);
    // The exit animation ends in `hidden`; with reduced motion there is none to wait for.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      offer.hidden = true;
      return;
    }
    offer.classList.add('is-closing');
    offer.addEventListener('animationend', () => { offer.hidden = true; }, { once: true });
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  offer.querySelector('.pilot-offer-close')?.addEventListener('click', close);
  // Following the link is an answer too; it opens in this tab, so only remember it.
  offer.querySelector('.pilot-offer-cta')?.addEventListener('click', rememberDismissed);
  setTimeout(() => {
    offer.hidden = false;
    document.addEventListener('keydown', onKey);
  }, SHOW_AFTER_MS);
}

const offer = document.getElementById('pilot-offer');
if (offer && !dismissed()) {
  const last = lastDay(firstSeen());
  // The offer runs through the whole of its last day.
  const ended = Date.now() >= new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  if (!ended) initialize(offer, last);
}

// A module, so the test can load it fresh for each visit.
export {};
