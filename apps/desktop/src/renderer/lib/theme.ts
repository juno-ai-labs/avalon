import { useEffect, useState } from 'react';
import {
  appearanceOf,
  defaultThemeChoice,
  parseThemeChoice,
  resolveTheme,
  type AppearanceMode,
  type ResolvedTheme,
  type ThemeChoice,
  type ThemeFamily,
} from '../../common/themes';
import { readDevicePreferences, setDeviceTheme } from './device-preferences';
import { desktopBridge, desktopServicesAvailable } from './platform';

/**
 * Applying the chosen theme, and keeping it applied.
 *
 * The whole mechanism is one attribute: `data-theme` on `<html>`, which selects
 * one block of custom properties out of `styles/themes.css`. Nothing else in
 * the renderer branches on the theme, and no component reads a colour — which
 * is what keeps a new theme a block of CSS rather than a sweep of components.
 *
 * The choice is stored on the device rather than on the account. An appearance
 * belongs to the screen it is being looked at, and a person who works on a
 * bright laptop and a dark desktop should not have to keep changing it back.
 *
 * A choice has two parts — the design and the lighting — and only the second
 * follows the Mac. `data-theme` carries the appearance those two resolve to;
 * `data-theme-family` and `data-theme-mode` carry the choice itself, so a
 * surface that wants to say "System" can tell a deliberate dark from a system
 * that happens to be resolving dark.
 */

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeState {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
}

const listeners = new Set<(state: ThemeState) => void>();

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

/** Changing one axis and leaving the other alone, which is what the picker does. */
export function withFamily(choice: ThemeChoice, family: ThemeFamily): ThemeChoice {
  return { ...choice, family };
}

export function withMode(choice: ThemeChoice, mode: AppearanceMode): ThemeChoice {
  return { ...choice, mode };
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
function reportToMain(choice: ThemeChoice): void {
  if (!desktopServicesAvailable()) return;
  void desktopBridge().setWindowTheme(choice).catch(() => undefined);
}

/** Stamps the resolved appearance onto the document and announces it. */
export function applyTheme(choice: ThemeChoice): ThemeState {
  const resolved = resolvedThemeFor(choice);
  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.dataset['themeFamily'] = choice.family;
  root.dataset['themeMode'] = choice.mode;
  const state: ThemeState = { choice, resolved };
  reportToMain(choice);
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
    // Only `system` listens: a person who asked for Light has said what they
    // want. The *family* never follows the Mac — it is a taste, not a lighting
    // condition — so a person on Air who is following the room stays on Air.
    if (choice.mode !== 'system') return;
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
export function watchThemeBroadcast(): () => void {
  if (!desktopServicesAvailable()) return () => undefined;
  return desktopBridge().onThemeChanged((choice) => {
    applyTheme(parseThemeChoice(choice) ?? readThemeChoice());
  });
}

/**
 * The active theme, for a component that has to name it. Reads the document
 * rather than the store so that a surface mounted after `installTheme` cannot
 * disagree with what is on screen.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>(() => {
    const choice = readThemeChoice();
    return { choice, resolved: resolvedThemeFor(choice) };
  });
  useEffect(() => {
    listeners.add(setState);
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
 * `terra-light`, so `auto` falls through to `prefers-color-scheme` and ignores
 * a person who pinned the mode against their Mac.
 */
export function useAppearance(): 'light' | 'dark' {
  return appearanceOf(useTheme().resolved);
}
