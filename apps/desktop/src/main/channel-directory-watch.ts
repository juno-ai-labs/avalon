import {
  safeParseSocketEvent,
  WorkspaceAccessRequestsEventSchema,
  WorkspaceSocketSyncEventSchema,
  type ConversationAccessRequestItem,
  WorkspaceSpaceChannelsEventSchema,
  WorkspaceSpaceSnapshotEventSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamRecencyEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  type Workstream,
  type WorkstreamStateVersion,
} from '@rally/contracts';
import type { WorkspaceSocketConnection, WorkspaceSocketWatchDependencies } from '@rally/contracts/workspace-reach-watch';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';
import type { AttentionChannel, Breakout, BreakoutLists } from '../common/attention-items';

/**
 * One Channel row as the main process keeps it: the fields the menu bar reads,
 * and nothing it does not, so the process holds no transcript previews or
 * participant lists for a menu that never draws them.
 */
export interface DirectoryChannel extends AttentionChannel {
  readonly title: string;
  readonly titleStatus: Workstream['titleStatus'];
  readonly breakoutAttentionCount?: number;
}

/** What the watch hands its host: the Channels, their Breakouts, and whether the list is whole. */
export interface ChannelDirectorySnapshot {
  readonly channels: readonly DirectoryChannel[];
  /** Breakout lists by Channel id, as the rows last carried them. */
  readonly breakouts: BreakoutLists;
  /**
   * False until the first walk of every Space has finished on this
   * connection's account. A partial list is real data, but an empty or short
   * attention count drawn from it would say "nothing waiting" when the truth
   * is "not read yet".
   */
  readonly complete: boolean;
  /** Access requests waiting on this person, newest first, as the socket last sent them. */
  readonly accessRequests: readonly ConversationAccessRequestItem[];
}

export const emptyChannelDirectorySnapshot: ChannelDirectorySnapshot = { channels: [], breakouts: {}, complete: false, accessRequests: [] };

/** The transport half: `watchWorkspaceSocket` with the ticket and dialler already bound. */
export type ChannelDirectorySocket = (
  handlers: Pick<WorkspaceSocketWatchDependencies, 'onSubscribed' | 'onMessage' | 'onClosed'>,
) => () => void;

export interface ChannelDirectoryWatchDependencies {
  readonly socket: ChannelDirectorySocket;
  /** Called after any change to the snapshot, coalesced to one call per frame. */
  readonly onChange: () => void;
  readonly requestId: () => string;
  readonly logWarning: (message: string, error: unknown) => void;
}

interface Ledger {
  authorityGeneration: number;
  commonWaterline: number;
  viewerWaterline: number;
  /** False once a tombstone was accepted: the row is gone, but its version still fences stale pages. */
  visible: boolean;
  privateChildrenWaterline: number | null;
}

/** The common half of a row: the Organization's facts about the Channel. */
type CommonFields = Pick<DirectoryChannel, 'title' | 'titleStatus' | 'lastActivityAt' | 'appearance' | 'archivedAt'
  | 'systemKind' | 'breakoutAttentionCount'> & { latestAttentionSequenceNumber: number };
/** The viewer half: this reader's own marks. */
type ViewerFields = Pick<DirectoryChannel, 'unseen' | 'youAreMentioned' | 'mainWithheld'> & {
  readThroughSequenceNumber: number;
  manualUnreadFromSequenceNumber: number | null;
};

interface StoredRow {
  id: string;
  common: CommonFields;
  viewer: ViewerFields;
}

function commonFields(row: Workstream): CommonFields {
  return {
    title: row.title,
    titleStatus: row.titleStatus,
    lastActivityAt: row.lastActivityAt,
    ...(row.appearance ? { appearance: row.appearance } : {}),
    archivedAt: row.archivedAt,
    systemKind: row.systemKind,
    ...(row.breakoutAttentionCount === undefined ? {} : { breakoutAttentionCount: row.breakoutAttentionCount }),
    latestAttentionSequenceNumber: row.latestAttentionSequenceNumber,
  };
}

function viewerFields(row: Workstream): ViewerFields {
  return {
    unseen: row.unseen,
    youAreMentioned: row.youAreMentioned,
    ...(row.mainWithheld ? { mainWithheld: row.mainWithheld } : {}),
    readThroughSequenceNumber: row.readThroughSequenceNumber,
    manualUnreadFromSequenceNumber: row.manualUnreadFromSequenceNumber,
  };
}

/**
 * Unread is derived from both halves, the way the renderer's
 * `withDerivedUnread` derives it, rather than stored: the two halves are
 * versioned apart, and a stored flag taken with one half would disagree with
 * the other.
 */
function hasUnread(row: StoredRow): boolean {
  if (row.viewer.manualUnreadFromSequenceNumber !== null) return true;
  return row.common.latestAttentionSequenceNumber > row.viewer.readThroughSequenceNumber;
}

/**
 * The Organization's Channel list, held by the main process over a workspace
 * socket of its own.
 *
 * The menu bar is the one surface that outlives every window, and its count has
 * to be the sidebar's count. That count is drawn from data only the workspace
 * socket carries — each row's reader marks and each Channel's Breakout list —
 * so a REST read cannot reproduce it, and a renderer is not always there to
 * ask. This holds the same rows the sidebar holds, from the same frames:
 *
 * - the subscribe answer, then a walk of every Space with `space_channels`
 *   (or, for an Organization still opening, the paged directory);
 * - `workspace_workstream_state` and `workspace_workstream_recency` pushes,
 *   ordered by their state version exactly as the renderer orders them;
 * - `workspace_space_snapshot`, which names a Space the walk has not read.
 *
 * Each subscribe starts the walk again, because nothing is replayed across a
 * reconnect: a push missed while the socket was down is only recovered by
 * reading again.
 */
export class ChannelDirectoryWatch {
  private readonly rows = new Map<string, StoredRow>();
  private readonly ledger = new Map<string, Ledger>();
  private readonly breakoutLists = new Map<string, readonly Breakout[]>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly walkedSpaces = new Set<string>();
  private complete = false;
  private accessRequests: readonly ConversationAccessRequestItem[] = [];
  /** Walks of Spaces a snapshot named after the full walk; the list is not whole until they land. */
  private spaceWalksPending = 0;
  /** Channels a push named while the walk ran; see `subscribed`. */
  private pushedDuringWalk: Set<string> | null = null;
  private connection: WorkspaceSocketConnection | null = null;
  private stopSocket: (() => void) | null = null;
  private changeQueued = false;
  private cached: ChannelDirectorySnapshot | null = emptyChannelDirectorySnapshot;

  constructor(private readonly dependencies: ChannelDirectoryWatchDependencies) {}

  /** Opens the socket. A second call while running does nothing. */
  start(): void {
    if (this.stopSocket) return;
    this.stopSocket = this.dependencies.socket({
      onSubscribed: (answer, connection) => { this.subscribed(answer, connection); },
      onMessage: (message, connection) => { this.message(message, connection); },
      onClosed: (connection) => { this.closed(connection); },
    });
  }

  /**
   * Closes the socket and forgets every row, so nothing the previous account
   * could see survives into the next one's menu.
   */
  stop(): void {
    const stop = this.stopSocket;
    this.stopSocket = null;
    stop?.();
    if (this.connection) this.closed(this.connection);
    this.rows.clear();
    this.ledger.clear();
    this.breakoutLists.clear();
    this.walkedSpaces.clear();
    this.complete = false;
    this.accessRequests = [];
    this.spaceWalksPending = 0;
    this.changed();
  }

  running(): boolean {
    return this.stopSocket !== null;
  }

  snapshot(): ChannelDirectorySnapshot {
    if (this.cached) return this.cached;
    const breakouts: Record<string, readonly Breakout[]> = {};
    for (const [id, list] of this.breakoutLists) breakouts[id] = list;
    this.cached = {
      channels: [...this.rows.values()].map((row) => ({
        id: row.id,
        ...row.common,
        ...row.viewer,
        hasUnread: hasUnread(row),
      })),
      breakouts,
      complete: this.complete && this.spaceWalksPending === 0,
      accessRequests: this.accessRequests,
    };
    return this.cached;
  }

  private changed(): void {
    this.cached = null;
    if (this.changeQueued) return;
    this.changeQueued = true;
    // A walk lands a page per frame and a burst of pushes arrives together;
    // the menu is rebuilt once for each rather than once per row.
    queueMicrotask(() => {
      this.changeQueued = false;
      this.dependencies.onChange();
    });
  }

  private subscribed(answer: unknown, connection: WorkspaceSocketConnection): void {
    this.connection = connection;
    const parsed = safeParseSocketEvent(WorkspaceSocketSyncEventSchema, answer);
    const sidebar = parsed.success ? parsed.data.sidebar : undefined;
    if (!sidebar) {
      this.dependencies.logWarning(
        'could not read the subscribe answer for the menu bar',
        parsed.success ? new Error('subscribe_answer_without_sidebar') : new Error(describeZodIssues(parsed.error)),
      );
      return;
    }
    if (parsed.success && parsed.data.accessRequests) this.accessRequests = parsed.data.accessRequests;
    // Loading again, as the sidebar says while it refetches: the rows held
    // stay on screen, but "nothing waiting" waits for this walk to finish.
    this.complete = false;
    this.spaceWalksPending = 0;
    this.changed();
    const before = new Set(this.rows.keys());
    const pushed = new Set<string>();
    const returned = new Set<string>();
    this.walkedSpaces.clear();
    const walk = sidebar.channelsBySpace === true
      ? this.walkSpaces(connection, [
        ...(sidebar.spaces?.active.items ?? []),
        ...(sidebar.spaces?.inactive.items ?? []),
      ].map((space) => space.id), returned)
      : this.walkDirectory(connection, sidebar.workstreams, returned);
    this.pushedDuringWalk = pushed;
    void walk.then(() => {
      if (this.connection !== connection) return;
      this.pushedDuringWalk = null;
      // A row held before the walk that no page returned is gone, or no
      // longer this reader's. One a push named meanwhile is current.
      for (const id of before) {
        if (returned.has(id) || pushed.has(id)) continue;
        this.rows.delete(id);
        this.breakoutLists.delete(id);
      }
      this.complete = true;
      this.changed();
    }, (error: unknown) => {
      if (this.connection !== connection) return;
      this.pushedDuringWalk = null;
      // Leaves the list as read so far and incomplete. The next subscribe —
      // the socket's own reconnect — walks again.
      this.dependencies.logWarning('could not read the channel directory for the menu bar', error);
    });
  }

  private async walkSpaces(connection: WorkspaceSocketConnection, spaceIds: readonly string[], returned: Set<string>): Promise<void> {
    await Promise.all([...new Set(spaceIds)].map((spaceId) => this.walkSpace(connection, spaceId, returned)));
  }

  private async walkSpace(connection: WorkspaceSocketConnection, spaceId: string, returned: Set<string>): Promise<void> {
    if (this.walkedSpaces.has(spaceId)) return;
    this.walkedSpaces.add(spaceId);
    let after: string | null = null;
    do {
      const raw = await this.request(connection, {
        type: 'space_channels',
        spaceId,
        ...(after ? { after } : {}),
        rails: false,
      });
      const page = WorkspaceSpaceChannelsEventSchema.parse(raw);
      this.applyPage(page.items, page.stateVersions, returned);
      after = page.nextAfter;
    } while (after !== null && this.connection === connection);
  }

  /** An Organization still opening, or a guest: the sidebar's first page, then the rest by cursor. */
  private async walkDirectory(
    connection: WorkspaceSocketConnection,
    first: { items: Workstream[]; stateVersions: Array<WorkstreamStateVersion & { workstreamId: string }>; nextCursor: unknown },
    returned: Set<string>,
  ): Promise<void> {
    this.applyPage(first.items, first.stateVersions, returned);
    let cursor = first.nextCursor;
    while (cursor !== null && cursor !== undefined && this.connection === connection) {
      const raw = await this.request(connection, {
        type: 'list_workstreams',
        limit: 250,
        before: cursor,
        includeSystem: false,
      });
      const page = WorkspaceWorkstreamPageEventSchema.parse(raw);
      this.applyPage(page.items, page.stateVersions, returned);
      cursor = page.nextCursor;
    }
  }

  private applyPage(
    items: readonly Workstream[],
    versions: ReadonlyArray<WorkstreamStateVersion & { workstreamId: string }>,
    returned: Set<string>,
  ): void {
    const byId = new Map(versions.map((version) => [version.workstreamId, version]));
    for (const item of items) {
      const version = byId.get(item.id);
      if (!version) continue;
      returned.add(item.id);
      this.apply(item.id, version, item);
    }
    this.changed();
  }

  private request(connection: WorkspaceSocketConnection, command: Record<string, unknown>): Promise<unknown> {
    const requestId = this.dependencies.requestId();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      // No timeout of its own: the socket's heartbeat closes a connection
      // that stops answering, and `closed` rejects everything asked of it.
      if (!connection.send({ ...command, requestId })) {
        this.pending.delete(requestId);
        reject(new Error('workspace_socket_unavailable'));
      }
    });
  }

  private closed(connection: WorkspaceSocketConnection): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.pushedDuringWalk = null;
    for (const entry of this.pending.values()) entry.reject(new Error('workspace_socket_closed'));
    this.pending.clear();
  }

  private message(message: unknown, connection: WorkspaceSocketConnection): void {
    if (this.connection !== connection || typeof message !== 'object' || message === null) return;
    const { type, requestId } = message as { type?: unknown; requestId?: unknown };
    if (typeof requestId === 'string' && this.pending.has(requestId)) {
      const entry = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      entry.resolve(message);
      return;
    }
    if (type === 'workspace_access_requests') {
      const event = safeParseSocketEvent(WorkspaceAccessRequestsEventSchema, message);
      if (!event.success) return this.unreadable(type, event.error);
      this.accessRequests = event.data.requests;
      this.changed();
      return;
    }
    if (type === 'workspace_workstream_state') {
      const event = safeParseSocketEvent(WorkspaceWorkstreamStateEventSchema, message);
      if (!event.success) return this.unreadable(type, event.error);
      this.pushedDuringWalk?.add(event.data.workstreamId);
      this.apply(event.data.workstreamId, event.data.stateVersion, event.data.workstream);
      this.changed();
      return;
    }
    if (type === 'workspace_workstream_recency') {
      const event = safeParseSocketEvent(WorkspaceWorkstreamRecencyEventSchema, message);
      if (!event.success) return this.unreadable(type, event.error);
      this.pushedDuringWalk?.add(event.data.workstream.id);
      this.apply(event.data.workstream.id, event.data.stateVersion, event.data.workstream);
      this.changed();
      return;
    }
    if (type === 'workspace_space_snapshot') {
      const event = safeParseSocketEvent(WorkspaceSpaceSnapshotEventSchema, message);
      if (!event.success) return this.unreadable(type, event.error);
      // A Space this connection has not walked: one created, or one this
      // reader was just given. Its Channels' rows are read the same way.
      const unwalked = [...event.data.spaces.active.items, ...event.data.spaces.inactive.items]
        .map((space) => space.id)
        .filter((spaceId) => !this.walkedSpaces.has(spaceId));
      if (unwalked.length === 0) return;
      // Its Channels may be waiting for the reader, so the list is not whole
      // until they are read.
      this.spaceWalksPending += 1;
      this.changed();
      void this.walkSpaces(connection, unwalked, new Set()).then(() => {
        if (this.connection !== connection) return;
        this.spaceWalksPending -= 1;
        this.changed();
      }, (error: unknown) => {
        // Stays incomplete: the reconnect that follows walks everything again.
        if (this.connection === connection) this.dependencies.logWarning('could not read a new space for the menu bar', error);
      });
    }
  }

  private unreadable(type: string, error: Parameters<typeof describeZodIssues>[0]): void {
    this.dependencies.logWarning(`could not read ${type} for the menu bar`, new Error(describeZodIssues(error)));
  }

  /**
   * Applies one row under its state version, with the renderer's ordering:
   * a superseded authority generation is refused whole, and within one
   * generation each half is taken only when its own waterline has not gone
   * back. A tombstone removes the row when neither half of it is behind.
   */
  private apply(id: string, version: WorkstreamStateVersion, row: Workstream | null): void {
    const current = this.ledger.get(id);
    if (current && version.authorityGeneration < current.authorityGeneration) return;
    const newerGeneration = !current || version.authorityGeneration > current.authorityGeneration;
    const commonApplied = newerGeneration || version.commonWaterline >= current.commonWaterline;
    const viewerApplied = newerGeneration || version.viewerWaterline >= current.viewerWaterline;
    if (!commonApplied && !viewerApplied) return;
    const visible = row !== null;
    const visibilityApplied = commonApplied && viewerApplied;
    const next: Ledger = {
      authorityGeneration: version.authorityGeneration,
      commonWaterline: commonApplied ? version.commonWaterline : current!.commonWaterline,
      viewerWaterline: viewerApplied ? version.viewerWaterline : current!.viewerWaterline,
      visible: visibilityApplied ? visible : current?.visible ?? visible,
      privateChildrenWaterline: newerGeneration ? null : current?.privateChildrenWaterline ?? null,
    };
    this.ledger.set(id, next);
    if (!next.visible) {
      this.rows.delete(id);
      this.breakoutLists.delete(id);
      return;
    }
    if (!row) return;
    const stored = this.rows.get(id);
    this.rows.set(id, {
      id,
      common: commonApplied || !stored ? commonFields(row) : stored.common,
      viewer: viewerApplied || !stored ? viewerFields(row) : stored.viewer,
    });
    // Absent means the row does not say, never that the list is empty.
    if (row.privateChildren !== undefined) {
      const waterline = row.privateChildrenWaterline ?? version.viewerWaterline;
      if (next.privateChildrenWaterline === null || waterline >= next.privateChildrenWaterline) {
        next.privateChildrenWaterline = waterline;
        this.breakoutLists.set(id, row.privateChildren);
      }
    }
  }
}
