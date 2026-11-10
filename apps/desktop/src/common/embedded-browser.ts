import { z } from 'zod';

/** The local, user-owned browser surface and command protocol. */
export interface EmbeddedBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page's own icon, an https or image data URL, or null. */
  favicon: string | null;
}

export interface EmbeddedBrowserState {
  tabs: EmbeddedBrowserTab[];
  activeTabId: string | null;
}

export interface EmbeddedBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The browser executes commands in its own Chromium contents. No command
 * evaluates code in Electron's main process or receives Rally's preload.
 */
export type EmbeddedBrowserCommand =
  | { action: 'open'; url?: string }
  | { action: 'close'; tabId: string }
  | { action: 'select'; tabId: string }
  | { action: 'move'; tabId: string; index: number }
  | { action: 'navigate'; tabId?: string; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop'; tabId?: string };

export type EmbeddedBrowserResult = { kind: 'state'; state: EmbeddedBrowserState };

const tabId = z.string().uuid();
const target = { tabId: tabId.optional() };
const coordinate = z.number().finite();
export const EmbeddedBrowserBoundsSchema = z.strictObject({
  x: coordinate, y: coordinate, width: coordinate, height: coordinate,
});
export const EmbeddedBrowserCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), url: z.string().optional() }),
  z.strictObject({ action: z.literal('close'), tabId }),
  z.strictObject({ action: z.literal('select'), tabId }),
  z.strictObject({ action: z.literal('move'), tabId, index: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal('navigate'), ...target, url: z.string() }),
  z.strictObject({ action: z.enum(['back', 'forward', 'reload', 'stop']), ...target }),
]);

export function embeddedBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.href === 'about:blank'
      ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * What a shortcut pressed inside a page asks of the host's own controls: the
 * address field, or the close of the only tab, which the host may turn into
 * closing the browser.
 */
export type EmbeddedBrowserHostRequest = 'focus-address' | 'close-last-tab';

/** What a browser keyboard shortcut asks for. */
export type EmbeddedBrowserShortcut =
  | { kind: 'new-tab' | 'close-tab' | 'focus-address' | 'reload' | 'next-tab' | 'previous-tab' | 'back' | 'forward' }
  | { kind: 'tab-at'; index: number | 'last' };

/**
 * The browser's shortcuts, one definition for a key pressed in Rally's own
 * controls and one pressed inside a visited page. `command` is the platform's
 * primary modifier: Command on macOS, Control elsewhere.
 */
export function embeddedBrowserShortcut(key: {
  key: string; code: string; command: boolean; control: boolean; shift: boolean; alt: boolean;
}): EmbeddedBrowserShortcut | null {
  if (key.alt) return null;
  if (key.control && key.key === 'Tab') return { kind: key.shift ? 'previous-tab' : 'next-tab' };
  if (!key.command) return null;
  if (key.shift && key.code === 'BracketRight') return { kind: 'next-tab' };
  if (key.shift && key.code === 'BracketLeft') return { kind: 'previous-tab' };
  if (key.shift) return null;
  const letter = key.key.toLowerCase();
  if (letter === 't') return { kind: 'new-tab' };
  if (letter === 'w') return { kind: 'close-tab' };
  if (letter === 'l') return { kind: 'focus-address' };
  if (letter === 'r') return { kind: 'reload' };
  if (key.code === 'BracketLeft') return { kind: 'back' };
  if (key.code === 'BracketRight') return { kind: 'forward' };
  if (/^[1-8]$/u.test(key.key)) return { kind: 'tab-at', index: Number(key.key) - 1 };
  if (key.key === '9') return { kind: 'tab-at', index: 'last' };
  return null;
}

/** An icon a page declares, only when it is safe to draw in Rally's own renderer. */
export function embeddedBrowserFavicon(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml)[;,]/iu.test(raw)) return raw;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
