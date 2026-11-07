import type { Region, WorkspaceSyncTopic } from '@rally/contracts';
import type { WorkspaceConversationViewEvent } from '@rally/contracts/conversation-view';

/**
 * The Organization-sync relay: what the main window's workspace socket learns,
 * handed on by main to the Settings window so it holds no second socket to
 * the same room. `docs/websocket-architecture.md` owns the mechanism.
 *
 * Main parses what the main window sends (`main/workspace-sync-relay.ts`); that
 * is the one untrusted edge. What main sends on is built from that parse, so
 * the preload checks only the structure its inbox reads.
 *
 * Dependency-free on purpose: the sandboxed preload is a CommonJS bundle with
 * its dependencies externalized, so it cannot load `zod`.
 */
export const WORKSPACE_SYNC_RELAY_IPC_CHANNELS = {
  /** Main window renderer → main (invoke): its socket's state and news. */
  publish: 'workspace-sync:publish',
  /** Settings or Sidekicks renderer → main (invoke): who, if anyone, is publishing now. */
  source: 'workspace-sync:source',
  /** Main → Settings and Sidekicks renderers (send): every relayed event. */
  relayed: 'workspace-sync:relayed',
  conversationView: 'workspace-sync:conversation-view',
} as const;

export type WorkspaceSyncConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

/**
 * Which Organization a socket serves. Workspace UUIDs are unique only within a
 * region, so the two are always compared together.
 */
export interface WorkspaceSyncIdentity {
  region: Region;
  workspaceId: string;
}

export function sameWorkspaceSyncIdentity(
  left: WorkspaceSyncIdentity | null | undefined,
  right: WorkspaceSyncIdentity | null | undefined,
): boolean {
  return Boolean(left && right && left.region === right.region && left.workspaceId === right.workspaceId);
}

/**
 * A name the relay carries beside the sync topics. `usage` is the meter a plan
 * change pushes by value on the socket (`workspace_usage`); the relay carries
 * names, not values, so a window without the socket reads its own meter again.
 * It is not a sync topic, since that enum is the server's and closed, and it
 * holds no waterline of its own.
 */
export type WorkspaceSyncRelayTopic = WorkspaceSyncTopic | 'usage';

/** Topics that moved, and the waterline they moved at. */
export type WorkspaceSyncTopicsEvent = WorkspaceSyncIdentity & {
  type: 'topics';
  waterline: number;
  topics: WorkspaceSyncRelayTopic[];
};

export type WorkspaceSyncPublication =
  | (WorkspaceSyncIdentity & { type: 'state'; state: WorkspaceSyncConnectionState })
  /** The publishing provider unmounted with no successor in its window. */
  | (WorkspaceSyncIdentity & { type: 'detach' })
  | WorkspaceSyncTopicsEvent
  | (WorkspaceSyncIdentity & { type: 'conversation_view_response'; event: WorkspaceConversationViewEvent });

export type WorkspaceConversationViewRelayRequest = WorkspaceSyncIdentity & (
  | { type: 'conversation_view_request'; requestId: string; parentId: string; substreamId: string }
  | { type: 'conversation_view_cancel'; requestId: string }
);

/**
 * The window whose socket is being relayed, or `null` when none is.
 *
 * `revision` orders snapshots: the reply to `source` and a `source` event can
 * cross, and the higher revision is the true one.
 */
export interface WorkspaceSyncSourceSnapshot {
  revision: number;
  source: (WorkspaceSyncIdentity & { state: WorkspaceSyncConnectionState }) | null;
}

export type WorkspaceSyncRelayEvent =
  | ({ type: 'source' } & WorkspaceSyncSourceSnapshot)
  | WorkspaceSyncTopicsEvent
  | WorkspaceConversationViewRelayRequest
  | (WorkspaceSyncIdentity & { type: 'conversation_view_response'; event: WorkspaceConversationViewEvent });

/**
 * The structure the preload's inbox reads, and nothing more. Main built the
 * event from its own parse; this only keeps a malformed one from throwing
 * inside the inbox.
 */
export function isWorkspaceSyncRelayEvent(raw: unknown): raw is WorkspaceSyncRelayEvent {
  if (!raw || typeof raw !== 'object') return false;
  const event = raw as Partial<Record<string, unknown>>;
  if (event['type'] === 'source') return typeof event['revision'] === 'number';
  if (event['type'] === 'conversation_view_response') return typeof event['event'] === 'object' && event['event'] !== null;
  if (event['type'] === 'conversation_view_request' || event['type'] === 'conversation_view_cancel') {
    return typeof event['requestId'] === 'string';
  }
  return event['type'] === 'topics' && typeof event['waterline'] === 'number' && Array.isArray(event['topics']);
}

export interface WorkspaceSyncRelayInbox {
  receive(event: WorkspaceSyncRelayEvent): void;
  subscribe(listener: (event: WorkspaceSyncRelayEvent) => void): () => void;
}

/**
 * The preload's end of the relay: fans each event out to the renderer's
 * listeners, and holds news that arrives while there are none.
 *
 * The settings renderer starts a read or two before the provider that listens
 * has mounted — account onboarding sits above it — and a change landing in
 * that gap must still reach them. What is held is folded rather than queued,
 * which bounds it by the closed topic enum instead of by a count: every topic
 * at most once with the newest waterline, for one Organization. Source events
 * are not held; a listener reads the current source itself, and the revision
 * orders the two.
 *
 * Held news is handed over on a microtask, the way the other latched bridge
 * events are, and is cleared only once a listener that is still subscribed
 * has taken it: StrictMode subscribes, unsubscribes and subscribes again in one
 * synchronous pass, and the first listener must not take it with it.
 */
export function createWorkspaceSyncRelayInbox(): WorkspaceSyncRelayInbox {
  const listeners = new Set<(event: WorkspaceSyncRelayEvent) => void>();
  let held: WorkspaceSyncTopicsEvent | null = null;
  return {
    receive(event) {
      if (listeners.size > 0) {
        for (const listener of listeners) listener(event);
        return;
      }
      if (event.type !== 'topics') return;
      // A different Organization's news is moot: the renderer rebuilds its
      // cache when the session changes Organization.
      const previous = sameWorkspaceSyncIdentity(held, event) ? held : null;
      held = {
        ...event,
        waterline: Math.max(event.waterline, previous?.waterline ?? 0),
        topics: [...new Set([...(previous?.topics ?? []), ...event.topics])],
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (held) {
        queueMicrotask(() => {
          if (!held || !listeners.has(listener)) return;
          const news = held;
          held = null;
          listener(news);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
