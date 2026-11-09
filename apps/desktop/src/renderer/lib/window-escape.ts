import { useEffect, type RefObject } from 'react';
import { isComposingKeyEvent } from './ime';

/**
 * The Escape-closes-this-window gesture, for the secondary Rally windows that
 * opt into it.
 *
 * Opt-in is the point, and worth reading as a limit rather than a description:
 * a window answers Escape only by installing the hook below. Settings does. The meeting and deep-link-error windows deliberately do
 * not, so this module is not "what every secondary window does" — it is what a
 * window gets when it asks.
 *
 * macOS spends Escape on *cancelling* — a sheet, a popover, an operation in
 * flight — and closes an ordinary window with Command-W, so Escape here is a
 * convenience rather than the platform gesture. It is offered because every
 * other desktop application has trained people to expect it, and it is answered
 * only when nothing nearer has a claim on the keystroke:
 *
 * - An in-flight IME composition owns Escape outright: the keystroke abandons
 *   the candidate under the highlight, and a composition has no undo. Closing
 *   the window over one would destroy a sentence and the window around it.
 * - Radix renders dialogs, select menus, and popovers into portals and dismisses
 *   them on Escape itself. That keystroke belongs to the layer on top; taking
 *   the window with it would close the surface out from under a confirmation.
 * - A field that already consumed the keystroke marks it — the Settings sidebar
 *   search clears itself and calls `preventDefault()`, the composer does the
 *   same when an Escape dismisses its mention or command list. A window that
 *   closed on a prevented Escape would take the surface with the thing the
 *   person actually meant to dismiss.
 * - The focused control is checked for typing, because a `type="search"` filter
 *   answers Escape by clearing itself, and a window that vanished on the same
 *   keystroke would never let anyone see it happen.
 *
 * `unsavedTextScope` is the part each window decides for itself, because the
 * question it answers — *would closing cost the person text they cannot get
 * back?* — has a different answer per surface. Settings passes its visible pane:
 * it applies every change immediately, has no undo, and a half-written
 * invitation or API key has nowhere to come from once the window is gone. A
 * window whose one writing surface is a conversation composer would pass
 * nothing: the composer's text and attachments are cached on the device and
 * restored on the next visit (see `docs/composer-drafts.md`), so a sweep there
 * would buy almost nothing and would leave Escape permanently dead in every
 * conversation that holds a draft.
 *
 * *Almost* nothing, and the gap is worth stating rather than implying. The cache
 * debounces its write by 250ms and commits the rest on React unmount, which a
 * closing window does not run, so an edit newer than that debounce does not
 * survive the close. That is true of Command-W and the traffic light too — it
 * belongs to the draft cache's teardown, not to this keystroke. A sweep would
 * not close it either, because a sweep reads the DOM and the loss is in the
 * cache, so it is a reason to fix the flush rather than a reason to sweep here.
 */
export function escapeClosesWindow(event: KeyboardEvent, unsavedTextScope: Element | null = null): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || isComposingKeyEvent(event)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target instanceof Element ? event.target : null;
  const dismissableLayer = target?.closest(
    '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]',
  );
  return !dismissableLayer && !holdsUnsavedText(target) && !scopeHoldsUnsavedText(unsavedTextScope);
}

/**
 * Closes this window when a bare Escape reaches it with no nearer claim on it.
 *
 * `enabled` is what keeps the gesture to the windows it belongs to: a screen
 * that is also a route inside the main window — Settings is one — would
 * otherwise shut the workspace itself on a keystroke meant for the screen.
 *
 * The listener sits on `window` in the bubble phase, so everything between the
 * keystroke and here gets first refusal: `preventDefault()` from a field that
 * consumed it, `stopPropagation()` from one that owns the whole event, and
 * Radix's own dismissal of whatever layer is on top.
 */
export function useEscapeClosesWindow({ enabled = true, unsavedTextScope, onClose }: {
  enabled?: boolean;
  unsavedTextScope?: RefObject<Element | null>;
  /** Replaces closing the window, where the screen is a route in a browser tab. */
  onClose?: () => void;
} = {}): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const close = (event: KeyboardEvent): void => {
      if (escapeClosesWindow(event, unsavedTextScope?.current ?? null)) (onClose ?? (() => window.close()))();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [enabled, onClose, unsavedTextScope]);
}

/** Input types Escape may close the window over: the rest hold no typing. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['email', 'number', 'password', 'search', 'tel', 'text', 'url']);

function holdsUnsavedText(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement) return target.value.trim() !== '';
  if (target instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(target.type) && target.value.trim() !== '';
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Whether the scope a window nominated holds typing, wherever focus happens to be.
 *
 * A draft is abandoned by the window closing, not by the caret leaving it: an
 * invitation typed and then left while its Role select or Send button takes
 * focus is the same unsaved text it was a keystroke earlier. Scoping the sweep
 * to one element is what keeps that from becoming "any text anywhere" — a
 * sidebar search box is a filter rather than a draft, a generated endpoint or
 * signing secret is `readOnly` and already saved, and Radix portals every
 * dialog's fields out of the subtree, where an open dialog owns Escape anyway.
 * A pane that is not the active one is not in the DOM, so what is protected is
 * what the person can see.
 *
 * A field carrying `data-saved-value` is compared against it rather than against
 * emptiness, so a section that renders a stored value into a writable field does
 * not leave Escape permanently dead in that section.
 */
function scopeHoldsUnsavedText(scope: Element | null): boolean {
  if (!scope) return false;
  return [...scope.querySelectorAll('input, textarea')].some((field) => {
    if (field instanceof HTMLInputElement && !TEXT_ENTRY_INPUT_TYPES.has(field.type)) return false;
    const editable = field as HTMLInputElement | HTMLTextAreaElement;
    const savedValue = editable.dataset.savedValue;
    if (savedValue !== undefined) return !editable.readOnly && !editable.disabled && editable.value !== savedValue;
    return !editable.readOnly && !editable.disabled && editable.value.trim() !== '';
  });
}
