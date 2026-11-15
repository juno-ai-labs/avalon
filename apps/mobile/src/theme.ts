import { PALETTE_KEYS, PALETTE_RING, PALETTE_INK } from '../../../packages/contracts/src/palette';
import { useColorScheme } from 'react-native';
import base from '../../../config/design-tokens/base.json';
import lightTheme from '../../../config/design-tokens/themes/light.json';
import darkTheme from '../../../config/design-tokens/themes/dark.json';

// Read the same source tokens as Electron; React Native cannot consume CSS vars.
function nativeColors(appearance: typeof lightTheme | typeof darkTheme) {
  const tokens: Record<string, unknown> = { ...base.tokens, ...appearance.tokens };
  function value(key: string): string {
    const token = tokens[key];
    if (typeof token !== 'string') throw new Error(`Missing native color token: ${key}`);
    const reference = /^\{(.+)\}$/u.exec(token);
    return reference?.[1] ? value(reference[1]) : token;
  }
  function canvasColors(id: string | undefined, saved: string | null | undefined) {
    const fallback = id ? PALETTE_RING[[...id].reduce((hash, char) => hash + char.charCodeAt(0), 0) % PALETTE_RING.length]! : 'cyan';
    const key = PALETTE_KEYS.find((candidate) => candidate === saved) ?? fallback;
    const pastel = PALETTE_RING.some((candidate) => candidate === key);
    return {
      tint: value(pastel ? `sys.color.project-tint.${key}` : `sys.color.project.${key}`),
      ink: value(pastel ? `sys.color.project-ink.${key}` : `sys.color.palette-ink.${PALETTE_INK[key] === 'white' ? 'light' : 'dark'}`),
      // Match packages/ui's markColors: tile ink can vanish on a bare surface.
      bare: value(pastel ? `sys.color.project-ink.${key}` : `sys.color.project.${key}`),
      // The saturated hue, for mixes a stylesheet makes with `--av-sys-color-project-<key>`.
      hue: value(`sys.color.project.${key}`),
    };
  }
  return {
    canvasColors,
    background: value('sys.color.surface.canvas'), surface: value('sys.color.surface.raised'),
    sidebar: value('cmp.sidebar.background-solid'), tonal: value('sys.color.surface.subtle'),
    selected: value('cmp.row.background-selected'), text: value('sys.color.text.default'),
    muted: value('sys.color.text.muted'), line: value('sys.color.border.default'),
    accent: value('sys.color.text.default'), onAccent: value('sys.color.text.on-inverse'),
    scrim: value('sys.color.scrim.default'), error: value('sys.color.danger.base'),
  };
}
const light = nativeColors(lightTheme);
const dark = nativeColors(darkTheme);
/** One appearance's palette, for a surface drawn in a scheme other than the device's. */
export function themeColors(scheme: 'light' | 'dark') {
  return scheme === 'dark' ? dark : light;
}
export function useTheme() {
  const isDark = useColorScheme() === 'dark';
  return { colors: isDark ? dark : light, isDark };
}
export type Colors = typeof light;
