import { useEffect } from 'react';

/**
 * Bringing a window to the front is not a gesture at anything inside it.
 *
 * Command-Tab back into Rally and the renderer is handed the same events a hand
 * would produce. The element that held focus when the window went away is
 * focused again, so it sees a `focus` it never lost. The window arrives
 * underneath a cursor that never moved, so whatever is now under that cursor is
 * entered and hovered. Neither event carries a flag saying which of the two it
 * was — a restored `focus` is indistinguishable from a Tab, and an entry caused
 * by content arriving under the pointer is indistinguishable from a pointer
 * arriving over content.
 *
 * Every surface that opens something on hover or focus therefore opens it on
 * every app switch. The sidebar shows the symptom most clearly, because it has
 * both halves at once: the row the reader last clicked still holds focus, and
 * the row under the resting cursor is freshly hovered, so switching back raises
 * two preview cards over the screen the person switched back to read.
 *
 * This module is the distinction those surfaces are missing, kept in one place
 * because they all need the same answer to the same question: *has the person
 * touched this window since it was last brought to the front?* A surface that
 * asks before opening transient UI stops opening it for the window manager, and
 * keeps opening it for everyone else.
 *
 * What counts as touching it is deliberately narrow, because the whole value of
 * the answer is that an app switch cannot produce one:
 *
 * - **A key going down.** Not a key coming up: the Command of a Command-Tab is
 *   released after the window is in front, and on a platform that delivers that
 *   `keyup` it is part of the switch rather than a keystroke aimed at Rally.
 * - **A pointer going down.** A click is unambiguous whatever preceded it.
 * - **A pointer that has moved.** Movement is compared against where the cursor
 *   was rather than assumed from the arrival of an event, because the events an
 *   activation produces are exactly the ones that describe a cursor sitting
 *   still. The first pointer event after a switch is what tells the page where
 *   the cursor already is — the window arriving underneath it is an entry into
 *   whatever it landed over, before any movement — and a later one at the same
 *   coordinates is the same stationary cursor being described again. One at
 *   different coordinates is a hand.
 *
 * Nothing here is timed. A grace period would need a number nobody here can
 * derive, and would answer "recently" when the question is "at all".
 *
 * The tracking is installed rather than implicit, and until it is, the answer is
 * yes — the behaviour every one of these surfaces had before this module
 * existed. `App` installs it for whichever window it is rendering, so a surface
 * asking inside the app gets the real answer and a surface rendered in a test
 * without it is not quietly muted.
 */

/**
 * How many mounted trackers want the listeners. React Strict Mode mounts, tears
 * down and remounts an effect, and a second window is a second React root in
 * its own renderer process rather than a second count here — but a count is
 * what keeps either from removing the listeners the other is using.
 */
let trackers = 0;

/** Set while this window has been activated and nobody has touched it since. */
let awaitingInput = false;

/**
 * Where the cursor turned out to be when the window came forward, learned from
 * the first pointer event after the activation rather than remembered from
 * before it: the cursor is free to move over other applications while Rally is
 * in the background, and the page is told none of it.
 */
let activationPointerPosition: { clientX: number; clientY: number } | null = null;

function windowActivationChanged(): void {
  awaitingInput = true;
  activationPointerPosition = null;
}

function observePointerPosition(event: PointerEvent): void {
  if (!awaitingInput) return;
  if (activationPointerPosition === null) {
    activationPointerPosition = { clientX: event.clientX, clientY: event.clientY };
    return;
  }
  if (
    event.clientX === activationPointerPosition.clientX
    && event.clientY === activationPointerPosition.clientY
  ) return;
  awaitingInput = false;
}

function observeDeliberateInput(): void {
  awaitingInput = false;
}

/**
 * Starts answering {@link hasUserInputSinceWindowActivation} for this window,
 * and returns the teardown.
 *
 * The listeners capture, so the answer is already up to date by the time the
 * event reaches the surface that asks about it — a `keydown` that moves focus
 * has to count as input before the `focus` it causes is judged.
 */
export function installWindowActivationTracking(): () => void {
  trackers += 1;
  if (trackers === 1) {
    // Bubble phase, so this hears the window's own activation and not the
    // `focus` of every element inside it: element focus does not bubble, but it
    // does pass window on the way down.
    window.addEventListener('focus', windowActivationChanged);
    window.addEventListener('blur', windowActivationChanged);
    // `pointerover` alongside the moves because the activation's own pointer
    // event is usually an entry rather than a move — the cursor did not go to
    // the content, the content came to it — and hearing that first is what lets
    // a single real movement afterwards count as one.
    window.addEventListener('pointerover', observePointerPosition, true);
    window.addEventListener('pointermove', observePointerPosition, true);
    window.addEventListener('pointerdown', observeDeliberateInput, true);
    window.addEventListener('keydown', observeDeliberateInput, true);
  }
  return () => {
    trackers -= 1;
    if (trackers > 0) return;
    window.removeEventListener('focus', windowActivationChanged);
    window.removeEventListener('blur', windowActivationChanged);
    window.removeEventListener('pointerover', observePointerPosition, true);
    window.removeEventListener('pointermove', observePointerPosition, true);
    window.removeEventListener('pointerdown', observeDeliberateInput, true);
    window.removeEventListener('keydown', observeDeliberateInput, true);
    // Back to the permissive answer, which is what an uninstalled tracker owes
    // a surface that asks anyway.
    awaitingInput = false;
    activationPointerPosition = null;
  };
}

/** {@link installWindowActivationTracking} for the window's React root. */
export function useWindowActivationTracking(): void {
  useEffect(() => installWindowActivationTracking(), []);
}

/**
 * Whether the pointer or the keyboard has been used since this window was last
 * brought to the front.
 *
 * Ask this before opening anything transient from a hover or a focus. Do not ask
 * it before closing one, or before work the person cannot see: a surface that
 * declines to *close* on an activation leaves a card up over the screen they
 * came back to, which is the same complaint from the other side.
 */
export function hasUserInputSinceWindowActivation(): boolean {
  return !awaitingInput;
}

/**
 * Runs `onDeactivated` when this window goes to the back.
 *
 * The companion to the guard above, and the half that is easy to forget: a card
 * that was already open when the person switched away is still open when they
 * switch back, and is indistinguishable — to them — from one the app switch
 * raised. Transient UI that opens on hover or focus should take itself down
 * here rather than wait for a pointer that has left the window.
 *
 * `onDeactivated` is a dependency, so pass one that is stable across renders.
 */
export function useWindowDeactivated(onDeactivated: () => void): void {
  useEffect(() => {
    window.addEventListener('blur', onDeactivated);
    return () => window.removeEventListener('blur', onDeactivated);
  }, [onDeactivated]);
}
