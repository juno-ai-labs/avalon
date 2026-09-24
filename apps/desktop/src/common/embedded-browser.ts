import { z } from 'zod';

/** The local, user-owned browser surface and command protocol. */
export interface EmbeddedBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
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
  | { action: 'navigate'; tabId?: string; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop'; tabId?: string }
  | { action: 'snapshot' | 'screenshot'; tabId?: string }
  | { action: 'click'; tabId?: string; x: number; y: number }
  | { action: 'scroll'; tabId?: string; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'type'; tabId?: string; text: string }
  | { action: 'key'; tabId?: string; key: string }
  | { action: 'evaluate'; tabId?: string; expression: string }
  | { action: 'cdp'; tabId?: string; method: string; params?: Record<string, unknown> };

export type EmbeddedBrowserResult =
  | { kind: 'state'; state: EmbeddedBrowserState }
  | { kind: 'snapshot'; url: string; title: string; tree: unknown }
  | { kind: 'screenshot'; mimeType: 'image/jpeg'; data: string }
  | { kind: 'value'; value: unknown };

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
  z.strictObject({ action: z.literal('navigate'), ...target, url: z.string() }),
  z.strictObject({ action: z.enum(['back', 'forward', 'reload', 'stop', 'snapshot', 'screenshot']), ...target }),
  z.strictObject({ action: z.literal('click'), ...target, x: coordinate, y: coordinate }),
  z.strictObject({ action: z.literal('scroll'), ...target, x: coordinate, y: coordinate, deltaX: coordinate, deltaY: coordinate }),
  z.strictObject({ action: z.literal('type'), ...target, text: z.string() }),
  z.strictObject({ action: z.literal('key'), ...target, key: z.string() }),
  z.strictObject({ action: z.literal('evaluate'), ...target, expression: z.string() }),
  z.strictObject({ action: z.literal('cdp'), ...target, method: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
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
