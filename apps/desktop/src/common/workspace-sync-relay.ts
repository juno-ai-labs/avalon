import type { ClientFeatureFlags, WorkspaceSyncTopic } from '@rally/contracts';

/**
 * The Organization-sync relay: what the main window's workspace socket learns,
 * handed on by main to the Settings window so that one does not hold a second
 * socket to the same room.
 *
 * Dependency-free on purpose: the sandboxed preload is a CommonJS bundle with
 * its dependencies externalized, so it cannot load `zod`. Main parses with the
 * same functions, so both ends of the hop accept exactly one shape.
 * `docs/websocket-architecture.md` owns the mechanism.
 */
export const WORKSPACE_SYNC_RELAY_IPC_CHANNELS = {
  /** Main window renderer → main (invoke): its socket's state and news. */
  publish: 'workspace-sync:publish',
  /** Settings renderer → main (invoke): who, if anyone, is publishing now. */
  source: 'workspace-sync:source',
  /** Main → Settings renderer (send): every relayed event. */
  relayed: 'workspace-sync:relayed',
} as const;

export type WorkspaceSyncConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export type WorkspaceSyncPublication =
  | { type: 'state'; workspaceId: string; state: WorkspaceSyncConnectionState }
  | { type: 'topics'; workspaceId: string; waterline: number; topics: WorkspaceSyncTopic[] }
  | { type: 'feature_flags'; workspaceId: string; flags: ClientFeatureFlags };

/**
 * The window whose socket is being relayed, or `null` when none is.
 *
 * `revision` orders snapshots: the reply to `source` and a `source` event can
 * cross, and the higher revision is the true one.
 */
export interface WorkspaceSyncSourceSnapshot {
  revision: number;
  source: { workspaceId: string; state: WorkspaceSyncConnectionState } | null;
}

export type WorkspaceSyncRelayEvent =
  | ({ type: 'source' } & WorkspaceSyncSourceSnapshot)
  | Exclude<WorkspaceSyncPublication, { type: 'state' }>;

export type WorkspaceSyncParseResult<T> = { ok: true; value: T } | { ok: false; field: string };

const CONNECTION_STATES = {
  connecting: true,
  connected: true,
  reconnecting: true,
  unavailable: true,
} satisfies Record<WorkspaceSyncConnectionState, true>;

const SYNC_TOPICS = {
  workspace_profile: true,
  member_directory: true,
  invitation_directory: true,
  connector_connections: true,
  connector_oauth_attempts: true,
  terminal_policy: true,
  digest_schedule: true,
  automations: true,
  notes: true,
  projects: true,
  resources: true,
  activity: true,
  work_opportunities: true,
  workstream_directory: true,
  viewer_preferences: true,
  feature_flags: true,
} satisfies Record<WorkspaceSyncTopic, true>;

const FEATURE_FLAG_KEYS = {
  developerSettings: true,
  suggestedWorkEnabled: true,
  multipleWorkspacesEnabled: true,
  liveArtifactsEnabled: true,
  digestsEnabled: true,
  pushNotificationsEnabled: true,
} satisfies Record<keyof ClientFeatureFlags, true>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Fields = Record<string, unknown>;

function hasExactly(value: Fields, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function reject<T>(field: string): WorkspaceSyncParseResult<T> {
  return { ok: false, field };
}

function isConnectionState(value: unknown): value is WorkspaceSyncConnectionState {
  return typeof value === 'string' && Object.hasOwn(CONNECTION_STATES, value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseTopics(value: unknown): WorkspaceSyncTopic[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const topics: WorkspaceSyncTopic[] = [];
  for (const topic of value) {
    if (typeof topic !== 'string' || !Object.hasOwn(SYNC_TOPICS, topic)) return null;
    topics.push(topic as WorkspaceSyncTopic);
  }
  return topics;
}

function parseFlags(value: unknown): ClientFeatureFlags | null {
  if (!value || typeof value !== 'object') return null;
  const flags = value as Fields;
  const keys = Object.keys(FEATURE_FLAG_KEYS);
  if (!hasExactly(flags, keys) || keys.some((key) => typeof flags[key] !== 'boolean')) return null;
  return { ...flags } as ClientFeatureFlags;
}

/** The events that carry news about one Organization, shared by both hops. */
function parseNews(
  value: Fields,
): WorkspaceSyncParseResult<Exclude<WorkspaceSyncPublication, { type: 'state' }>> | null {
  if (value['type'] === 'topics') {
    if (!hasExactly(value, ['type', 'workspaceId', 'waterline', 'topics'])) return reject('topics');
    if (!isRevision(value['waterline'])) return reject('waterline');
    const topics = parseTopics(value['topics']);
    if (!topics) return reject('topics');
    return {
      ok: true,
      value: { type: 'topics', workspaceId: value['workspaceId'] as string, waterline: value['waterline'], topics },
    };
  }
  if (value['type'] === 'feature_flags') {
    if (!hasExactly(value, ['type', 'workspaceId', 'flags'])) return reject('feature_flags');
    const flags = parseFlags(value['flags']);
    if (!flags) return reject('flags');
    return { ok: true, value: { type: 'feature_flags', workspaceId: value['workspaceId'] as string, flags } };
  }
  return null;
}

/** What main accepts from the main window. A failure names the field it rejected. */
export function parseWorkspaceSyncPublication(raw: unknown): WorkspaceSyncParseResult<WorkspaceSyncPublication> {
  if (!raw || typeof raw !== 'object') return reject('(publication)');
  const value = raw as Fields;
  if (typeof value['workspaceId'] !== 'string' || !UUID_PATTERN.test(value['workspaceId'])) {
    return reject('workspaceId');
  }
  if (value['type'] === 'state') {
    if (!hasExactly(value, ['type', 'workspaceId', 'state'])) return reject('state');
    if (!isConnectionState(value['state'])) return reject('state');
    return { ok: true, value: { type: 'state', workspaceId: value['workspaceId'], state: value['state'] } };
  }
  return parseNews(value) ?? reject('type');
}

export function parseWorkspaceSyncSourceSnapshot(raw: unknown): WorkspaceSyncSourceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Fields;
  if (!isRevision(value['revision'])) return null;
  const source = value['source'];
  if (source === null) return { revision: value['revision'], source: null };
  if (!source || typeof source !== 'object') return null;
  const candidate = source as Fields;
  if (!hasExactly(candidate, ['workspaceId', 'state'])
    || typeof candidate['workspaceId'] !== 'string' || !UUID_PATTERN.test(candidate['workspaceId'])
    || !isConnectionState(candidate['state'])) return null;
  return {
    revision: value['revision'],
    source: { workspaceId: candidate['workspaceId'], state: candidate['state'] },
  };
}

/** What the preload accepts from main before any renderer listener sees it. */
export function parseWorkspaceSyncRelayEvent(raw: unknown): WorkspaceSyncRelayEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Fields;
  if (value['type'] === 'source') {
    if (!hasExactly(value, ['type', 'revision', 'source'])) return null;
    const snapshot = parseWorkspaceSyncSourceSnapshot({ revision: value['revision'], source: value['source'] });
    return snapshot ? { type: 'source', ...snapshot } : null;
  }
  if (typeof value['workspaceId'] !== 'string' || !UUID_PATTERN.test(value['workspaceId'])) return null;
  const news = parseNews(value);
  return news?.ok ? news.value : null;
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
 * at most once with the newest waterline, and the newest flags. Source events
 * are not held; a listener reads the current source itself, and the revision
 * orders the two.
 *
 * Held news is handed to the first listener on a microtask, the way the other
 * latched bridge events are, and no IPC event can be delivered before it.
 */
export function createWorkspaceSyncRelayInbox(): WorkspaceSyncRelayInbox {
  const listeners = new Set<(event: WorkspaceSyncRelayEvent) => void>();
  let heldTopics: Extract<WorkspaceSyncRelayEvent, { type: 'topics' }> | null = null;
  let heldFlags: Extract<WorkspaceSyncRelayEvent, { type: 'feature_flags' }> | null = null;
  return {
    receive(event) {
      if (listeners.size > 0) {
        for (const listener of listeners) listener(event);
        return;
      }
      if (event.type === 'feature_flags') {
        heldFlags = event;
      } else if (event.type === 'topics') {
        // A different Organization's news is moot: the renderer rebuilds its
        // cache when the session changes Organization.
        const held = heldTopics?.workspaceId === event.workspaceId ? heldTopics : null;
        heldTopics = {
          ...event,
          waterline: Math.max(event.waterline, held?.waterline ?? 0),
          topics: [...new Set([...(held?.topics ?? []), ...event.topics])],
        };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      const held = [heldTopics, heldFlags].filter((event) => event !== null);
      heldTopics = null;
      heldFlags = null;
      if (held.length > 0) {
        queueMicrotask(() => {
          if (!listeners.has(listener)) return;
          for (const event of held) listener(event);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
