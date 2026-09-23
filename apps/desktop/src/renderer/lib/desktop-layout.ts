import { useLayoutEffect, useRef, type RefObject } from 'react';

const PREFIX = 'rally.desktop-layout';

export function layoutKey(workspaceId: string, userId: string, part: string): string {
  return `${PREFIX}:${workspaceId}:${userId}:${part}`;
}

export function readLayout(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writeLayout(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* A full or unavailable local store must not block navigation. */ }
}

export interface SavedArtifactPanel { resourceId: string; workstreamScoped: boolean }

export function readArtifactPanel(key: string): SavedArtifactPanel | null {
  const raw = readLayout(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('resourceId' in value)
      || typeof value.resourceId !== 'string' || !('workstreamScoped' in value)
      || typeof value.workstreamScoped !== 'boolean') return null;
    return { resourceId: value.resourceId, workstreamScoped: value.workstreamScoped };
  } catch { return null; }
}

/** Save the first visible row's identity; list reordering then restores the row, not a pixel. */
export function useSemanticScroll(
  ref: RefObject<HTMLElement | null>, key: string, rowSelector: string, ready: boolean,
  onMissing?: () => void, missingRevision?: unknown,
): void {
  const restored = useRef<string | null>(null);
  const missingAttempt = useRef<{ key: string; saved: string; revision: unknown } | null>(null);
  useLayoutEffect(() => {
    if (!ready || restored.current === key) return;
    const container = ref.current;
    const saved = readLayout(key);
    if (!container) return;
    if (!saved) { restored.current = key; return; }
    const row = [...container.querySelectorAll<HTMLElement>(rowSelector)]
      .find((candidate) => candidate.dataset.layoutId === saved);
    if (!row) {
      if (onMissing) {
        const previous = missingAttempt.current;
        if (previous?.key !== key || previous.saved !== saved || previous.revision !== missingRevision) {
          missingAttempt.current = { key, saved, revision: missingRevision };
          onMissing();
        }
      }
      else { restored.current = key; writeLayout(key, null); }
      return;
    }
    row.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    restored.current = key;
  });
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    let frame: number | null = null;
    const save = (): void => {
      if (restored.current !== key) return;
      const top = container.getBoundingClientRect().top;
      const first = [...container.querySelectorAll<HTMLElement>(rowSelector)]
        .find((row) => row.getBoundingClientRect().bottom > top);
      if (first?.dataset.layoutId && readLayout(key) !== first.dataset.layoutId) writeLayout(key, first.dataset.layoutId);
    };
    const scheduleSave = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; save(); });
    };
    container.addEventListener('scroll', scheduleSave, { passive: true });
    return () => {
      container.removeEventListener('scroll', scheduleSave);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [key, ready, ref, rowSelector]);
}
