import { desktopServicesAvailable } from './platform';
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
export function openRailAtEvenSplit(
  scope: string,
  open: () => void,
  windowCanGrow = desktopServicesAvailable(),
): void {
  const ui = useUiStore.getState();
  if (ui.railOpen && ui.railScope === scope) {
    open();
    return;
  }
  // Measured before opening: the panel's arrival changes the pane's box.
  const width = evenSplitWidth(windowCanGrow);
  open();
  if (width !== null) useUiStore.getState().setRailWidth(width, { remember: false });
}

/**
 * Opening a panel widens the window by the panel's width where the screen has
 * room (`conversation-details-geometry.ts`), and leaves the conversation as it
 * was. So the even split is the conversation's present width, capped at half
 * of what the screen allows; a maximized window, which does not grow, splits
 * in half, and so does a browser tab, which cannot resize its own window.
 *
 * The conversation is the main pane less the room it keeps for a panel
 * already open beside it: a Breakout taking over its Channel's panel measures
 * the conversation, not the conversation and the outgoing panel.
 */
function evenSplitWidth(windowCanGrow: boolean): number | null {
  const pane = document.querySelector<HTMLElement>('.main-pane');
  if (!pane) return null;
  const left = pane.getBoundingClientRect().left;
  const reserved = Number.parseFloat(getComputedStyle(pane).paddingRight) || 0;
  const conversation = window.innerWidth - left - reserved;
  const screenRoom = (windowCanGrow ? Math.max(window.screen.availWidth, window.innerWidth) : window.innerWidth) - left;
  return Math.round(Math.min(conversation, screenRoom / 2));
}
