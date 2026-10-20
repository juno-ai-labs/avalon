import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import {
  useWorkstreamSocket,
  type WorkstreamSocketApi,
  type WorkstreamSocketConnection,
} from './use-workstream-socket';
import type { ConversationParentKind } from '@rally/contracts/conversation-parent';
import { uuidV7 } from './telemetry';

export const RECENT_WORKSTREAM_SOCKET_RETENTION_MS = 5 * 60_000;
export const WORKSTREAM_SOCKET_HOVER_WARMUP_MS = 1_000;

interface RetainedWorkstreamSocketActionsContextValue {
  activeWorkstreamId: string | null;
  admit: (workstreamId: string) => void;
  openContext: (workstreamId: string) => WorkstreamSocketOpenContext;
  warm: (workstreamId: string) => void;
}

export interface WorkstreamSocketOpenContext {
  state: 'retained_pair' | 'control_warmup' | 'cold';
  socketLeaseId?: string;
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
  active,
  admitted,
  api,
  background,
  controlWarm,
  onConnection,
  onRelease,
  socketLeaseId,
  workstreamId,
}: {
  active: boolean;
  admitted: boolean;
  api: WorkstreamSocketApi | null;
  background: boolean;
  controlWarm: boolean;
  onConnection: (workstreamId: string, connection: WorkstreamSocketConnection) => void;
  onRelease: (workstreamId: string) => void;
  socketLeaseId: string;
  workstreamId: string;
}): null {
  // A held Channel keeps one socket, its Main feed. Its metadata, breakouts
  // and background agents ride the Organization socket's Channel rows.
  const feedEnabled = active || background || admitted || controlWarm;
  const initialReason = controlWarm && !active && !background && !admitted
    ? 'hover_warmup'
    : active ? 'active_workstream' : background ? 'background_workstream' : 'retained_workstream';
  const connection = useWorkstreamSocket(
    api,
    workstreamId,
    feedEnabled,
    initialReason,
    socketLeaseId,
    // Routing can precede the workspace profile. Only the mounted feed admits
    // viewing; speculative startup connections must not mark a room opened.
    admitted,
    '0',
    'workstream',
    active,
  );
  useLayoutEffect(() => {
    if (active || admitted) onConnection(workstreamId, connection);
  }, [active, admitted, connection, onConnection, workstreamId]);
  useLayoutEffect(() => () => {
    onRelease(workstreamId);
  }, [onRelease, workstreamId]);
  return null;
}

function RetainedWorkstreamSocketOwners({
  activeWorkstreamId,
  admittedWorkstreamIds,
  api,
  backgroundWorkstreamIds,
  controlWarmWorkstreamId,
  onConnection,
  onRelease,
  socketLeaseIds,
  workstreamIds,
}: {
  activeWorkstreamId: string | null;
  admittedWorkstreamIds: ReadonlySet<string>;
  api: WorkstreamSocketApi | null;
  backgroundWorkstreamIds: ReadonlySet<string>;
  controlWarmWorkstreamId: string | null;
  onConnection: (workstreamId: string, connection: WorkstreamSocketConnection) => void;
  onRelease: (workstreamId: string) => void;
  socketLeaseIds: ReadonlyMap<string, string>;
  workstreamIds: readonly string[];
}): React.JSX.Element {
  return (
    <>
      {workstreamIds.map((workstreamId) => (
        <RetainedWorkstreamSocket
          active={activeWorkstreamId === workstreamId}
          admitted={admittedWorkstreamIds.has(workstreamId)}
          api={api}
          background={backgroundWorkstreamIds.has(workstreamId)}
          controlWarm={controlWarmWorkstreamId === workstreamId}
          key={workstreamId}
          onConnection={onConnection}
          onRelease={onRelease}
          socketLeaseId={socketLeaseIds.get(workstreamId)!}
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
 *
 * Channels only. An automation's conversation is opened by its own screen
 * through `useRetainedWorkstreamSocket` with `parentKind: 'automation'`, which
 * never matches the pool and so is never warmed by it.
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
  const admittedWorkstreamIdsRef = useRef(admittedWorkstreamIds);
  admittedWorkstreamIdsRef.current = admittedWorkstreamIds;
  const controlWarmRef = useRef(controlWarm);
  controlWarmRef.current = controlWarm;
  const socketLeaseIdsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const backgroundWorkstreamIdSet = useMemo(
    () => new Set(backgroundWorkstreamIds),
    [backgroundWorkstreamIds],
  );
  const backgroundWorkstreamIdsRef = useRef<ReadonlySet<string>>(backgroundWorkstreamIdSet);
  backgroundWorkstreamIdsRef.current = backgroundWorkstreamIdSet;
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
  const openContext = useCallback((workstreamId: string): WorkstreamSocketOpenContext => {
    const state = admittedWorkstreamIdsRef.current.has(workstreamId)
      || backgroundWorkstreamIdsRef.current.has(workstreamId)
      || controlWarmRef.current?.workstreamId === workstreamId
      ? 'retained_pair' as const
      : 'cold' as const;
    const socketLeaseId = socketLeaseIdsRef.current.get(workstreamId);
    return { state, ...(socketLeaseId ? { socketLeaseId } : {}) };
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
    openContext,
    warm,
  }), [activeWorkstreamId, admit, openContext, warm]);
  const ownerWorkstreamIds = useMemo(() => [...new Set([
    ...workstreamIds,
    ...(controlWarm === null ? [] : [controlWarm.workstreamId]),
  ])], [controlWarm, workstreamIds]);
  const socketLeaseIds = useMemo(() => {
    const previous = socketLeaseIdsRef.current;
    const next = new Map<string, string>();
    for (const workstreamId of ownerWorkstreamIds) {
      next.set(workstreamId, previous.get(workstreamId) ?? uuidV7());
    }
    socketLeaseIdsRef.current = next;
    return next;
  }, [ownerWorkstreamIds]);
  return (
    <RetainedWorkstreamSocketActionsContext.Provider value={actions}>
      <RetainedWorkstreamSocketConnectionsContext.Provider value={connections}>
        <RetainedWorkstreamSocketOwners
          activeWorkstreamId={activeWorkstreamId}
          admittedWorkstreamIds={admittedWorkstreamIds}
          api={api}
          backgroundWorkstreamIds={backgroundWorkstreamIdSet}
          controlWarmWorkstreamId={controlWarm?.workstreamId ?? null}
          onConnection={publishConnection}
          onRelease={release}
          socketLeaseIds={socketLeaseIds}
          workstreamIds={ownerWorkstreamIds}
        />
        {children}
      </RetainedWorkstreamSocketConnectionsContext.Provider>
    </RetainedWorkstreamSocketActionsContext.Provider>
  );
}

/**
 * Warm a Channel's Main feed after a deliberate sidebar hover. Feed
 * subscriptions opt out of presence, so preparing the first canonical frame
 * does not make a hovered work stream appear viewed.
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

export function useWorkstreamSocketOpenContext(
  parentId: string,
): () => WorkstreamSocketOpenContext {
  const actions = useContext(RetainedWorkstreamSocketActionsContext);
  return useCallback(
    () => actions?.openContext(parentId) ?? { state: 'cold' },
    [actions, parentId],
  );
}

/**
 * Read the connection owned by `WorkstreamSocketPool`. The direct disabled
 * hook keeps standalone screen tests and non-shell embeddings compatible
 * without opening a duplicate socket in the real application.
 *
 * The pool retains Channel Main feeds only: its active id is the one on the
 * `/workstreams/:id` route. An automation parent, or any substream other than
 * the main one, therefore always takes the direct hook.
 */
export function useRetainedWorkstreamSocket(
  api: WorkstreamSocketApi | null,
  parentId: string,
  enabled: boolean,
  parentKind: ConversationParentKind = 'workstream',
  substreamId = '0',
): WorkstreamSocketConnection {
  const actions = useContext(RetainedWorkstreamSocketActionsContext);
  const connections = useContext(RetainedWorkstreamSocketConnectionsContext);
  const matchesRetainedConnection = parentKind === 'workstream'
    && substreamId === '0'
    && actions?.activeWorkstreamId === parentId;
  const admit = actions?.admit;
  useLayoutEffect(() => {
    if (enabled && matchesRetainedConnection) admit?.(parentId);
  }, [admit, enabled, matchesRetainedConnection, parentId]);
  const direct = useWorkstreamSocket(
    api,
    parentId,
    enabled && !matchesRetainedConnection,
    'active_workstream',
    undefined,
    true,
    substreamId,
    parentKind,
  );
  return matchesRetainedConnection ? connections.get(parentId) ?? direct : direct;
}
