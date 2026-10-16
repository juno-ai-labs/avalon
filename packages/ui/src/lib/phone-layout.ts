import { useSyncExternalStore } from 'react';

/** The stylesheet's phone breakpoint: at or under it the app draws its phone layout. */
export const PHONE_LAYOUT_MAX_WIDTH = 640;

const PHONE_QUERY = `(max-width: ${PHONE_LAYOUT_MAX_WIDTH}px)`;

// jsdom implements no `matchMedia`; without it the layout is never a phone's.
function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function matches(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** Whether the window is at phone width, for what CSS alone cannot change, such as how many marks a bridge draws. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, matches, () => false);
}
