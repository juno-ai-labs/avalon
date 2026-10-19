import { z } from 'zod';
import type { DesktopActionResult } from '@rally/contracts/desktop-actions';
import type { StoredItem } from './desktop-actions/store';

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
 * One response a tab's page received since it last navigated, as the network
 * recorder saw it. `cached` says whether its body was kept: fetch and XHR
 * responses are copied as they finish, so they read back after Chromium
 * itself has let them go.
 */
export interface EmbeddedBrowserNetworkResponse {
  requestId: string;
  url: string;
  method: string;
  status: number;
  mimeType: string;
  /** Chromium's resource type: Document, Fetch, XHR, Script, Image, … */
  resourceType: string;
  /** Bytes received over the network, or null while the response is still loading. */
  size: number | null;
  cached: boolean;
}

/**
 * The browser executes commands in its own Chromium contents. No command
 * evaluates code in Electron's main process or receives Rally's preload.
 */
export type EmbeddedBrowserCommand =
  | { action: 'script'; tabId: string; runtimeId: string; code: string }
  | { action: 'script_reset'; tabId: string; runtimeId: string }
  | { action: 'open'; url?: string }
  | { action: 'close'; tabId: string }
  | { action: 'select'; tabId: string }
  | { action: 'move'; tabId: string; index: number }
  | { action: 'navigate'; tabId?: string; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop'; tabId?: string }
  | { action: 'snapshot' | 'screenshot'; tabId?: string }
  | { action: 'click'; tabId?: string; x: number; y: number }
  | { action: 'scroll'; tabId?: string; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'type'; tabId?: string; text: string }
  | { action: 'key'; tabId?: string; key: string }
  | { action: 'evaluate'; tabId?: string; expression: string }
  | { action: 'cdp'; tabId?: string; method: string; params?: Record<string, unknown> }
  | { action: 'network'; tabId?: string }
  | { action: 'response_body'; tabId?: string; requestId: string };

export type EmbeddedBrowserResult =
  | { kind: 'script'; result: DesktopActionResult<'browser.script'>; stored: StoredItem[] }
  | { kind: 'state'; state: EmbeddedBrowserState }
  | { kind: 'snapshot'; url: string; title: string; tree: unknown }
  | { kind: 'screenshot'; mimeType: 'image/jpeg'; data: string; width: number; height: number }
  | { kind: 'value'; value: unknown }
  | { kind: 'network'; responses: EmbeddedBrowserNetworkResponse[] }
  | { kind: 'response_body'; body: string; base64Encoded: boolean };

const tabId = z.string().uuid();
const target = { tabId: tabId.optional() };
const coordinate = z.number().finite();
export const EmbeddedBrowserBoundsSchema = z.strictObject({
  x: coordinate, y: coordinate, width: coordinate, height: coordinate,
});
export const EmbeddedBrowserCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('script'), tabId, runtimeId: z.string().uuid(), code: z.string().min(1) }),
  z.strictObject({ action: z.literal('script_reset'), tabId, runtimeId: z.string().uuid() }),
  z.strictObject({ action: z.literal('open'), url: z.string().optional() }),
  z.strictObject({ action: z.literal('close'), tabId }),
  z.strictObject({ action: z.literal('select'), tabId }),
  z.strictObject({ action: z.literal('move'), tabId, index: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal('navigate'), ...target, url: z.string() }),
  z.strictObject({ action: z.enum(['back', 'forward', 'reload', 'stop', 'snapshot', 'screenshot']), ...target }),
  z.strictObject({ action: z.literal('click'), ...target, x: coordinate, y: coordinate }),
  z.strictObject({ action: z.literal('scroll'), ...target, x: coordinate, y: coordinate, deltaX: coordinate, deltaY: coordinate }),
  z.strictObject({ action: z.literal('type'), ...target, text: z.string() }),
  z.strictObject({ action: z.literal('key'), ...target, key: z.string() }),
  z.strictObject({ action: z.literal('evaluate'), ...target, expression: z.string() }),
  z.strictObject({ action: z.literal('cdp'), ...target, method: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ action: z.literal('network'), ...target }),
  z.strictObject({ action: z.literal('response_body'), ...target, requestId: z.string().min(1) }),
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
