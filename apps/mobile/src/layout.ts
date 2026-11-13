// 8pt top gap + 44pt control + 12pt breathing room, inside the safe area.
export const FLOATING_HEADER_INSET = 64;

// Regular-width navigation starts at 600pt, including Duo's portrait inner
// window. Window geometry, not
// device identity or hinge angle, also handles tablets and split-screen apps.
export const EXPANDED_LAYOUT_WIDTH = 600;

/** Presentation only: artifact documents receive no native bridge or capability. */
export function artifactInsetScript(top: number): string {
  return `(() => {
    const body = document.body;
    if (!body) return;
    if (!body.hasAttribute('data-rally-mobile-inset')) body.setAttribute('data-rally-mobile-inset', String(parseFloat(getComputedStyle(body).paddingTop) || 0));
    const padding = Number(body.getAttribute('data-rally-mobile-inset'));
    body.style.paddingTop = (padding + ${JSON.stringify(top)}) + 'px';
    document.documentElement.style.setProperty('--rally-overlay-top', ${JSON.stringify(`${top}px`)});
  })(); true;`;
}
