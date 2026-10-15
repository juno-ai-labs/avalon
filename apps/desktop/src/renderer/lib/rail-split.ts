import { useUiStore } from './ui-store';

/**
 * Size the right panel to an even split with the conversation, for an
 * attachment or artifact about to open in it.
 *
 * Opening a panel widens the window by the panel's width where the screen has
 * room (`conversation-details-geometry.ts`), and leaves the conversation as it
 * was. So the even split is the conversation's present width, capped at half
 * of what the screen allows; a maximized window, which does not grow, splits
 * in half. Measured before the panel is on screen, from the main pane's left
 * edge, because the pane's own box changes once a panel is open.
 */
export function sizeRailToEvenSplit(): void {
  const pane = document.querySelector('.main-pane');
  if (!pane) return;
  const left = pane.getBoundingClientRect().left;
  const conversation = window.innerWidth - left;
  const screenRoom = Math.max(window.screen.availWidth, window.innerWidth) - left;
  useUiStore.getState().setRailWidth(Math.round(Math.min(conversation, screenRoom / 2)));
}
