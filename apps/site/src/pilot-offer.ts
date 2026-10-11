/**
 * The pilot offer card on the landing page. It slides in once the visitor has
 * been on the page for a few seconds, and stays away in this browser after
 * they close it or follow its sign-up link. It stops showing once the offer
 * ends.
 */
const DISMISSED_KEY = 'rally.site.pilot-offer-dismissed.v1';
// How long the visitor reads the page before the offer appears.
const SHOW_AFTER_MS = 2_000;
// The offer runs through October 16, in the visitor's own time zone.
const OFFER_ENDS = new Date(2026, 9, 17);

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

function initialize(offer: HTMLElement): void {
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
if (offer && Date.now() < OFFER_ENDS.getTime() && !dismissed()) initialize(offer);
