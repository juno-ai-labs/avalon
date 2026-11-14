import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { VISIBLE_PIN_COUNT, type MobileCommand, type MobileEvent, type MobileSnapshot, type NativeArtifact, type PreparedCanvas } from './protocol';

/** Descriptors share Home's authenticated session; access URLs are never cached. */
export function usePreparedCanvases(directory: MobileSnapshot | null, send: (command: MobileCommand) => void) {
  const available = useRef<string | null>(null);
  const current = useRef(directory);
  current.current = directory;
  const [entries, setEntries] = useState<Record<string, { userId: string; workspaceId: string; canvas: PreparedCanvas }>>({});
  const [sessions, setSessions] = useState<Record<string, { scope: string; artifact: NativeArtifact }>>({});
  const pending = useRef(new Map<string, { userId: string; workspaceId: string; resolve: (artifact: NativeArtifact | null) => void }>());
  useEffect(() => {
    const requests = pending.current;
    return () => { for (const request of requests.values()) request.resolve(null); requests.clear(); };
  }, [directory?.userId, directory?.workspaceId]);
  useEffect(() => {
    setSessions((sessions) => Object.fromEntries(Object.entries(sessions).filter(([id, session]) => session.scope === `${directory?.userId}:${directory?.workspaceId}` && directory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id))));
    setEntries((entries) => Object.fromEntries(Object.entries(entries).filter(([id, entry]) => directory?.userId === entry.userId && directory.workspaceId === entry.workspaceId && directory.pins.slice(0, VISIBLE_PIN_COUNT).includes(id))));
  }, [directory?.userId, directory?.workspaceId, JSON.stringify(directory?.pins)]);
  const reset = useCallback(() => {
    available.current = null;
    for (const request of pending.current.values()) request.resolve(null);
    pending.current.clear();
  }, []);
  const receive = useCallback((event: MobileEvent) => {
    if (event.type === 'snapshot') available.current = event.snapshot.loading ? null : `${event.snapshot.userId}:${event.snapshot.workspaceId}`;
    if (event.type === 'signed-out') reset();
    if (event.type === 'prepared-canvas') {
      setEntries((entries) => {
        const next = { ...entries };
        if (event.canvas) next[event.canvasId] = { userId: event.userId, workspaceId: event.workspaceId, canvas: event.canvas };
        else delete next[event.canvasId];
        return next;
      });
      return true;
    }
    if (event.type === 'prepared-artifact') {
      const request = pending.current.get(event.requestId);
      if (request) {
        pending.current.delete(event.requestId);
        request.resolve(current.current?.userId === request.userId && current.current.workspaceId === request.workspaceId ? event.artifact : null);
      }
      return true;
    }
    return false;
  }, [reset]);
  const open = useCallback((canvas: PreparedCanvas) => {
    const directory = current.current;
    if (!directory || available.current !== `${directory.userId}:${directory.workspaceId}`) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise<NativeArtifact | null>((resolve) => {
      pending.current.set(requestId, { userId: directory.userId, workspaceId: directory.workspaceId, resolve });
      send({ type: 'open-prepared-artifact', requestId, userId: directory.userId, workspaceId: directory.workspaceId, canvas });
    });
  }, [send]);
  const rememberSession = useCallback((scope: string, artifact: NativeArtifact) => {
    if (scope !== `${current.current?.userId}:${current.current?.workspaceId}`) return;
    // Only the ordinary URL survives redemption. The cookie stays in WebKit /
    // Android's shared cookie store; no token is cached in application state.
    setSessions((sessions) => ({ ...sessions, [artifact.canvasId]: { scope, artifact: { ...artifact, openUrl: artifact.canonicalUrl } } }));
  }, []);
  const canvases = Object.fromEntries(Object.entries(entries).filter(([id, entry]) => directory?.userId === entry.userId && directory.workspaceId === entry.workspaceId && directory.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)).map(([id, entry]) => [id, entry.canvas]));
  const readySessions = Object.fromEntries(Object.entries(sessions).filter(([id, session]) => session.scope === `${directory?.userId}:${directory?.workspaceId}` && canvases[id]?.resourceId === session.artifact.resourceId).map(([id, session]) => [id, session.artifact]));
  return { canvases, sessions: readySessions, rememberSession, receive, open, reset };
}
