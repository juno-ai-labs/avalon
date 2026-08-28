import {
  AutomationAgentSnapshotSchema,
  AutomationDraftStreamEventSchema,
  type AutomationAgentSnapshot,
  type AutomationDraftStreamEvent,
} from '@rally/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { RallyApi } from './api';
import type { SocketState } from './use-workstream-socket';
import type { AutomationSummary } from './types';
import {
  createRealtimeSocket,
  REALTIME_SOCKET_CONNECTING,
  REALTIME_SOCKET_OPEN,
  type RealtimeSocket,
} from './realtime-socket';

type AutomationSocketApi = Pick<
  RallyApi,
  'getAutomationAgentDraft' | 'getAutomationAgentSocketTicket'
>;

/** Matches the work-stream feed's pair; see `use-workstream-socket.ts`. */
const HEARTBEAT_BASE_MS = 45_000;
const HEARTBEAT_JITTER_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
/**
 * How long a socket has to stay open before its handshake counts as having
 * worked. Resetting the attempt counter on `open` instead reconnects a
 * socket the server accepts and immediately closes at the floor delay,
 * forever — the same reason `use-workstream-socket.ts` waits.
 */
const STABLE_CONNECTION_MS = 30_000;

function heartbeatDelay(): number {
  return HEARTBEAT_BASE_MS + Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
}

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  // Equal jitter prevents a reconnect herd while retaining a useful minimum.
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

function browserIsOffline(): boolean {
  return navigator.onLine === false;
}

export interface AutomationAgentFeed {
  snapshot: AutomationAgentSnapshot | null;
  /**
   * The visible compiler run's narration, folded here rather than handed to
   * the screen one delta at a time. A turn emits hundreds of deltas and the
   * consumer re-reads whatever it is given per delta, so a growing array of
   * them costs the main thread the square of the turn's length. Thinking and
   * tool frames are few and stay in `streamEvents`, where the transcript
   * needs their identity.
   */
  narration: string;
  streamEvents: Array<{ sequence: number; event: AutomationDraftStreamEvent }>;
  connected: boolean;
  state: SocketState;
}

/**
 * The lifecycle a durable automation row shows while its draft is being
 * written. `activating` is the window between acceptance and the first
 * projection, which the sidebar has no separate state for and which reads
 * as active to everyone looking at it.
 */
function summaryStatus(
  lifecycle: AutomationAgentSnapshot['lifecycle'],
): AutomationSummary['status'] | null {
  if (lifecycle === 'draft') return 'draft';
  if (lifecycle === 'activating' || lifecycle === 'active') return 'active';
  if (lifecycle === 'paused') return 'paused';
  // A deleted automation leaves the list by the workspace socket's own
  // push, which drops the row rather than restating its status.
  return null;
}

/**
 * Reattaches the draft UI to AutomationAgent's durable snapshot/event log.
 * Stream deltas are applied locally; durable state-changing events trigger one
 * authoritative snapshot read instead of a polling loop.
 *
 * Every snapshot lands in the query cache rather than in this hook alone. A
 * draft's title and lifecycle are shown in two places — the builder reads
 * `['automation-draft', id]` and the sidebar row reads `['automations']` —
 * so one frame writes both in one update, for the reason
 * `applyHarnessStatus` in `use-workstream-socket.ts` gives: an invalidation
 * between them would put a REST round trip inside a change the socket had
 * already delivered, and a failed or raced refetch would leave the two
 * views disagreeing indefinitely.
 */
export function useAutomationAgentSocket(
  api: AutomationSocketApi | null,
  automationId: string | null,
): AutomationAgentFeed {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<AutomationAgentSnapshot | null>(null);
  const [narration, setNarration] = useState('');
  const [streamEvents, setStreamEvents] = useState<Array<{ sequence: number; event: AutomationDraftStreamEvent }>>([]);
  const [state, setState] = useState<SocketState>('idle');

  useEffect(() => {
    // Unconditionally, before anything about the new subject is known. The
    // previous draft's snapshot surviving into this one is what let the
    // builder show a blank slate for a highlighted draft — and admit a send
    // with no automation id, which opens a *second* draft beside the first.
    setSnapshot(null);
    setNarration('');
    setStreamEvents([]);
    if (!api || !automationId) {
      setState('idle');
      return;
    }
    setState(browserIsOffline() ? 'unavailable' : 'connecting');
    let stopped = false;
    /** The subject was refused; nothing here may reconnect to it again. */
    let abandoned = false;
    let socket: RealtimeSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let attempt = 0;
    let refreshInFlight = false;
    let refreshAgain = false;
    /**
     * The highest event sequence this hook has applied, kept apart for the
     * two things it decides. The snapshot fence orders whole reads of the
     * agent against each other: two refreshes can resolve out of order and
     * an older one must not overwrite a newer. The stream mark orders the
     * event log against those reads, so a snapshot that a delta has already
     * overtaken cannot roll the narration back to its checkpoint.
     */
    let lastSnapshotSequence = -1;
    let lastStreamSequence = -1;

    const applySnapshot = (next: AutomationAgentSnapshot): void => {
      if (stopped || next.automationId !== automationId) return;
      if (next.eventSequence <= lastSnapshotSequence) return;
      lastSnapshotSequence = next.eventSequence;
      setSnapshot(next);
      if (!next.activeCompilerRun) setNarration('');
      else if (next.eventSequence >= lastStreamSequence) {
        // The checkpoint replays every delta the agent has recorded for this
        // run, so a snapshot at or ahead of the stream is authoritative for
        // the narration. Behind it, the deltas already folded here are newer
        // than anything the read could carry.
        setNarration(next.compilerCheckpoint?.narration ?? '');
      }
      queryClient.setQueryData(['automation-draft', automationId], next);
      const status = summaryStatus(next.lifecycle);
      queryClient.setQueryData<AutomationSummary[]>(['automations'], (current) =>
        current?.map((item) => item.id === automationId
          && (item.name !== next.title || (status !== null && item.status !== status))
          ? { ...item, name: next.title, ...(status === null ? {} : { status }) }
          : item));
    };

    const refresh = async (): Promise<void> => {
      // One read at a time: `refresh` fires on every durable event, and two
      // concurrent GETs can resolve in either order. The sequence fence
      // above drops the loser, and this keeps the second from being sent.
      if (refreshInFlight) {
        refreshAgain = true;
        return;
      }
      refreshInFlight = true;
      try {
        do {
          refreshAgain = false;
          const next = await api.getAutomationAgentDraft(automationId);
          if (stopped) return;
          applySnapshot(next);
        } while (refreshAgain && !stopped);
      } finally {
        refreshInFlight = false;
      }
    };

    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (pongTimer !== null) window.clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
    };

    const clearStability = (): void => {
      if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
      stabilityTimer = null;
    };

    const scheduleHeartbeat = (target: RealtimeSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        if (stopped || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        target.send('ping');
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          if (stopped || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
          // A half-open socket — a slept laptop, a dropped NAT binding —
          // otherwise leaves a running compile spinning forever with a
          // disabled composer and nothing on screen naming the network.
          target.close();
        }, PONG_TIMEOUT_MS);
      }, heartbeatDelay());
    };

    const scheduleReconnect = (): void => {
      if (stopped || abandoned || reconnectTimer !== null) return;
      if (browserIsOffline()) {
        setState('unavailable');
        return;
      }
      attempt += 1;
      setState('reconnecting');
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, reconnectDelay(attempt));
    };

    const connect = async (): Promise<void> => {
      if (stopped || abandoned) return;
      if (browserIsOffline()) {
        setState('unavailable');
        return;
      }
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING || socket?.readyState === REALTIME_SOCKET_OPEN) return;
      try {
        const ticket = await api.getAutomationAgentSocketTicket(automationId);
        if (stopped || abandoned) return;
        const next = createRealtimeSocket('automation_agent', ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          setState('connected');
          clearStability();
          stabilityTimer = window.setTimeout(() => {
            stabilityTimer = null;
            if (stopped || socket !== next || next.readyState !== REALTIME_SOCKET_OPEN) return;
            attempt = 0;
          }, STABLE_CONNECTION_MS);
          scheduleHeartbeat(next);
        });
        next.addEventListener('message', (event) => {
          if (stopped || socket !== next) return;
          if (String(event.data) === 'pong') {
            scheduleHeartbeat(next);
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(String(event.data));
          } catch {
            // Ignored, never closed: closing here mints a fresh ticket and
            // reconnects on every malformed frame, and the next snapshot is
            // authoritative anyway. `use-workstream-socket.ts` does the same.
            return;
          }
          if (!raw || typeof raw !== 'object') return;
          const type = (raw as { type?: unknown }).type;
          if (type === 'snapshot') {
            const parsed = AutomationAgentSnapshotSchema.safeParse((raw as { snapshot?: unknown }).snapshot);
            if (!parsed.success) return;
            if (parsed.data.automationId !== automationId) {
              // The one frame worth closing over: this socket is serving
              // another automation, so no snapshot it sends can be applied
              // and retrying the same ticket would only serve it again.
              abandoned = true;
              setState('unavailable');
              next.close();
              return;
            }
            applySnapshot(parsed.data);
            return;
          }
          if (type !== 'event') return;
          const envelope = raw as { eventSequence?: unknown; eventType?: unknown; payload?: unknown };
          // The agent's own sequence, never a counter minted here: a local
          // one restarts with the effect while the events it is numbering do
          // not, which replayed one draft's narration into the next and
          // then dropped the new one's deltas until it caught up.
          const eventSequence = typeof envelope.eventSequence === 'number' ? envelope.eventSequence : null;
          if (eventSequence === null) return;
          if (envelope.eventType === 'compiler_stream') {
            if (eventSequence <= lastStreamSequence) return;
            const payload = envelope.payload as { event?: unknown } | null;
            const parsed = AutomationDraftStreamEventSchema.safeParse(payload?.event);
            if (!parsed.success) return;
            lastStreamSequence = eventSequence;
            const streamed = parsed.data;
            if (streamed.type === 'started') {
              setNarration('');
              return;
            }
            if (streamed.type === 'delta') {
              setNarration((current) => streamed.reset ? streamed.delta : current + streamed.delta);
              return;
            }
            if (streamed.type === 'thinking' || streamed.type === 'tool') {
              setStreamEvents((current) => [...current, { sequence: eventSequence, event: streamed }]);
            }
            return;
          }
          void refresh().catch(() => undefined);
        });
        next.addEventListener('close', () => {
          // Every listener opens with this: a close delivered for a socket
          // this loop has already replaced would otherwise flip a live
          // connection to disconnected and schedule a second reconnect.
          if (socket !== next) return;
          socket = null;
          clearHeartbeat();
          clearStability();
          if (stopped || abandoned) return;
          setState(browserIsOffline() ? 'unavailable' : 'reconnecting');
          scheduleReconnect();
        });
        next.addEventListener('error', () => {
          if (stopped || socket !== next) return;
          next.close();
        });
      } catch {
        if (stopped || abandoned) return;
        scheduleReconnect();
      }
    };
    const online = (): void => void connect();
    const offline = (): void => {
      setState('unavailable');
      socket?.close();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void refresh().catch(() => undefined);
    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearHeartbeat();
      clearStability();
      socket?.close();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [api, automationId, queryClient]);

  return { snapshot, narration, streamEvents, connected: state === 'connected', state };
}
