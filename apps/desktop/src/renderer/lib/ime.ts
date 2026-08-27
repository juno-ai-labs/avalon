/**
 * Whether a key event belongs to an in-flight IME composition.
 *
 * Typing Japanese, Chinese, or Korean goes through an input method editor, and
 * between `compositionstart` and `compositionend` the IME owns every key the
 * person presses: `Enter` commits the candidate under the highlight, `Escape`
 * abandons the composition, and `Tab`, the digits, and the arrows walk the
 * candidate window. None of those keystrokes is the person talking to Rally, so
 * a handler that acts on one sends half-composed text — `nihao` in place of
 * 你好 — runs a command nobody chose, or destroys a composition that has no
 * undo.
 *
 * `isComposing` is the standard signal: the DOM sets it on every key event
 * dispatched while a composition is active, chords included. `keyCode === 229`
 * is the legacy signal for the same thing, kept as belt and braces because some
 * IME and platform paths still deliver a composition keydown with `isComposing`
 * unset — the keydown that *starts* a composition being the ordinary one. It is
 * not a Safari quirk; this renderer only ever runs on Electron's Chromium.
 *
 * Callers read the event rather than the composition state a component is
 * already tracking, because `compositionend` and the keydown that commits the
 * composition have no guaranteed order: where the browser ends the composition
 * first, that state is already false on the one keystroke this guard exists for.
 *
 * The parameter is structural so both a React synthetic event's `nativeEvent`
 * and a bare `KeyboardEvent` — what Radix hands `onEscapeKeyDown` — can be
 * passed without a cast.
 */
export function isComposingKeyEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
