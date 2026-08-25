import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import {
  useWorkstreamSocket,
  type WorkstreamSocketApi,
  type WorkstreamSocketConnection,
} from './use-workstream-socket';

export const RECENT_WORKSTREAM_SOCKET_RETENTION_MS = 5 * 60_000;
export const WORKSTREAM_SOCKET_HOVER_WARMUP_MS = 1_000;

interface RetainedWorkstreamSocketContextValue {
  activeWorkstreamId: string | null;
  admit: (workstreamId: string) => void;
  connections: ReadonlyMap<string, WorkstreamSocketConnection>;
  warm: (workstreamId: string) => void;
}

const RetainedWorkstreamSocketContext = createContext<RetainedWorkstreamSocketContextValue | null>(null);

export function retainedWorkstreamSocketIds(
  activeWorkstreamId: string | null,
  backgroundWorkstreamIds: readonly string[],
  recentlyViewedWorkstreamIds: readonly string[],
  justLeftWorkstreamId: string | null,
): string[] {
  return [...new Set([
    ...(activeWorkstreamId === null ? [] : [activeWorkstreamId]),
    ...backgroundWorkstreamIds,
    ...recentlyViewedWorkstreamIds,
    ...(justLeftWorkstreamId === null ? [] : [justLeftWorkstreamId]),
  ])];
}

function useRetainedWorkstreamSocketIds(
  activeWorkstreamId: string | null,
  backgroundWorkstreamIds: readonly string[],
): {
  retain: (workstreamId: string) => void;
  workstreamIds: string[];
} {
  const previousActiveWorkstreamId = useRef(activeWorkstreamId);
  const [recentlyViewedUntil, setRecentlyViewedUntil] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const retain = useCallback((workstreamId: string) => {
    const retainUntil = Date.now() + RECENT_WORKSTREAM_SOCKET_RETENTION_MS;
    setRecentlyViewedUntil((current) => {
      const next = new Map(current);
      next.set(workstreamId, retainUntil);
      return next;
    });
  }, []);
  const justLeftWorkstreamId = previousActiveWorkstreamId.current !== activeWorkstreamId
    ? previousActiveWorkstreamId.current
    : null;

  useLayoutEffect(() => {
    previousActiveWorkstreamId.current = activeWorkstreamId;
    if (justLeftWorkstreamId === null) return;
    retain(justLeftWorkstreamId);
  }, [activeWorkstreamId, justLeftWorkstreamId, retain]);

  useEffect(() => {
    if (recentlyViewedUntil.size === 0) return;
    let timeout: number | null = null;
    const sweep = (): void => {
      const now = Date.now();
      const expiresAt = Math.min(...recentlyViewedUntil.values());
      if (expiresAt > now) {
        timeout = window.setTimeout(sweep, expiresAt - now);
        return;
      }
      setRecentlyViewedUntil((current) => {
        const next = new Map([...current].filter(([, retainUntil]) => retainUntil > now));
        return next.size === current.size ? current : next;
      });
    };
    const expiresAt = Math.min(...recentlyViewedUntil.values());
    timeout = window.setTimeout(sweep, Math.max(0, expiresAt - Date.now()));
    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [recentlyViewedUntil]);

  return {
    retain,
    workstreamIds: retainedWorkstreamSocketIds(
      activeWorkstreamId,
      backgroundWorkstreamIds,
      [...recentlyViewedUntil.keys()],
      justLeftWorkstreamId,
    ),
  };
}

function RetainedWorkstreamSocket({
  admitted,
  api,
  background,
  onAdmit,
  onConnection,
  onRelease,
  workstreamId,
}: {
  admitted: boolean;
  api: WorkstreamSocketApi | null;
  background: boolean;
  onAdmit: (workstreamId: string) => void;
  onConnection: (workstreamId: string, connection: WorkstreamSocketConnection) => void;
  onRelease: (workstreamId: string) => void;
  workstreamId: string;
}): null {
  useLayoutEffect(() => {
    if (background) onAdmit(workstreamId);
  }, [background, onAdmit, workstreamId]);
  const connection = useWorkstreamSocket(api, workstreamId, background || admitted);
  useLayoutEffect(() => {
    onConnection(workstreamId, connection);
  }, [connection, onConnection, workstreamId]);
  useLayoutEffect(() => () => {
    onRelease(workstreamId);
  }, [onRelease, workstreamId]);
  return null;
}

function RetainedWorkstreamSocketOwners({
  admittedWorkstreamIds,
  api,
  backgroundWorkstreamIds,
  onAdmit,
  onConnection,
  onRelease,
  workstreamIds,
}: {
  admittedWorkstreamIds: ReadonlySet<string>;
  api: WorkstreamSocketApi | null;
  backgroundWorkstreamIds: readonly string[];
  onAdmit: (workstreamId: string) => void;
  onConnection: (workstreamId: string, connection: WorkstreamSocketConnection) => void;
  onRelease: (workstreamId: string) => void;
  workstreamIds: readonly string[];
}): React.JSX.Element {
  return (
    <>
      {workstreamIds.map((workstreamId) => (
        <RetainedWorkstreamSocket
          admitted={admittedWorkstreamIds.has(workstreamId)}
          api={api}
          background={backgroundWorkstreamIds.includes(workstreamId)}
          key={workstreamId}
          onAdmit={onAdmit}
          onConnection={onConnection}
          onRelease={onRelease}
          workstreamId={workstreamId}
        />
      ))}
    </>
  );
}

/**
 * Own work-stream sockets above the route so changing routes does not tear down
 * the connection that was just being viewed. Keyed socket owners stay mounted
 * while the unkeyed route subtree keeps its normal in-place reconciliation.
 */
export function WorkstreamSocketPool({
  activeWorkstreamId,
  api,
  backgroundWorkstreamIds,
  children,
}: PropsWithChildren<{
  activeWorkstreamId: string | null;
  api: WorkstreamSocketApi | null;
  backgroundWorkstreamIds: readonly string[];
}>): React.JSX.Element {
  const { retain, workstreamIds } = useRetainedWorkstreamSocketIds(
    activeWorkstreamId,
    backgroundWorkstreamIds,
  );
  const [admittedWorkstreamIds, setAdmittedWorkstreamIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [connections, setConnections] = useState<ReadonlyMap<string, WorkstreamSocketConnection>>(
    () => new Map(),
  );
  const admit = useCallback((workstreamId: string) => {
    setAdmittedWorkstreamIds((current) => {
      if (current.has(workstreamId)) return current;
      return new Set(current).add(workstreamId);
    });
  }, []);
  const warm = useCallback((workstreamId: string) => {
    admit(workstreamId);
    retain(workstreamId);
  }, [admit, retain]);
  const publishConnection = useCallback((
    workstreamId: string,
    connection: WorkstreamSocketConnection,
  ) => {
    setConnections((current) => {
      if (current.get(workstreamId) === connection) return current;
      const next = new Map(current);
      next.set(workstreamId, connection);
      return next;
    });
  }, []);
  const release = useCallback((workstreamId: string) => {
    setAdmittedWorkstreamIds((current) => {
      if (!current.has(workstreamId)) return current;
      const next = new Set(current);
      next.delete(workstreamId);
      return next;
    });
    setConnections((current) => {
      if (!current.has(workstreamId)) return current;
      const next = new Map(current);
      next.delete(workstreamId);
      return next;
    });
  }, []);
  const context = useMemo<RetainedWorkstreamSocketContextValue>(() => ({
    activeWorkstreamId,
    admit,
    connections,
    warm,
  }), [activeWorkstreamId, admit, connections, warm]);
  return (
    <RetainedWorkstreamSocketContext.Provider value={context}>
      <RetainedWorkstreamSocketOwners
        admittedWorkstreamIds={admittedWorkstreamIds}
        api={api}
        backgroundWorkstreamIds={backgroundWorkstreamIds}
        onAdmit={admit}
        onConnection={publishConnection}
        onRelease={release}
        workstreamIds={workstreamIds}
      />
      {children}
    </RetainedWorkstreamSocketContext.Provider>
  );
}

/**
 * Warm the pooled WorkstreamDO/SubstreamAgent pair after a deliberate sidebar
 * hover. Leaving before the threshold cancels the request; once opened, the
 * ordinary recent-work-stream lifetime owns the pair.
 */
export function useWorkstreamSocketHoverWarmup(workstreamId: string): {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const retained = useContext(RetainedWorkstreamSocketContext);
  const timeout = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timeout.current === null) return;
    window.clearTimeout(timeout.current);
    timeout.current = null;
  }, []);
  const start = useCallback(() => {
    cancel();
    if (!retained || retained.activeWorkstreamId === workstreamId) return;
    timeout.current = window.setTimeout(() => {
      timeout.current = null;
      retained.warm(workstreamId);
    }, WORKSTREAM_SOCKET_HOVER_WARMUP_MS);
  }, [cancel, retained, workstreamId]);
  useEffect(() => cancel, [cancel]);
  return useMemo(() => ({
    onPointerEnter: start,
    onPointerLeave: cancel,
  }), [cancel, start]);
}

/**
 * Read the connection owned by `WorkstreamSocketPool`. The direct disabled
 * hook keeps standalone screen tests and non-shell embeddings compatible
 * without opening a duplicate socket in the real application.
 */
export function useRetainedWorkstreamSocket(
  api: WorkstreamSocketApi | null,
  workstreamId: string,
  enabled: boolean,
): WorkstreamSocketConnection {
  const retained = useContext(RetainedWorkstreamSocketContext);
  const matchesRetainedConnection = retained?.activeWorkstreamId === workstreamId;
  const admit = retained?.admit;
  useLayoutEffect(() => {
    if (enabled && matchesRetainedConnection) admit?.(workstreamId);
  }, [admit, enabled, matchesRetainedConnection, workstreamId]);
  const direct = useWorkstreamSocket(api, workstreamId, enabled && !matchesRetainedConnection);
  return matchesRetainedConnection ? retained?.connections.get(workstreamId) ?? direct : direct;
}
