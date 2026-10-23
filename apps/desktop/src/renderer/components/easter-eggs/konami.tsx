import { useEffect, useState } from 'react';
import { KONAMI_CODE, useKeySequence } from '../../lib/easter-eggs';

/**
 * Up Up Down Down Left Right Left Right B A, typed anywhere outside a text
 * field: every avatar on screen (people, Rally and Sidekicks) runs a small
 * lap. Typing the code again replays it.
 */
export function KonamiEgg(): null {
  const [play, setPlay] = useState(0);
  useKeySequence(KONAMI_CODE, () => setPlay((count) => count + 1));
  useEffect(() => {
    if (play === 0) return;
    // Avatars render all over the shell; a flag on the root lets the
    // stylesheet reach every one without each list knowing about the egg.
    const root = document.documentElement;
    delete root.dataset.konami;
    void root.offsetWidth; // Restart the lap when the code is typed again mid-run.
    root.dataset.konami = '';
    // Lower the flag once the laps finish, so an avatar that mounts later
    // does not lap on arrival. The stylesheet owns the duration.
    let cancelled = false;
    const laps = document.getAnimations?.().filter((animation) =>
      animation instanceof CSSAnimation && animation.animationName === 'avatar-lap') ?? [];
    void Promise.allSettled(laps.map((lap) => lap.finished)).then(() => {
      if (!cancelled) delete root.dataset.konami;
    });
    return () => {
      cancelled = true;
      delete root.dataset.konami;
    };
  }, [play]);
  return null;
}
