import type { StoredRef } from '@rally/contracts/desktop-actions';

/**
 * Bytes of one file an agent may keep with the desktop.
 *
 * Bounds: one file held in the import window's memory, then again as base64
 *   and across IPC, before the API's upload sees it.
 * Without it: a conversation holding a 1 GB video makes the window hold
 *   ~1.3 GB before the API rejects the file, which can exhaust the renderer.
 *   Checked 2026-09-24: the API enforces its limit only after the bytes arrive.
 * Value: Rally's attachment upload limit, `MAX_ATTACHMENT_BYTES` in
 *   `apps/api/wrangler.global.jsonc` (25,000,000), chosen by the team on
 *   2026-09-24 so that no file the upload would accept is refused. Keep the
 *   two equal.
 * Trips: the store refuses the file with `file_too_large`; the agent records
 *   it as unavailable, saying why.
 */
export const MAX_STORED_FILE_BYTES = 25_000_000;

/** One stored value: a file's bytes as base64, or a JSON value as its text. */
export interface StoredItem {
  ref: StoredRef;
  /** Base64 for a file; JSON text for a JSON value. */
  data: string;
}

/**
 * What page script left with the desktop through `rally.store`, by handle.
 *
 * Lives in the window that runs the work, for as long as it does: the page
 * may navigate and lose its own globals, and the agent's handles still name
 * these. Nothing here leaves the desktop until a finish action reads it.
 */
export class DesktopActionStore {
  private readonly items = new Map<string, StoredItem>();

  add(item: StoredItem): void {
    this.items.set(item.ref.handle, item);
  }

  get(handle: string): StoredItem | undefined {
    return this.items.get(handle);
  }

  /** A stored JSON value, parsed; undefined when the handle names no JSON. */
  json(handle: string): unknown {
    const item = this.items.get(handle);
    if (!item || item.ref.kind !== 'json') return undefined;
    return JSON.parse(item.data) as unknown;
  }
}
