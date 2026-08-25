import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import {
  useWorkstreamSocket,
  type WorkstreamSocketApi,
  type WorkstreamSocketConnection,
} from './use-workstream-socket';

export const RECENT_WORKSTREAM_SOCKET_RETENTION_MS = 5 * 60_000;

interface RetainedWorkstreamSocketContextValue {
  connection: WorkstreamSocketConnection;
  workstreamId: string;
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
): string[] {
  const previousActiveWorkstreamId = useRef(activeWorkstreamId);
  const [recentlyViewedUntil, setRecentlyViewedUntil] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const justLeftWorkstreamId = previousActiveWorkstreamId.current !== activeWorkstreamId
    ? previousActiveWorkstreamId.current
    : null;

  useLayoutEffect(() => {
    previousActiveWorkstreamId.current = activeWorkstreamId;
    if (justLeftWorkstreamId === null) return;
    const retainUntil = Date.now() + RECENT_WORKSTREAM_SOCKET_RETENTION_MS;
    setRecentlyViewedUntil((current) => {
      const next = new Map(current);
      next.set(justLeftWorkstreamId, retainUntil);
      return next;
    });
  }, [activeWorkstreamId, justLeftWorkstreamId]);

  useEffect(() => {
    if (recentlyViewedUntil.size === 0) return;
    const expiresAt = Math.min(...recentlyViewedUntil.values());
    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setRecentlyViewedUntil((current) => {
        const next = new Map([...current].filter(([, retainUntil]) => retainUntil > now));
        return next.size === current.size ? current : next;
      });
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [recentlyViewedUntil]);

  return retainedWorkstreamSocketIds(
    activeWorkstreamId,
    backgroundWorkstreamIds,
    [...recentlyViewedUntil.keys()],
    justLeftWorkstreamId,
  );
}

function RetainedWorkstreamSocket({
  active,
  api,
  children,
  workstreamId,
}: PropsWithChildren<{
  active: boolean;
  api: WorkstreamSocketApi | null;
  workstreamId: string;
}>): React.JSX.Element | null {
  const connection = useWorkstreamSocket(api, workstreamId, true);
  const context = useMemo(() => ({ connection, workstreamId }), [connection, workstreamId]);
  if (!active) return null;
  return (
    <RetainedWorkstreamSocketContext.Provider value={context}>
      {children}
    </RetainedWorkstreamSocketContext.Provider>
  );
}

/**
 * Own work-stream sockets above the route so changing routes does not tear down
 * the connection that was just being viewed. Keyed children keep the same hook
 * mounted while a work stream moves between foreground, recent, and running.
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
  const workstreamIds = useRetainedWorkstreamSocketIds(activeWorkstreamId, backgroundWorkstreamIds);
  return (
    <>
      {workstreamIds.map((workstreamId) => (
        <RetainedWorkstreamSocket
          active={workstreamId === activeWorkstreamId}
          api={api}
          key={workstreamId}
          workstreamId={workstreamId}
        >
          {workstreamId === activeWorkstreamId ? children : null}
        </RetainedWorkstreamSocket>
      ))}
      {activeWorkstreamId === null ? children : null}
    </>
  );
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
  const matchesRetainedConnection = retained?.workstreamId === workstreamId;
  const direct = useWorkstreamSocket(api, workstreamId, enabled && !matchesRetainedConnection);
  return matchesRetainedConnection ? retained.connection : direct;
}
