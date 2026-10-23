import { useEffect, useState } from 'react';
import { KONAMI_CODE, useKeySequence } from '../../lib/easter-eggs';

/**
 * Up Up Down Down Left Right Left Right B A, typed anywhere outside a text
 * field: a wash of the accent colour, Contra's thirty lives, and every avatar
 * on screen (people, Rally and Sidekicks) runs a small lap. It clears itself when its animation ends, and typing
 * the code again replays it.
 */
export function KonamiEgg(): React.JSX.Element | null {
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
    return () => { delete root.dataset.konami; };
  }, [play]);
  if (play === 0) return null;
  return (
    <div aria-hidden="true" className="konami-egg" key={play} onAnimationEnd={(event) => {
      if (event.target === event.currentTarget) setPlay(0);
    }}>
      <span>+30 lives</span>
    </div>
  );
}
