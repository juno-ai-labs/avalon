import { useUiStore } from './ui-store';

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
 * over its Channel's panel inherits.
 */
function evenSplitWidth(): number | null {
  const pane = document.querySelector<HTMLElement>('.main-pane');
  if (!pane) return null;
  return Math.round((window.innerWidth - pane.getBoundingClientRect().left) / 2);
}
