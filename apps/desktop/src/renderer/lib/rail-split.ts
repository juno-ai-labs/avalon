import { useSyncExternalStore } from 'react';

import { SIDEBAR_CONTENT_MIN_WIDTH, savedRailWidth, useUiStore } from './ui-store';

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
 * Reopen the panel a conversation had open, on arrival or relaunch, at the
 * width last set for `scope`. A conversation whose panel was never resized
 * gets the even split a click would have given, not the 320px default.
 * Call it after claiming `scope`: claiming loads that scope's width, which
 * the split replaces.
 */
export function restoreRail(scope: string, open: () => void): void {
  const width = savedRailWidth(scope) === null ? evenSplitWidth() : null;
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
 * The main pane's width: the window less the sidebar, which gives way above
 * phone width before the pane drops under the conversation's minimum (the
 * shell's `--av-cmp-sidebar-width`).
 */
export function mainPaneWidth(windowWidth: number, sidebarWidth: number): number {
  return windowWidth - Math.min(sidebarWidth, windowWidth - SIDEBAR_CONTENT_MIN_WIDTH);
}

/**
 * Whether the main pane is too narrow for the split a panel opens at. The
 * panel opens at half the pane, so a pane under two conversation minimums
 * gives a cramped Chat beside a cramped panel. There the panel takes the
 * whole pane instead. It never floats over a dimmed conversation: closing
 * the panel is the way back.
 */
export function railFillsPane(windowWidth: number, sidebarWidth: number): boolean {
  return mainPaneWidth(windowWidth, sidebarWidth) < 2 * SIDEBAR_CONTENT_MIN_WIDTH;
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
