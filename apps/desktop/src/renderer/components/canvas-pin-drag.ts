import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react';

import { useCanvasList } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { splitPinned } from './navigation-rows';
import { ErrorNotice } from './primitives';

const CANVAS_DRAG_TYPE = 'application/x-rally-canvas';

const CanvasPinDragContext = createContext<ReturnType<typeof useCanvasPinController> | null>(null);

/** One drag and write lifecycle for both Canvas pin surfaces. */
export function CanvasPinDragProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const controller = useCanvasPinController();
  return createElement(CanvasPinDragContext.Provider, { value: controller }, children,
    controller.error && createElement(ErrorNotice, { occurrence: controller.error }, 'Canvas pins could not be updated. Try again.'));
}

export function useCanvasPinDrag() {
  const context = useContext(CanvasPinDragContext);
  if (!context) throw new Error('Canvas pin controls require CanvasPinDragProvider');
  return context;
}

function useCanvasPinController() {
  const { api } = useCollaborationSession();
  const rows = useCanvasList();
  const { pinned, rest } = useMemo(() => splitPinned(rows ?? []), [rows]);
  const [error, setError] = useState<Error | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [writing, setWriting] = useState(false);
  const inFlight = useRef(false);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const pending = useRef<string[] | null>(null);
  // The HTTP receipt can arrive before the list. Do not compute another move
  // from the old order, in either surface, until the pushed list has caught up.
  useEffect(() => {
    if (pendingOrder && pendingOrder.join(',') === pinned.map((row) => row.id).join(',')) {
      pending.current = null;
      setPendingOrder(null);
    }
  }, [pendingOrder, pinned]);
  const busy = writing || pendingOrder !== null;

  const move = async (id: string, before: string | null): Promise<void> => {
    if (!api || inFlight.current || pending.current || id === before) return;
    const row = rows?.find((candidate) => candidate.id === id);
    if (!row) return;
    const ids: string[] = pinned.filter((candidate) => candidate.id !== id).map((candidate) => candidate.id);
    const index = before === null ? ids.length : ids.indexOf(before);
    if (index < 0) return;
    ids.splice(index, 0, row.id);
    if (pinned.map((candidate) => candidate.id).join(',') === ids.join(',')) return;
    inFlight.current = true;
    setWriting(true);
    pending.current = ids;
    setPendingOrder(ids);
    setError(null);
    try {
      if (row.pinnedPosition == null) await api.setCanvasPinned(id, true);
      // A new pin already appends. Only an explicit insertion needs an order write.
      if (row.pinnedPosition != null || before !== null) await api.reorderCanvasPins(ids);
    } catch (cause) {
      pending.current = null;
      setPendingOrder(null);
      setError(cause instanceof Error ? cause : new Error('Canvas pins could not be updated.'));
    } finally {
      inFlight.current = false;
      setWriting(false);
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
      setDragging(false);
      void move(event.dataTransfer.getData(CANVAS_DRAG_TYPE), insertion(event, before));
    },
  });
  const sourceProps = (id: string): HTMLAttributes<HTMLElement> => ({
    draggable: !busy,
    onDragStart: (event) => {
      setDragging(true);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(CANVAS_DRAG_TYPE, id);
    },
    onDragEnd: () => { setOver(null); setDragging(false); },
    onKeyDown: (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const index = pinned.findIndex((row) => row.id === id);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowUp' && index > 0) void move(id, pinned[index - 1]?.id ?? null);
      if (event.key === 'ArrowDown' && index < pinned.length - 1) void move(id, pinned[index + 2]?.id ?? null);
    },
  });
  return { rows, pinned, rest, error, over, busy, dragging, sourceProps, targetProps };
}
