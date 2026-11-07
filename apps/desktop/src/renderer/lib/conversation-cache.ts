import { WorkstreamTranscriptSnapshotSchema, type WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { SubstreamInitialContextSchema, type SubstreamInitialContext } from '@rally/contracts/substream-creation';
import { notifyManager, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { mirrorQueriesToLocalCache, queryKeyIsOneOf, type QueryMirror } from './local-cache-mirror';
import type { WorkstreamFeedSource } from './telemetry';
import { activitiesForTurns, mergeCanonicalTranscriptSnapshot, openingTranscriptSnapshot } from './transcript';
import type { WorkstreamDetail } from './types';
import { projectConversationView, type WorkspaceConversationViewEvent } from '@rally/contracts/conversation-view';
import { normalizeHarnessStatus } from './api';

/**
 * One conversation's last canonical state, kept so its screen paints before
 * the feed socket answers: the detail the header and composer read, the
 * transcript trimmed to its opening ranges, and — for a private child — the
 * context it inherited, which the child's send readiness also waits on.
 *
 * Written only from state the socket delivered, never from a seed or an
 * optimistic launch, and read only into caches that are still empty. The
 * feed-source marker is what says which is which; see `hydrateConversation`.
 */
export interface CachedConversation {
  detail: WorkstreamDetail;
  transcript: WorkstreamTranscriptSnapshot;
  initialContext: SubstreamInitialContext | null;
  /** When the socket last said this, for a reader looking at the row in DevTools. */
  cachedAt: string;
}

/** The query-cache entries one conversation is read from and written to; the socket hook owns the keys. */
export interface ConversationCacheKeys {
  detail: readonly unknown[];
  transcript: readonly unknown[];
  initialContext: readonly unknown[];
  feedSource: readonly unknown[];
}

/** The feed-source lineage a hydrated seed carries, until a live frame replaces it. */
export const LOCAL_CACHE_FEED_SOURCE = 'local_cache' satisfies WorkstreamFeedSource;
/** The only lineage the mirror will persist: state the admitted socket delivered. */
const LIVE_FEED_SOURCE = 'socket_snapshot' satisfies WorkstreamFeedSource;

/**
 * What a seeded row's detail must hold for the screens that paint from it.
 *
 * The query cache holds the renderer's mapped `WorkstreamDetail`, not the wire
 * detail the contracts have a schema for, so the row is validated here, down
 * to the fields the header, the composer, the rail, and the run notices read
 * from each nested item. Fields the schema does not name pass through as they
 * were. A shape change the schema cannot tell apart still needs
 * `conversationSlice.version` bumped; a change it can tell apart is refused at
 * read time and the screen waits for its socket as it did before the cache.
 */
const CachedWorkstreamDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleStatus: z.enum(['naming', 'automatic', 'settled']),
  harnessStatus: z.string(),
  scope: z.enum(['personal', 'workspace']),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  latestAttentionSequenceNumber: z.number(),
  readThroughSequenceNumber: z.number(),
  manualUnreadGeneration: z.number(),
  participantUserIds: z.array(z.string()),
  participants: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() }).passthrough()),
  viewers: z.array(z.object({ id: z.string() }).passthrough()),
  resources: z.array(z.object({ id: z.string(), title: z.string(), resourceType: z.string() }).passthrough()),
  connections: z.array(z.object({ id: z.string(), displayName: z.string(), status: z.string() }).passthrough()),
  backgroundTasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), startedAt: z.string() }).passthrough()),
  latestHarnessRun: z.object({ id: z.string(), status: z.string(), createdAt: z.string() }).passthrough().optional(),
}).passthrough();

function parseCachedWorkstreamDetail(value: unknown): WorkstreamDetail | null {
  // The schema vouches for the shape; the value itself, with every field the
  // schema passed through untouched, is what the query cache gets.
  return CachedWorkstreamDetailSchema.safeParse(value).success ? value as WorkstreamDetail : null;
}

function parseCachedConversation(value: unknown): CachedConversation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const detail = parseCachedWorkstreamDetail(candidate['detail']);
  if (!detail) return null;
  const transcript = WorkstreamTranscriptSnapshotSchema.safeParse(candidate['transcript']);
  if (!transcript.success) return null;
  const context = candidate['initialContext'] === null || candidate['initialContext'] === undefined
    ? { success: true as const, data: null }
    : SubstreamInitialContextSchema.safeParse(candidate['initialContext']);
  if (!context.success) return null;
  return {
    detail,
    transcript: transcript.data,
    initialContext: context.data,
    cachedAt: typeof candidate['cachedAt'] === 'string' ? candidate['cachedAt'] : '',
  };
}

export const conversationSlice = defineLocalCacheSlice<CachedConversation>({
  kind: 'conversation',
  version: 1,
  parse: parseCachedConversation,
});

/** The slice's key for one conversation; its subject is the parent, so a parent's children go with it. */
export function conversationCacheKey(parentId: string, substreamId: string): string {
  return `${parentId}:${substreamId}`;
}

function substreamIdOfKey(key: string, parentId: string): string | null {
  return key.startsWith(`${parentId}:`) ? key.slice(parentId.length + 1) : null;
}

/**
 * Put the cached conversation into empty query caches, marked as a seed.
 *
 * Returns what happened, for the caller that wants to know rather than for any
 * decision here: `seeded` painted something, `skipped` found either live data
 * already in place or a caller that no longer wants it, `missing` found no row.
 * The three caches and the marker are written in one notification batch, so a
 * screen that needs the detail *and* the transcript never renders a frame with
 * only one of them.
 */
export async function hydrateConversation(
  queryClient: QueryClient,
  scope: string,
  parentId: string,
  substreamId: string,
  keys: ConversationCacheKeys,
  stillWanted: () => boolean,
): Promise<'seeded' | 'skipped' | 'missing'> {
  const epoch = localCacheEpoch();
  const cached = await conversationSlice.read(scope, conversationCacheKey(parentId, substreamId));
  if (!cached) return 'missing';
  if (!stillWanted() || cached.detail.id !== parentId) return 'skipped';
  // A wipe that began while the row was in flight is taking it off the disk;
  // a row on its way out is not a seed.
  if (localCacheEpoch() !== epoch) return 'skipped';
  // Whatever is there already is newer than a seed: a live snapshot that
  // landed while this read was in flight, or the optimistic turn a launch
  // surface wrote before navigating here.
  if (queryClient.getQueryData(keys.detail) !== undefined
    || queryClient.getQueryData(keys.transcript) !== undefined) return 'skipped';
  notifyManager.batch(() => {
    queryClient.setQueryData(keys.feedSource, LOCAL_CACHE_FEED_SOURCE);
    queryClient.setQueryData(keys.detail, cached.detail);
    queryClient.setQueryData(keys.transcript, cached.transcript);
    if (substreamId !== '0') queryClient.setQueryData(keys.initialContext, cached.initialContext);
  });
  return 'seeded';
}

/** Whether the caches under these keys hold a hydrated seed rather than what the socket said. */
export function conversationSeededFromLocalCache(queryClient: QueryClient, keys: ConversationCacheKeys): boolean {
  return queryClient.getQueryData(keys.feedSource) === LOCAL_CACHE_FEED_SOURCE;
}

/** Workspace display data has exactly the same read-only status as a disk seed. */
export function seedWorkspaceConversation(
  queryClient: QueryClient,
  event: WorkspaceConversationViewEvent,
  keys: ConversationCacheKeys,
): boolean {
  // A header-only delivery must not win the race against a useful disk row.
  if (!event.view || !event.view.transcript.ranges.some((range) => range.turns.length > 0)) return false;
  const residentDetail = queryClient.getQueryData<WorkstreamDetail>(keys.detail);
  const residentTranscript = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript);
  // A preview can refresh a disk seed, but never a live or optimistic feed.
  if ((residentDetail !== undefined || residentTranscript !== undefined)
    && !conversationSeededFromLocalCache(queryClient, keys)) return false;
  const { header, transcript } = event.view;
  if (residentTranscript) {
    // Compare visible content with visible content: the disk also contains
    // mailbox and tool-only turns the projection deliberately omits.
    const held = new Map([...residentTranscript.ranges.flatMap((range) => range.turns), ...residentTranscript.activeTurns]
      .map((turn) => [turn.turnId, turn]));
    const visibleHeld = [...held.values()].filter((turn) => projectConversationView({
      purpose: 'requested',
      requested: { startInclusive: turn.transcriptSequence, endExclusive: turn.transcriptSequence + 1 },
      covered: { startInclusive: turn.transcriptSequence, endExclusive: turn.transcriptSequence + 1 },
      turns: [turn], activities: [],
      pluginRuns: residentTranscript.pluginRuns.filter((run) => run.turnId === turn.turnId),
    }) !== null);
    if (visibleHeld.some((turn) => turn.transcriptSequence > transcript.snapshotThrough)) return false;
    const incoming = transcript.ranges.flatMap((range) => range.turns);
    const incomingIds = new Set(incoming.map((turn) => turn.turnId));
    if (visibleHeld.some((turn) => !incomingIds.has(turn.turnId)
      && transcript.ranges.some((range) => turn.transcriptSequence >= range.covered.startInclusive
        && turn.transcriptSequence < range.covered.endExclusive))) return false;
    if (incoming.some((turn) => turn.revision < (held.get(turn.turnId)?.revision ?? 0))) return false;
    if (!incoming.some((turn) => turn.revision > (held.get(turn.turnId)?.revision ?? 0))) return false;
  }
  const detail: WorkstreamDetail = {
    ...(residentDetail ?? {
      id: event.parentId, lastActivityAt: header.updatedAt,
      latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
      manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false,
      firstUnreadSequenceNumber: null, participantUserIds: [], participantExtraCount: 0,
      nextPendingWakeup: null, pinPosition: null,
      participants: [], viewers: [], resources: [], connections: [], backgroundTasks: [],
    }),
    ...header, harnessStatus: normalizeHarnessStatus(header.harnessStatus),
  };
  notifyManager.batch(() => {
    queryClient.setQueryData(keys.feedSource, LOCAL_CACHE_FEED_SOURCE);
    queryClient.setQueryData(keys.detail, detail);
    queryClient.setQueryData(keys.transcript, residentTranscript
      ? mergeConversationPreview(residentTranscript, transcript) : transcript);
  });
  return true;
}

/** Add compact display updates without treating omitted data as deletions. */
function mergeConversationPreview(
  current: WorkstreamTranscriptSnapshot,
  incoming: WorkstreamTranscriptSnapshot,
): WorkstreamTranscriptSnapshot {
  const held = new Map([...current.ranges.flatMap((range) => range.turns), ...current.activeTurns]
    .map((turn) => [turn.turnId, turn]));
  const updates = new Map(incoming.ranges.flatMap((range) => range.turns)
    .filter((turn) => turn.revision > (held.get(turn.turnId)?.revision ?? 0))
    .map((turn) => [turn.turnId, turn]));
  const activities = new Map(current.activities.map((activity) => [activity.activityId, activity]));
  for (const activity of incoming.activities) {
    if (activity.revision > (activities.get(activity.activityId)?.revision ?? 0)) activities.set(activity.activityId, activity);
  }
  const mergedActivities = [...activities.values()];
  const pluginRuns = new Map(current.pluginRuns.map((run) => [run.pluginRunId, run]));
  for (const run of incoming.pluginRuns) {
    if (updates.has(run.turnId) || !pluginRuns.has(run.pluginRunId)) pluginRuns.set(run.pluginRunId, run);
  }
  const mergedRuns = [...pluginRuns.values()];
  const snapshotThrough = Math.max(current.snapshotThrough, incoming.snapshotThrough);
  const ranges = incoming.ranges.map((range) => {
    const turns = new Map(range.turns.map((turn) => [turn.turnId, updates.get(turn.turnId) ?? held.get(turn.turnId) ?? turn]));
    // The projection's coverage spans intentionally hidden turns too. Keep
    // those, and equal-revision full turns, with their rendering metadata.
    for (const turn of held.values()) {
      if (!turns.has(turn.turnId) && turn.transcriptSequence >= range.covered.startInclusive
        && turn.transcriptSequence < range.covered.endExclusive) turns.set(turn.turnId, turn);
    }
    return { ...range, turns: [...turns.values()].sort((a, b) => a.transcriptSequence - b.transcriptSequence) };
  });
  // Reuse interval subtraction, not the canonical snapshot's deletion rules.
  // All snapshot-level state stays a read-only memory until the live frame.
  const merged = mergeCanonicalTranscriptSnapshot(current, { ...incoming, snapshotThrough, ranges });
  return {
    ...current,
    snapshotThrough,
    ranges: merged.ranges.map((range) => {
      const turnIds = new Set(range.turns.map((turn) => turn.turnId));
      return { ...range, activities: activitiesForTurns(mergedActivities, range.turns),
        pluginRuns: mergedRuns.filter((run) => turnIds.has(run.turnId)) };
    }),
    activities: mergedActivities,
    activeActivities: mergedActivities.filter((activity) => activity.state === 'active'),
    pluginRuns: mergedRuns,
    activeTurns: current.activeTurns.map((turn) => updates.get(turn.turnId) ?? turn),
  };
}

/**
 * Keep the conversation's row equal to its live caches for as long as the
 * caller holds the mirror. Only state the socket delivered is written: a seed,
 * an optimistic launch, and a cache the socket has not yet installed all read
 * as nothing to persist.
 */
export function mirrorConversation(
  queryClient: QueryClient,
  scope: string,
  parentId: string,
  substreamId: string,
  keys: ConversationCacheKeys,
): QueryMirror {
  const key = conversationCacheKey(parentId, substreamId);
  return mirrorQueriesToLocalCache<CachedConversation>(queryClient, {
    matches: queryKeyIsOneOf([keys.detail, keys.transcript, keys.initialContext]),
    snapshot: () => {
      if (queryClient.getQueryData(keys.feedSource) !== LIVE_FEED_SOURCE) return null;
      const detail = queryClient.getQueryData<WorkstreamDetail>(keys.detail);
      const transcript = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript);
      if (!detail || detail.id !== parentId || !transcript) return null;
      const initialContext = substreamId === '0'
        ? null
        : queryClient.getQueryData<SubstreamInitialContext | null>(keys.initialContext);
      // A child's context arrives in chunks after its snapshot; until the last
      // one lands the cache is deliberately empty, and a row without it would
      // seed a child that can never become send-ready from the seed alone.
      if (substreamId !== '0' && initialContext === undefined) return null;
      return {
        // Presence is a live fact about other people's windows, never a
        // memory: the surface recomputes it from WorkspaceDO on every render.
        detail: { ...detail, viewers: [] },
        transcript: openingTranscriptSnapshot(transcript),
        initialContext: initialContext ?? null,
        cachedAt: new Date().toISOString(),
      };
    },
    write: (value, atEpoch) => conversationSlice.write(scope, key, value, parentId, atEpoch),
  });
}

/** Drop every cached conversation under a parent, in every scope: the parent is gone or off limits. */
export function forgetConversationParent(parentId: string): void {
  void conversationSlice.removeSubject(parentId);
}

/** Drop one cached child, in every scope. */
export function forgetConversation(parentId: string, substreamId: string): void {
  void conversationSlice.removeKey(conversationCacheKey(parentId, substreamId));
}

/**
 * Keep only the conversations whose parent the directory still lists.
 *
 * The bound on this cache is membership, not a number: a row exists for as
 * long as its parent is a row in the sidebar, and leaves when the parent does.
 * Returns the keys it removed, which is what a test asserts on.
 */
export async function retainConversationParents(scope: string, keep: ReadonlySet<string>): Promise<string[]> {
  const entries = await conversationSlice.entries(scope);
  const removed = entries.filter((entry) => !keep.has(entry.subject));
  await Promise.all(removed.map((entry) => conversationSlice.remove(scope, entry.key)));
  return removed.map((entry) => entry.key);
}

/** Keep only the children of one parent that its control socket still lists; the main conversation always stays. */
export async function retainConversationChildren(
  scope: string,
  parentId: string,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await conversationSlice.entriesForSubject(scope, parentId);
  const removed = entries.filter((entry) => {
    const substreamId = substreamIdOfKey(entry.key, parentId);
    return substreamId !== null && substreamId !== '0' && !keep.has(substreamId);
  });
  await Promise.all(removed.map((entry) => conversationSlice.remove(scope, entry.key)));
  return removed.map((entry) => entry.key);
}
