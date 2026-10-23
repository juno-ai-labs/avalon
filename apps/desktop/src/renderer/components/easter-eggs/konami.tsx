import { useState } from 'react';
import { KONAMI_CODE, useKeySequence } from '../../lib/easter-eggs';

/**
 * Up Up Down Down Left Right Left Right B A, typed anywhere outside a text
 * field: a wash of the accent colour and Contra's thirty lives. It clears
 * itself when its animation ends, and typing the code again replays it.
 */
export function KonamiEgg(): React.JSX.Element | null {
  const [play, setPlay] = useState(0);
  useKeySequence(KONAMI_CODE, () => setPlay((count) => count + 1));
  if (play === 0) return null;
  return (
    <div aria-hidden="true" className="konami-egg" key={play} onAnimationEnd={(event) => {
      if (event.target === event.currentTarget) setPlay(0);
    }}>
      <span>+30 lives</span>
    </div>
  );
}
