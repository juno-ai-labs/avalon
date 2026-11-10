import { useState, type DragEvent, type HTMLAttributes } from 'react';

import { useCanvasList } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { splitPinned } from './navigation-rows';

const CANVAS_DRAG_TYPE = 'application/x-rally-canvas';

/** Both Canvas pin surfaces use the same wire list and the same drag payload. */
export function useCanvasPinDrag() {
  const { api } = useCollaborationSession();
  const rows = useCanvasList();
  const { pinned } = splitPinned(rows ?? []);
  const [error, setError] = useState<Error | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = async (id: string, before: string | null): Promise<void> => {
    if (!api || busy || id === before) return;
    const row = rows?.find((candidate) => candidate.id === id);
    if (!row) return;
    const ids: string[] = pinned.filter((candidate) => candidate.id !== id).map((candidate) => candidate.id);
    const index = before === null ? ids.length : ids.indexOf(before);
    if (index < 0) return;
    ids.splice(index, 0, row.id);
    if (pinned.map((candidate) => candidate.id).join(',') === ids.join(',')) return;
    setBusy(true);
    setError(null);
    try {
      if (row.pinnedPosition == null) await api.setCanvasPinned(id, true);
      // A new pin already appends. Only an explicit insertion needs an order write.
      if (row.pinnedPosition != null || before !== null) await api.reorderCanvasPins(ids);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Canvas pins could not be updated.'));
    } finally {
      setBusy(false);
    }
  };

  const insertion = (event: DragEvent<HTMLElement>, id: string | null): string | null => {
    if (id === null) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientY <= bounds.top + bounds.height / 2) return id;
    const index = pinned.findIndex((row) => row.id === id);
    return pinned[index + 1]?.id ?? null;
  };
  const targetProps = (before: string | null = null): HTMLAttributes<HTMLElement> => ({
    onDragOver: (event) => {
      if (busy || !event.dataTransfer.types.includes(CANVAS_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setOver(insertion(event, before) ?? 'end');
    },
    onDragLeave: (event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(null);
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(CANVAS_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(null);
      void move(event.dataTransfer.getData(CANVAS_DRAG_TYPE), insertion(event, before));
    },
  });
  const sourceProps = (id: string): HTMLAttributes<HTMLElement> => ({
    draggable: !busy,
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(CANVAS_DRAG_TYPE, id);
    },
    onDragEnd: () => setOver(null),
    onKeyDown: (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const index = pinned.findIndex((row) => row.id === id);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowUp' && index > 0) void move(id, pinned[index - 1]?.id ?? null);
      if (event.key === 'ArrowDown' && index < pinned.length - 1) void move(id, pinned[index + 2]?.id ?? null);
    },
  });
  return { pinned, error, over, busy, sourceProps, targetProps };
}
