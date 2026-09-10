import { useEffect } from 'react';

import type { PersonalPresentation } from '@rally/contracts';

import { personalColor } from '../components/personal-avatar';

/**
 * The signed-in person's accent, published once for the whole renderer.
 *
 * A person picks one colour in onboarding, and the product already paints their
 * own turns in it. Anything else that should read as *theirs* — a citation
 * marker, a selection, a marker in a list — needs the same colour without
 * knowing who is signed in, which is why this is a custom property on `<html>`
 * rather than a value threaded through props: a rule anywhere in the tree spends
 * `var(--personal-accent)` and gets it, and there is exactly one writer.
 *
 * It is written to the document element and not to the shell's own div so that
 * a portalled surface — the search dialog, a lightbox, a tooltip, all of which
 * Radix mounts on `<body>` — resolves it too. `app.css` declares the brand as
 * its default on `:root`, so a surface rendered before anybody has signed in,
 * or with no presentation stored, keeps the colour it has today; the inline
 * value written here is on the same element and wins while it is set.
 */
export const PERSONAL_ACCENT_PROPERTY = '--personal-accent';

/** Publishes `color` as the renderer's personal accent for as long as it is mounted. */
export function usePersonalAccent(color: PersonalPresentation['color'] | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (color === undefined) {
      root.style.removeProperty(PERSONAL_ACCENT_PROPERTY);
      return undefined;
    }
    root.style.setProperty(PERSONAL_ACCENT_PROPERTY, personalColor(color));
    return () => { root.style.removeProperty(PERSONAL_ACCENT_PROPERTY); };
  }, [color]);
}
