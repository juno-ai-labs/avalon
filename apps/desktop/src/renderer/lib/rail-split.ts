import { useSyncExternalStore } from 'react';

import { MIN_RAIL_WIDTH, SIDEBAR_CONTENT_MIN_WIDTH, useUiStore } from './ui-store';

/**
 * Open the right panel for `scope`, at an even split with the conversation
 * when it was not already open there.
 *
 * Switching items in a panel already open for this conversation keeps the
 * width the person may have dragged it to. Every other opening, including one
 * that takes the panel over from the conversation beside it, splits evenly.
 * The split is not saved: the width saved for the conversation stays the one
 * last dragged to, which is what a panel restored on relaunch comes back at.
 */
export function openRailAtEvenSplit(scope: string, open: () => void): void {
  const ui = useUiStore.getState();
  if (ui.railOpen && ui.railScope === scope) {
    open();
    return;
  }
  // Measured before opening: the panel's arrival changes the pane's box.
  const width = evenSplitWidth();
  open();
  if (width !== null) useUiStore.getState().setRailWidth(width, { remember: false });
}

/**
 * Opening a panel never resizes the window, so the panel and the conversation
 * share the main pane: the even split is half of it. That includes the room
 * the pane keeps for a panel already open beside it, which a Breakout taking
 * over its Channel's panel inherits. The pane's box includes that room, so this
 * reads the same with the panel open, which is how the panel edge's reset
 * returns to it.
 */
export function evenSplitWidth(): number | null {
  const pane = document.querySelector<HTMLElement>('.main-pane');
  if (!pane) return null;
  return Math.round((window.innerWidth - pane.getBoundingClientRect().left) / 2);
}

/**
 * Whether the main pane is too narrow to hold the conversation at its minimum
 * beside the narrowest panel. There the panel takes the whole pane instead of
 * squeezing the conversation to a sliver. It never floats over a dimmed
 * conversation: closing the panel is the way back.
 */
export function railFillsPane(windowWidth: number, sidebarWidth: number): boolean {
  return windowWidth - sidebarWidth < SIDEBAR_CONTENT_MIN_WIDTH + MIN_RAIL_WIDTH;
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/**
 * `railFillsPane` for this window, as the answer alone: a resize that leaves
 * it unchanged re-renders nothing, which matters to every conversation pane
 * that reads it while a window is dragged.
 */
export function useRailFillsPane(sidebarWidth: number): boolean {
  return useSyncExternalStore(subscribeResize, () => railFillsPane(window.innerWidth, sidebarWidth));
}
