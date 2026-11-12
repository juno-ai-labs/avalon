/**
 * The pilot offer card on the landing page. It slides in once the visitor has
 * been on the page for a few seconds, and stays away in this browser after
 * they close it or follow its sign-up link.
 *
 * Eligibility is Organization-wide: billing automatically applies the pilot to
 * the first paid subscription while the campaign is enabled. Browser storage
 * controls dismissal only; it never decides financial eligibility.
 */
const DISMISSED_KEY = 'rally.site.pilot-offer-dismissed.v1';
// How long the visitor reads the page before the offer appears.
const SHOW_AFTER_MS = 2_000;
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
    // The text inside and the card's top rule have entry animations of their
    // own whose end events also reach the card; only its exit may hide it.
    const hide = (event: AnimationEvent): void => {
      if (event.animationName !== 'pilot-offer-out') return;
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
    offer.hidden = false;
    document.addEventListener('keydown', onKey);
  }, SHOW_AFTER_MS);
}

const offer = document.getElementById('pilot-offer');
if (offer && !dismissed()) initialize(offer);

// A module, so the test can load it fresh for each visit.
export {};
