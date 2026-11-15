import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { preparedRequests } from './prepared-requests';
import { VISIBLE_PIN_COUNT, type MobileCommand, type MobileEvent, type MobileSnapshot, type NativeArtifact, type PreparedCanvas } from './protocol';

export type PreparedPins = {
  entries: Record<string, { userId: string; workspaceId: string; canvas: PreparedCanvas }>;
  sessions: Record<string, { scope: string; artifact: NativeArtifact }>;
};

/** Descriptors share Home's authenticated session; one-time access URLs are
 * never kept. `store` carries descriptors and canonical URLs across launches. */
export function usePreparedCanvases(directory: MobileSnapshot | null, send: (command: MobileCommand) => void, wake: () => void,
  store?: { initial: PreparedPins | null; save: (pins: PreparedPins) => void }) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const [requests] = useState(() => preparedRequests<PreparedCanvas, NativeArtifact>((command) => sendRef.current(command)));
  const current = useRef(directory);
  current.current = directory;
  const [entries, setEntries] = useState<PreparedPins['entries']>(() => store?.initial?.entries ?? {});
  const [sessions, setSessions] = useState<PreparedPins['sessions']>(() => store?.initial?.sessions ?? {});
  const save = store?.save;
  useEffect(() => { save?.({ entries, sessions }); }, [save, entries, sessions]);
  useEffect(() => () => requests.cancel(), [requests, directory?.userId, directory?.workspaceId]);
  useEffect(() => {
    setSessions((sessions) => Object.fromEntries(Object.entries(sessions).filter(([id, session]) => session.scope === `${directory?.userId}:${directory?.workspaceId}` && directory?.pins.slice(0, VISIBLE_PIN_COUNT).includes(id))));
    setEntries((entries) => Object.fromEntries(Object.entries(entries).filter(([id, entry]) => directory?.userId === entry.userId && directory.workspaceId === entry.workspaceId && directory.pins.slice(0, VISIBLE_PIN_COUNT).includes(id))));
  }, [directory?.userId, directory?.workspaceId, JSON.stringify(directory?.pins)]);
  /** Home's page is reloading: hold opens until it can answer again. */
  const reset = useCallback(() => requests.reload(), [requests]);
  /** Home failed or signed out: pending opens fail so their screens offer retry. */
  const fail = useCallback(() => { requests.setAvailable(null); requests.cancel(); }, [requests]);
  const receive = useCallback((event: MobileEvent) => {
    if (event.type === 'snapshot') requests.setAvailable(event.snapshot.loading ? null : `${event.snapshot.userId}:${event.snapshot.workspaceId}`);
    if (event.type === 'signed-out') fail();
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
      requests.reply(event.requestId, event.artifact, current.current ? `${current.current.userId}:${current.current.workspaceId}` : null);
      return true;
    }
    return false;
  }, [requests, fail]);
  const open = useCallback((canvas: PreparedCanvas) => {
    const directory = current.current;
    if (!directory) return Promise.resolve(null);
    const opening = requests.open(randomUUID(), directory.userId, directory.workspaceId, canvas);
    wake();
    return opening;
  }, [requests, wake]);
  const rememberSession = useCallback((scope: string, artifact: NativeArtifact) => {
    if (scope !== `${current.current?.userId}:${current.current?.workspaceId}`) return;
    // Only the ordinary URL survives redemption. The cookie stays in WebKit /
    // Android's shared cookie store; no token is cached in application state.
    setSessions((sessions) => ({ ...sessions, [artifact.canvasId]: { scope, artifact: { ...artifact, openUrl: artifact.canonicalUrl } } }));
  }, []);
  const visiblePins = JSON.stringify(directory?.pins.slice(0, VISIBLE_PIN_COUNT) ?? []);
  return useMemo(() => {
    const pins: string[] = JSON.parse(visiblePins);
    const canvases = Object.fromEntries(Object.entries(entries).filter(([id, entry]) => directory?.userId === entry.userId && directory.workspaceId === entry.workspaceId && pins.includes(id)).map(([id, entry]) => [id, entry.canvas]));
    const readySessions = Object.fromEntries(Object.entries(sessions).filter(([id, session]) => session.scope === `${directory?.userId}:${directory?.workspaceId}` && canvases[id]?.resourceId === session.artifact.resourceId).map(([id, session]) => [id, session.artifact]));
    return { canvases, sessions: readySessions, rememberSession, receive, open, reset, fail };
  // The directory object changes on every Home update; only its scope and visible pins matter here.
  }, [entries, sessions, directory?.userId, directory?.workspaceId, visiblePins, rememberSession, receive, open, reset, fail]);
}
