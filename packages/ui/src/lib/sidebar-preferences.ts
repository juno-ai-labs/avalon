import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from './sidebar-geometry';

/**
 * A hierarchy sidebar's width and collapsed state, kept per device in local
 * storage under a key its owner names. Persistence is best-effort: storage can
 * be absent or refuse a write, and the sidebar must still resize and collapse,
 * so every read falls back to the default and every write failure is dropped.
 */

export function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

export function loadSidebarWidth(key: string): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(key) ?? '');
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function loadSidebarCollapsed(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** Store a width or collapsed flag; the in-memory value stands if storage refuses it. */
export function saveSidebarPreference(key: string, value: number | boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Local persistence is best-effort; the sidebar still works without it.
  }
}
