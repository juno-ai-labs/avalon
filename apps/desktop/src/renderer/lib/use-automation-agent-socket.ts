import {
  AutomationAgentSnapshotSchema,
  AutomationDraftStreamEventSchema,
  type AutomationAgentSnapshot,
  type AutomationDraftStreamEvent,
} from '@rally/contracts';
import { useEffect, useState } from 'react';
import type { RallyApi } from './api';
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

interface AutomationAgentSocketState {
  snapshot: AutomationAgentSnapshot | null;
  streamEvents: Array<{ sequence: number; event: AutomationDraftStreamEvent }>;
  connected: boolean;
}

/**
 * Reattaches the draft UI to AutomationAgent's durable snapshot/event log.
 * Stream deltas are applied locally; durable state-changing events trigger one
 * authoritative snapshot read instead of a polling loop.
 */
export function useAutomationAgentSocket(
  api: AutomationSocketApi | null,
  automationId: string | null,
): AutomationAgentSocketState {
  const [snapshot, setSnapshot] = useState<AutomationAgentSnapshot | null>(null);
  const [streamEvents, setStreamEvents] = useState<Array<{ sequence: number; event: AutomationDraftStreamEvent }>>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!api || !automationId) {
      setSnapshot(null);
      setStreamEvents([]);
      setConnected(false);
      return;
    }
    let stopped = false;
    let socket: RealtimeSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempt = 0;
    let streamSequence = 0;

    const refresh = async (): Promise<void> => {
      const next = await api.getAutomationAgentDraft(automationId);
      if (!stopped && next.automationId === automationId) setSnapshot(next);
    };
    const scheduleReconnect = (): void => {
      if (stopped || reconnectTimer !== null || navigator.onLine === false) return;
      const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
      const delay = Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };
    const connect = async (): Promise<void> => {
      if (stopped || navigator.onLine === false) return;
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING || socket?.readyState === REALTIME_SOCKET_OPEN) return;
      try {
        const ticket = await api.getAutomationAgentSocketTicket(automationId);
        if (stopped) return;
        const next = createRealtimeSocket('automation_agent', ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          attempt = 0;
          setConnected(true);
        });
        next.addEventListener('message', (event) => {
          if (stopped || socket !== next || event.data === 'pong') return;
          let raw: unknown;
          try {
            raw = JSON.parse(event.data);
          } catch {
            next.close();
            return;
          }
          if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'snapshot') {
            const parsed = AutomationAgentSnapshotSchema.safeParse((raw as { snapshot?: unknown }).snapshot);
            if (!parsed.success || parsed.data.automationId !== automationId) {
              next.close();
              return;
            }
            setSnapshot(parsed.data);
            return;
          }
          if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'event') return;
          const envelope = raw as { eventType?: unknown; payload?: unknown };
          if (envelope.eventType === 'compiler_stream') {
            const payload = envelope.payload as { event?: unknown } | null;
            const parsed = AutomationDraftStreamEventSchema.safeParse(payload?.event);
            if (parsed.success && parsed.data.type !== 'completed' && parsed.data.type !== 'error') {
              streamSequence += 1;
              setStreamEvents((current) => [...current, { sequence: streamSequence, event: parsed.data }]);
            }
            return;
          }
          void refresh().catch(() => undefined);
        });
        next.addEventListener('close', () => {
          if (socket === next) socket = null;
          setConnected(false);
          scheduleReconnect();
        });
        next.addEventListener('error', () => next.close());
      } catch {
        scheduleReconnect();
      }
    };
    const online = (): void => void connect();
    const offline = (): void => socket?.close();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void refresh().catch(() => undefined);
    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [api, automationId]);

  return { snapshot, streamEvents, connected };
}
