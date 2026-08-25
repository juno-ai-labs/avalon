import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import {
  useWorkstreamSocket,
  type WorkstreamSocketApi,
  type WorkstreamSocketConnection,
} from './use-workstream-socket';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';

export const RECENT_WORKSTREAM_SOCKET_RETENTION_MS = 5 * 60_000;
export const WORKSTREAM_SOCKET_HOVER_WARMUP_MS = 1_000;

interface RetainedWorkstreamSocketActionsContextValue {
  activeWorkstreamId: string | null;
  admit: (workstreamId: string) => void;
  warm: (workstreamId: string) => void;
}

const RetainedWorkstreamSocketActionsContext = createContext<RetainedWorkstreamSocketActionsContextValue | null>(null);
const RetainedWorkstreamSocketConnectionsContext = createContext<ReadonlyMap<string, WorkstreamSocketConnection>>(
  new Map(),
);

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
  controlWarm,
  onAdmit,
  onConnection,
  onRelease,
  workstreamId,
}: {
  admitted: boolean;
  api: WorkstreamSocketApi | null;
  background: boolean;
  controlWarm: boolean;
  onAdmit: (workstreamId: string) => void;
  onConnection: (workstreamId: string, connection: WorkstreamSocketConnection) => void;
  onRelease: (workstreamId: string) => void;
  workstreamId: string;
}): null {
  useLayoutEffect(() => {
    if (background) onAdmit(workstreamId);
  }, [background, onAdmit, workstreamId]);
  const feedEnabled = background || admitted;
  useWorkstreamControlSocket(api, workstreamId, controlWarm || feedEnabled);
  const connection = useWorkstreamSocket(api, workstreamId, feedEnabled, true);
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
  controlWarmWorkstreamId,
  onAdmit,
  onConnection,
  onRelease,
  workstreamIds,
}: {
  admittedWorkstreamIds: ReadonlySet<string>;
  api: WorkstreamSocketApi | null;
  backgroundWorkstreamIds: readonly string[];
  controlWarmWorkstreamId: string | null;
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
          controlWarm={controlWarmWorkstreamId === workstreamId}
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
  const { workstreamIds } = useRetainedWorkstreamSocketIds(
    activeWorkstreamId,
    backgroundWorkstreamIds,
  );
  const [admittedWorkstreamIds, setAdmittedWorkstreamIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [connections, setConnections] = useState<ReadonlyMap<string, WorkstreamSocketConnection>>(
    () => new Map(),
  );
  const [controlWarm, setControlWarm] = useState<{
    expiresAt: number;
    workstreamId: string;
  } | null>(null);
  const admit = useCallback((workstreamId: string) => {
    setAdmittedWorkstreamIds((current) => {
      if (current.has(workstreamId)) return current;
      return new Set(current).add(workstreamId);
    });
  }, []);
  const warm = useCallback((workstreamId: string) => {
    setControlWarm({
      expiresAt: Date.now() + RECENT_WORKSTREAM_SOCKET_RETENTION_MS,
      workstreamId,
    });
  }, []);
  useEffect(() => {
    if (!controlWarm) return;
    let timeout: number | null = null;
    const expire = (): void => {
      const remaining = controlWarm.expiresAt - Date.now();
      if (remaining > 0) {
        timeout = window.setTimeout(expire, remaining);
        return;
      }
      setControlWarm((current) => current?.workstreamId === controlWarm.workstreamId
        && current.expiresAt === controlWarm.expiresAt
        ? null
        : current);
    };
    timeout = window.setTimeout(expire, Math.max(0, controlWarm.expiresAt - Date.now()));
    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [controlWarm]);
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
  const actions = useMemo<RetainedWorkstreamSocketActionsContextValue>(() => ({
    activeWorkstreamId,
    admit,
    warm,
  }), [activeWorkstreamId, admit, warm]);
  const ownerWorkstreamIds = useMemo(() => [...new Set([
    ...workstreamIds,
    ...(controlWarm === null ? [] : [controlWarm.workstreamId]),
  ])], [controlWarm, workstreamIds]);
  return (
    <RetainedWorkstreamSocketActionsContext.Provider value={actions}>
      <RetainedWorkstreamSocketConnectionsContext.Provider value={connections}>
        <RetainedWorkstreamSocketOwners
          admittedWorkstreamIds={admittedWorkstreamIds}
          api={api}
          backgroundWorkstreamIds={backgroundWorkstreamIds}
          controlWarmWorkstreamId={controlWarm?.workstreamId ?? null}
          onAdmit={admit}
          onConnection={publishConnection}
          onRelease={release}
          workstreamIds={ownerWorkstreamIds}
        />
        {children}
      </RetainedWorkstreamSocketConnectionsContext.Provider>
    </RetainedWorkstreamSocketActionsContext.Provider>
  );
}

/**
 * Warm one WorkstreamDO control socket after a deliberate sidebar hover.
 * SubstreamAgent subscription remains tied to opening the work stream so a
 * hover never publishes viewer presence.
 */
export function useWorkstreamSocketHoverWarmup(workstreamId: string): {
  onPointerCancel: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const actions = useContext(RetainedWorkstreamSocketActionsContext);
  const activeWorkstreamId = actions?.activeWorkstreamId ?? null;
  const activeWorkstreamIdRef = useRef(activeWorkstreamId);
  activeWorkstreamIdRef.current = activeWorkstreamId;
  const timeout = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timeout.current === null) return;
    window.clearTimeout(timeout.current);
    timeout.current = null;
  }, []);
  const start = useCallback(() => {
    cancel();
    if (!actions || activeWorkstreamIdRef.current === workstreamId) return;
    timeout.current = window.setTimeout(() => {
      timeout.current = null;
      if (activeWorkstreamIdRef.current !== workstreamId) actions.warm(workstreamId);
    }, WORKSTREAM_SOCKET_HOVER_WARMUP_MS);
  }, [actions, cancel, workstreamId]);
  useEffect(() => {
    if (activeWorkstreamId === workstreamId) cancel();
  }, [activeWorkstreamId, cancel, workstreamId]);
  useEffect(() => () => {
    cancel();
  }, [cancel]);
  return useMemo(() => ({
    onPointerCancel: cancel,
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
  const actions = useContext(RetainedWorkstreamSocketActionsContext);
  const connections = useContext(RetainedWorkstreamSocketConnectionsContext);
  const matchesRetainedConnection = actions?.activeWorkstreamId === workstreamId;
  const admit = actions?.admit;
  useLayoutEffect(() => {
    if (enabled && matchesRetainedConnection) admit?.(workstreamId);
  }, [admit, enabled, matchesRetainedConnection, workstreamId]);
  const direct = useWorkstreamSocket(api, workstreamId, enabled && !matchesRetainedConnection);
  return matchesRetainedConnection ? connections.get(workstreamId) ?? direct : direct;
}
