import { useEffect, useState } from 'react';
import { appearanceOf, defaultThemeChoice, parseAppearanceMode, parseResolvedTheme, resolveTheme, sameThemeChoice, type ResolvedTheme, type ThemeChoice } from '../themes';
import { readDevicePreferences, setDeviceTheme } from './device-preferences';


/**
 * Applying the chosen theme, and keeping it applied.
 *
 * The whole mechanism is one attribute: `data-theme` on `<html>`, which selects
 * one block of custom properties out of `styles/themes.css`. Nothing else in
 * the renderer branches on the appearance, and no component reads a colour.
 *
 * The choice is stored on the device rather than on the account. An appearance
 * belongs to the screen it is being looked at, and a person who works on a
 * bright laptop and a dark desktop should not have to keep changing it back.
 *
 * `data-theme` carries the resolved light or dark appearance and
 * `data-theme-mode` carries the choice that produced it, so a surface can tell
 * deliberate dark from a system setting that happens to resolve dark.
 */

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeState {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
}

const listeners = new Set<(state: ThemeState) => void>();

/**
 * What is on screen right now, read back off the document `applyTheme` stamped.
 *
 * The two attributes carry the whole state — the appearance being drawn and
 * the choice that produced it — so this is the applied truth rather than a
 * second copy of it kept alongside. The store is not that truth:
 * `watchThemeBroadcast` applies a choice that arrived over IPC precisely
 * because a `localStorage` write in another renderer is not ordered against
 * that message, so for a moment the store still holds the previous one.
 *
 * The store is the fallback for the only case the document cannot answer:
 * before `installTheme` has stamped anything, which is a test or the first
 * lines of a launch.
 */
function currentThemeState(): ThemeState {
  const root = document.documentElement;
  const resolved = parseResolvedTheme(root.dataset['theme']);
  const mode = parseAppearanceMode(root.dataset['themeMode']);
  if (resolved && mode) return { choice: mode, resolved };
  const choice = readThemeChoice();
  return { choice, resolved: resolvedThemeFor(choice) };
}

/**
 * jsdom implements no `matchMedia`, and neither does an Electron window early
 * enough to be certain of. Treating an absent implementation as "not dark"
 * makes `system` mean light there, which is the answer Chromium gives when the
 * platform expresses no preference.
 */
function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

export function readThemeChoice(): ThemeChoice {
  return readDevicePreferences().theme ?? defaultThemeChoice;
}

export function resolvedThemeFor(choice: ThemeChoice): ResolvedTheme {
  return resolveTheme(choice, systemPrefersDark());
}

/**
 * Tells the main process what is being drawn, so the *next* window it opens is
 * constructed with a matching `backgroundColor`. Nothing here waits on it, and
 * a build without the desktop bridge has no window chrome to colour.
 *
 * The choice travels, not the appearance. Main re-resolves it against the Mac
 * at the moment it builds a window, which is the only way `system` survives the
 * app being closed while the Mac changes appearance.
 */
let reportTheme: ((choice: ThemeChoice) => void) | undefined;
export function setThemeReporter(report: (choice: ThemeChoice) => void): void { reportTheme = report; }

/** Stamps the resolved appearance onto the document and announces it. */
export function applyTheme(choice: ThemeChoice): ThemeState {
  const resolved = resolvedThemeFor(choice);
  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.dataset['themeMode'] = choice;
  const state: ThemeState = { choice, resolved };
  reportTheme?.(choice);
  for (const listener of listeners) listener(state);
  return state;
}

/**
 * Applies the stored choice before the first React render.
 *
 * Called from the renderer entry point rather than from an effect: an effect
 * fires after the first paint, so every launch would show a frame of the
 * default theme before correcting itself — the flash this exists to avoid.
 */
export function installTheme(): ThemeState {
  return applyTheme(readThemeChoice());
}

export function persistThemeChoice(choice: ThemeChoice): ThemeState {
  setDeviceTheme(choice);
  return applyTheme(choice);
}

/**
 * Re-resolves the `system` mode when the Mac changes appearance.
 *
 * The returned function detaches the listener.
 */
export function watchSystemAppearance(): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  const handler = (): void => {
    const choice = readThemeChoice();
    // Only `system` listens: a person who asked for Light or Dark has said what
    // they want.
    if (choice !== 'system') return;
    applyTheme(choice);
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

/**
 * Follows a theme chosen in another window.
 *
 * Every window reads the same stored preference, but each holds its own
 * document, so a choice made in the Settings window would otherwise repaint only
 * the Settings window.
 *
 * The payload is applied rather than the store re-read. Both carry the choice,
 * so `system` still re-resolves against *this* window's `matchMedia` either way
 * — but each window is its own renderer process, and a `localStorage` write in
 * the Settings renderer is not ordered against an IPC round trip through main.
 * A window that re-read a store the write had not reached yet would re-apply the
 * *old* choice and report it back, main would see a difference and broadcast
 * again, and the guard that stops the echo would instead be driving one. It
 * settles once storage propagates; what it looks like in the meantime is a
 * flicker across windows.
 *
 * A payload this build cannot read falls back to the store, which is the only
 * other thing that could be meant.
 */

/**
 * The active theme, for a component that has to name it. Reads what was
 * applied rather than what is stored, so that a surface mounted after
 * `installTheme` cannot disagree with what is on screen.
 *
 * Which is the whole difficulty: those two can differ. A choice made in the
 * Settings window arrives here over IPC, and `watchThemeBroadcast` applies it
 * without waiting for the `localStorage` write behind it — so a surface that
 * mounted from the store in that gap would draw the *previous* appearance and
 * then never hear about it, having already missed the announcement. The
 * re-read inside the effect closes the same gap one level down: React
 * subscribes after the render that snapshotted, and an `applyTheme` in between
 * would otherwise be lost. It keeps the previous object when nothing moved, so
 * the ordinary mount still renders once.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>(currentThemeState);
  useEffect(() => {
    listeners.add(setState);
    const current = currentThemeState();
    setState((previous) => (
      previous.resolved === current.resolved && sameThemeChoice(previous.choice, current.choice)
        ? previous
        : current
    ));
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/**
 * The lighting the document is currently drawn in, for a component that has to
 * be handed one rather than naming a token.
 *
 * `thinking-orbs` is the case this exists for: it paints a canvas, so no rule
 * can reach its ink, and it takes `dark`/`light` as a prop. Its own `auto`
 * detection cannot answer the question here — it looks for `data-theme="dark"`
 * or `data-theme="light"`, and ours carries an appearance name like
 * Rally can be pinned independently from `prefers-color-scheme`.
 */
export function useAppearance(): 'light' | 'dark' {
  return appearanceOf(useTheme().resolved);
}
