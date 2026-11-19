/**
 * /for/legal/'s one motion of its own: the turn passing. The story player
 * slides a keyed marker from the lane it left to the lane it reached; here
 * that crossing is slowed and evened out, so it reads as a deliberate, level
 * move rather than a snap. The player still keeps time (docs/site-audience-pages.md).
 */
const CROSSING: OptionalEffectTiming = { duration: 1000, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' };

document.addEventListener('story:step', (event) => {
  if (!(event.target instanceof HTMLElement)) return;
  for (const marker of event.target.querySelectorAll<HTMLElement>('.lg-marker.is-moved')) {
    for (const animation of marker.getAnimations()) {
      // The player's move is a script animation; the stylesheet's own are left alone.
      if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) animation.effect?.updateTiming(CROSSING);
    }
  }
});
