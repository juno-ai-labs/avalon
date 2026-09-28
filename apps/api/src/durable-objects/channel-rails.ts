/**
 * A Channel's rail, as the Organization socket delivers it: Main's
 * participants, the Sidekicks the rail lists, and Main's attached resources.
 *
 * Everything here is a set read over `json_each` against WorkspaceDO's own
 * SQLite, with no network, so one answer is one consistent snapshot. The
 * visibility rule is the Channel row's and nothing else: a Channel the viewer
 * could not be sent a row for is `unavailable`, never a second authorization
 * path. `docs/hosted-conversation-parents.md` owns the projection and its
 * `rail_waterline`; `docs/realtime-sockets.md` owns the `channel_rails` frame.
 */

import {
  resourceDirectionForRelationship,
  ResourceRelationshipTypeSchema,
  WorkstreamAppearanceSchema,
  type AutomationSummary,
  type ChannelRail,
  type ChannelRailResource,
  type SidekickAttachment,
  type WorkspaceChannelRailsEvent,
  type WorkstreamAutomationSummary,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";

import { listedResourceVisibilitySql } from "../services/resource-listing";
import { channelVisibleToViewerSql } from "./workspace-space-storage";

type Sql = SqlStorage;

export interface AutomationDirectoryRow extends Record<string, SqlStorageValue> {
  loadable: number | null;
  appearance_json: string | null;
  automation_id: string;
  lifecycle: "draft" | "active" | "paused";
  scope: "personal" | "workspace" | "workstream";
  owning_workstream_id: string | null;
  title: string;
  description: string;
  next_run_at: number | null;
  projected_at: number;
}

export function automationSummary(row: AutomationDirectoryRow): AutomationSummary {
  return {
    id: row.automation_id,
    loadable: row.loadable === 1,
    ...(row.appearance_json
      ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) }
      : {}),
    name: row.title || "New Sidekick",
    description: row.description,
    emailAddress: null,
    scope: row.scope,
    owningWorkstreamId: row.owning_workstream_id,
    status: row.lifecycle,
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
    lastRunAt: null,
    updatedAt: new Date(row.projected_at).toISOString(),
  };
}

/** A room's automation as its own rail lists it: the summary without scope and owner. */
function workstreamAutomationSummary(row: AutomationDirectoryRow): WorkstreamAutomationSummary {
  const summary = automationSummary(row);
  return {
    id: summary.id,
    loadable: summary.loadable,
    ...(summary.appearance ? { appearance: summary.appearance } : {}),
    name: summary.name,
    description: summary.description,
    emailAddress: summary.emailAddress,
    status: summary.status,
    nextRunAt: summary.nextRunAt,
    lastRunAt: summary.lastRunAt,
    updatedAt: summary.updatedAt,
  };
}

/**
 * The automations each of these rooms owns, newest projection first, as the
 * REST rail read lists them. 250 per room is that read's existing bound.
 */
export function ownedAutomationSummaries(
  sql: Sql,
  workstreamIds: readonly string[],
): Map<string, WorkstreamAutomationSummary[]> {
  const result = new Map<string, WorkstreamAutomationSummary[]>();
  if (workstreamIds.length === 0) return result;
  for (const row of sql.exec<AutomationDirectoryRow>(
    `SELECT automation_id, loadable, appearance_json, lifecycle, scope, owning_workstream_id, title,
            description, next_run_at, projected_at
       FROM (
         SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY owning_workstream_id ORDER BY projected_at DESC, automation_id
                ) AS position
           FROM automation_directory
          WHERE owning_workstream_id IN (SELECT value FROM json_each(?)) AND lifecycle <> 'deleted'
       )
      WHERE position <= 250
      ORDER BY owning_workstream_id, projected_at DESC, automation_id`,
    JSON.stringify(workstreamIds),
  ).toArray()) {
    const list = result.get(row.owning_workstream_id!) ?? [];
    list.push(workstreamAutomationSummary(row));
    result.set(row.owning_workstream_id!, list);
  }
  return result;
}

/**
 * Each Channel's Main participants, newest first: the viewer rows at the
 * Channel's own authority generation, the facepile's order.
 */
export function channelParticipantIds(sql: Sql, workstreamIds: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (workstreamIds.length === 0) return result;
  for (const row of sql.exec<{ workstream_id: string; user_id: string }>(
    `SELECT viewer.workstream_id, viewer.user_id
       FROM channel_viewers viewer
       JOIN channels directory
         ON directory.workstream_id = viewer.workstream_id
        AND directory.authority_generation = viewer.authority_generation
      WHERE viewer.workstream_id IN (SELECT value FROM json_each(?))
        AND viewer.is_participant = 1
      ORDER BY viewer.workstream_id, viewer.participant_added_at DESC, viewer.user_id`,
    JSON.stringify(workstreamIds),
  ).toArray()) {
    const list = result.get(row.workstream_id);
    if (list) list.push(row.user_id);
    else result.set(row.workstream_id, [row.user_id]);
  }
  return result;
}

interface SidekickRow extends Record<string, SqlStorageValue> {
  automation_id: string;
  author_user_id: string;
  /** Null until the Sidekick next publishes its row after migration 81. */
  run_as_user_id: string | null;
  lifecycle: string;
  scope: string;
  owning_workstream_id: string | null;
  title: string;
  description: string;
  loadable: number | null;
}

interface RailChannel {
  workstreamId: string;
  railWaterline: number;
  scope: string;
  reported: boolean;
}

/**
 * Whether a Sidekick is shown in this Channel's rail for this viewer: the
 * audience `SidekickDO.skillAudienceAllows` applies to a summary read, with
 * the viewer as principal and Main's participants as the audience. A personal
 * Sidekick's people are its author and whoever it runs as.
 */
function sidekickShown(row: SidekickRow, channel: RailChannel, participants: readonly string[], viewerId: string): boolean {
  if (row.lifecycle === "deleted") return false;
  if (row.scope === "personal") {
    const people = new Set([row.author_user_id, row.run_as_user_id ?? row.author_user_id]);
    if (!people.has(viewerId) || channel.scope === "workspace" || participants.length === 0
      || participants.some((id) => !people.has(id))) return false;
  }
  return row.scope !== "workstream" || row.owning_workstream_id === channel.workstreamId;
}

function sidekickAttachment(row: SidekickRow): SidekickAttachment {
  return {
    id: row.automation_id,
    name: row.title || "New Sidekick",
    description: row.description,
    available: row.lifecycle === "active" && row.loadable === 1,
  };
}

/** Ids per Channel from a `(workstream_id, sidekick_id)` read, in the read's order. */
function groupIds(rows: readonly { workstream_id: string; sidekick_id: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const list = result.get(row.workstream_id);
    if (list) list.push(row.sidekick_id);
    else result.set(row.workstream_id, [row.sidekick_id]);
  }
  return result;
}

export interface ChannelRailsRequest {
  userId: string;
  accessClass: "member" | "guest";
  workspaceId: string;
  workstreamIds: readonly string[];
}

export interface ChannelRailsAnswer {
  /** One per visible Channel, in the order they were asked for. */
  rails: ChannelRail[];
  /** Asked for, and not a Channel this viewer is sent a row for. */
  unavailable: string[];
}

/**
 * The rails of these Channels for one viewer.
 *
 * Visible means what the Channel row's audience means (`channelRowPayloads`):
 * hosted, not archived, and Organization-wide or this viewer a participant at
 * the Channel's generation. A guest is admitted by the same predicate, as
 * rows admit them.
 */
export function channelRails(sql: Sql, request: ChannelRailsRequest): ChannelRailsAnswer {
  const asked = [...new Set(request.workstreamIds)];
  if (asked.length === 0) return { rails: [], unavailable: [] };
  const channels = new Map(sql.exec<{
    workstream_id: string; rail_waterline: number; scope: string; sidekick_attachments_reported: number;
  }>(
    `SELECT directory.workstream_id, directory.rail_waterline, directory.scope,
            directory.sidekick_attachments_reported
       FROM channels directory
       JOIN parent_metadata parent
         ON parent.parent_id = directory.workstream_id AND parent.parent_kind = 'workstream'
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
      WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
        AND directory.archived_at IS NULL
        AND ${channelVisibleToViewerSql("directory", "viewer")}`,
    request.userId,
    JSON.stringify(asked),
  ).toArray().map((row): [string, RailChannel] => [row.workstream_id, {
    workstreamId: row.workstream_id,
    railWaterline: row.rail_waterline,
    scope: row.scope,
    reported: row.sidekick_attachments_reported === 1,
  }]));
  const visibleIds = asked.filter((id) => channels.has(id));
  const unavailable = asked.filter((id) => !channels.has(id));
  if (visibleIds.length === 0) return { rails: [], unavailable };
  const visibleJson = JSON.stringify(visibleIds);

  const participants = channelParticipantIds(sql, visibleIds);
  // Owned is the REST rail read's list, which answers only a member who is a
  // participant of the room; everyone else is told it is empty.
  const ownedFor = request.accessClass === "member"
    ? visibleIds.filter((id) => participants.get(id)?.includes(request.userId) === true)
    : [];
  const owned = ownedAutomationSummaries(sql, ownedFor);

  // Recommended is the Channel's explicit recommendations, then everything
  // the room owns, as `WorkstreamService.recommendedSidekicks` builds it.
  const explicit = groupIds(sql.exec<{ workstream_id: string; sidekick_id: string }>(
    `SELECT parent_id AS workstream_id, sidekick_id FROM parent_sidekicks
      WHERE parent_id IN (SELECT value FROM json_each(?))
      ORDER BY parent_id, attached_at, sidekick_id`,
    visibleJson,
  ).toArray());
  const ownedIds = groupIds(sql.exec<{ workstream_id: string; sidekick_id: string }>(
    `SELECT owning_workstream_id AS workstream_id, automation_id AS sidekick_id FROM automation_directory
      WHERE owning_workstream_id IN (SELECT value FROM json_each(?)) AND lifecycle <> 'deleted'
      ORDER BY owning_workstream_id, automation_id`,
    visibleJson,
  ).toArray());
  const reported = visibleIds.filter((id) => channels.get(id)!.reported);
  const attachedIds = groupIds(reported.length === 0 ? [] : sql.exec<{ workstream_id: string; sidekick_id: string }>(
    `SELECT workstream_id, sidekick_id FROM channel_sidekick_attachments
      WHERE workstream_id IN (SELECT value FROM json_each(?))
      ORDER BY workstream_id, position`,
    JSON.stringify(reported),
  ).toArray());
  const sidekickIds = new Set<string>();
  for (const ids of [...explicit.values(), ...ownedIds.values(), ...attachedIds.values()]) {
    for (const id of ids) sidekickIds.add(id);
  }
  const sidekicks = new Map(sidekickIds.size === 0 ? [] : sql.exec<SidekickRow>(
    `SELECT automation_id, author_user_id, run_as_user_id, lifecycle, scope, owning_workstream_id, title, description, loadable
       FROM automation_directory WHERE automation_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...sidekickIds]),
  ).toArray().map((row) => [row.automation_id, row]));

  const resources = new Map<string, ChannelRailResource[]>();
  for (const row of sql.exec<{
    workstream_id: string; id: string; title: string; resource_type: string; mime_type: string | null;
    relationship_type: string; current_version: number | null;
  }>(
    // Main's links in the order its conversation projected them (the link
    // table is replaced whole, so rowid is display order), with the detail's
    // enumeration rule: notes are not resources here, and an unlisted
    // resource is reachable but not advertised.
    `SELECT link.workstream_id, r.id, r.title, r.resource_type, r.mime_type, link.relationship_type,
            r.current_version
       FROM workspace_workstream_resource_links link
       JOIN resources r ON r.id = link.resource_id AND r.workspace_id = ?
      WHERE link.workstream_id IN (SELECT value FROM json_each(?))
        AND r.provider != 'avalon_note'
        AND ${listedResourceVisibilitySql("r")}
      ORDER BY link.workstream_id, link.rowid`,
    request.workspaceId,
    visibleJson,
  ).toArray()) {
    const relationship = ResourceRelationshipTypeSchema.safeParse(row.relationship_type);
    const list = resources.get(row.workstream_id) ?? [];
    list.push({
      id: row.id,
      title: truncateUtf16Safe(row.title, 300),
      resourceType: row.resource_type,
      mimeType: row.mime_type === null ? null : truncateUtf16Safe(row.mime_type, 160),
      direction: resourceDirectionForRelationship(relationship.success ? relationship.data : "attachment"),
      currentVersion: Math.max(1, row.current_version ?? 1),
    });
    resources.set(row.workstream_id, list);
  }

  const rails = visibleIds.map((workstreamId): ChannelRail => {
    const channel = channels.get(workstreamId)!;
    const people = participants.get(workstreamId) ?? [];
    const summaries = (ids: readonly string[]) => {
      const shown: SidekickAttachment[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        const row = sidekicks.get(id);
        if (seen.has(id) || !row || !sidekickShown(row, channel, people, request.userId)) continue;
        seen.add(id);
        shown.push(sidekickAttachment(row));
      }
      return shown;
    };
    return {
      workstreamId: workstreamId as ChannelRail["workstreamId"],
      railWaterline: channel.railWaterline,
      participantUserIds: people as ChannelRail["participantUserIds"],
      sidekicks: {
        owned: owned.get(workstreamId) ?? [],
        recommended: summaries([...explicit.get(workstreamId) ?? [], ...ownedIds.get(workstreamId) ?? []]),
        ...(channel.reported ? { attached: summaries(attachedIds.get(workstreamId) ?? []) } : {}),
      },
      resources: resources.get(workstreamId) ?? [],
    };
  });
  return { rails, unavailable };
}

// ---------------------------------------------------------------------------
// Frames.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

type FrameDraft = Omit<WorkspaceChannelRailsEvent, "nextAfter" | "final">;

/**
 * Packs one answer's rails into `workspace_channel_rails` frames no larger
 * than the socket's frame limit, by encoded byte length.
 *
 * `add` answers `full` when the rail does not fit what is left of the current
 * frame; the caller either starts another (`roll`) or stops there. A rail that
 * would not fit even an empty frame is `oversized`: it is named in the frame's
 * `oversized` list with its waterline, and the client paints that Channel from
 * its snapshot instead.
 */
export class ChannelRailFrames {
  private readonly closed: FrameDraft[] = [];
  private draft: FrameDraft;
  private used: number;
  /** Room kept for `nextAfter`, which is written only when the answer ends. */
  private reserve = 0;
  private readonly empty: number;
  readonly oversizedRails: Array<{ workstreamId: string; bytes: number }> = [];

  constructor(private readonly requestId: string, private readonly limit: number) {
    this.draft = this.blank();
    // `final: false` and `nextAfter: null` are the longer and the shorter of
    // their spellings; `reserve` covers the difference for `nextAfter`.
    this.empty = jsonBytes({ ...this.draft, nextAfter: null, final: false });
    this.used = this.empty;
  }

  private blank(): FrameDraft {
    return { type: "workspace_channel_rails", requestId: this.requestId as FrameDraft["requestId"],
      rails: [], oversized: [], unavailable: [] };
  }

  /** Named Channels this viewer may not be told about; they ride the current frame. */
  addUnavailable(ids: readonly string[]): void {
    for (const id of ids) {
      this.used += jsonBytes(id) + (this.draft.unavailable.length > 0 ? 1 : 0);
      this.draft.unavailable.push(id as FrameDraft["unavailable"][number]);
    }
  }

  add(rail: ChannelRail): "added" | "oversized" | "full" {
    const reserve = Math.max(this.reserve, jsonBytes(rail.workstreamId) - jsonBytes(null));
    const railBytes = jsonBytes(rail);
    if (this.empty + reserve + railBytes > this.limit) {
      const entry = { workstreamId: rail.workstreamId, railWaterline: rail.railWaterline };
      const cost = jsonBytes(entry) + (this.draft.oversized.length > 0 ? 1 : 0);
      if (this.used + cost + reserve > this.limit) return "full";
      this.draft.oversized.push(entry);
      this.used += cost;
      this.reserve = reserve;
      this.oversizedRails.push({ workstreamId: rail.workstreamId, bytes: railBytes });
      return "oversized";
    }
    const cost = railBytes + (this.draft.rails.length > 0 ? 1 : 0);
    if (this.used + cost + reserve > this.limit) return "full";
    this.draft.rails.push(rail);
    this.used += cost;
    this.reserve = reserve;
    return "added";
  }

  /** Close the current frame and start an empty one. */
  roll(): void {
    this.closed.push(this.draft);
    this.draft = this.blank();
    this.used = this.empty;
  }

  /** Every frame, in order; only the last is `final`, and only it names `nextAfter`. */
  finish(nextAfter: string | null): WorkspaceChannelRailsEvent[] {
    const drafts = [...this.closed, this.draft];
    return drafts.map((draft, index) => {
      const last = index === drafts.length - 1;
      return {
        ...draft,
        nextAfter: (last ? nextAfter : null) as WorkspaceChannelRailsEvent["nextAfter"],
        final: last,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// The rail waterline: schema, triggers, and the change ledger.
// ---------------------------------------------------------------------------

/**
 * Advance these Channels' rail waterlines and note them for a row push. The
 * id set is SQL over the trigger's `NEW`/`OLD` row; an id that is not a
 * Channel (a Space parent, an unlinked resource) matches nothing.
 */
function bumpRailsSql(channelIds: string): string {
  return `UPDATE channels SET rail_waterline = rail_waterline + 1 WHERE workstream_id IN (${channelIds});
     INSERT INTO channel_rail_changes (workstream_id)
       SELECT workstream_id FROM channels WHERE workstream_id IN (${channelIds})
       ON CONFLICT(workstream_id) DO NOTHING;`;
}

function changed(columns: readonly string[]): string {
  return columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
}

/** The columns an owned rail entry shows, audience included. */
const OWNED_AUTOMATION_COLUMNS = [
  "title", "description", "lifecycle", "loadable", "appearance_json", "next_run_at", "projected_at",
  "scope", "owning_workstream_id", "author_user_id", "run_as_user_id",
] as const;
/** What a recommended or attached entry shows, and who it is shown to. */
const LISTED_SIDEKICK_COLUMNS = [
  "title", "description", "lifecycle", "loadable", "scope", "owning_workstream_id", "author_user_id", "run_as_user_id",
] as const;
const RAIL_RESOURCE_COLUMNS = ["title", "resource_type", "mime_type", "current_version", "provider"] as const;

const sidekickListers = (row: "NEW" | "OLD") =>
  `SELECT parent_id FROM parent_sidekicks WHERE sidekick_id = ${row}.automation_id
   UNION SELECT workstream_id FROM channel_sidekick_attachments WHERE sidekick_id = ${row}.automation_id`;
const resourceLinkers = (row: "NEW" | "OLD") =>
  `SELECT workstream_id FROM workspace_workstream_resource_links WHERE resource_id = ${row}.id`;

/**
 * WorkspaceDO migration 82.
 *
 * The rail's own state (the attachments Main reported) and the waterline that
 * says it moved. Triggers advance the waterline for every table a rail reads
 * whose writers are not already Channel-row writers: participants, scope and
 * generation, recommendations, the Sidekick directory, and resource
 * presentation. The Main link list and the attachment list are compared and
 * bumped in `applyDirectoryEnvelope` instead, because that table is replaced
 * wholesale on every Main effect and a trigger there would fire on each one.
 */
export const CHANNEL_RAIL_MIGRATION: readonly string[] = [
  `ALTER TABLE channels ADD COLUMN rail_waterline INTEGER NOT NULL DEFAULT 0 CHECK (rail_waterline >= 0)`,
  `ALTER TABLE channels ADD COLUMN sidekick_attachments_reported INTEGER NOT NULL DEFAULT 0
     CHECK (sidekick_attachments_reported IN (0, 1))`,
  `CREATE TABLE channel_sidekick_attachments (
    workstream_id TEXT NOT NULL REFERENCES channels(workstream_id) ON DELETE CASCADE,
    sidekick_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (workstream_id, sidekick_id)
  ) STRICT`,
  `CREATE INDEX channel_sidekick_attachments_sidekick_idx ON channel_sidekick_attachments(sidekick_id, workstream_id)`,
  `CREATE INDEX parent_sidekicks_sidekick_idx ON parent_sidekicks(sidekick_id, parent_id)`,
  // Channels whose rail moved since their rows were last pushed for it.
  `CREATE TABLE channel_rail_changes (workstream_id TEXT PRIMARY KEY) STRICT`,

  `CREATE TRIGGER channel_rail_viewer_insert AFTER INSERT ON channel_viewers
     WHEN NEW.is_participant = 1
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,
  `CREATE TRIGGER channel_rail_viewer_update
     AFTER UPDATE OF is_participant, authority_generation, participant_added_at ON channel_viewers
     WHEN OLD.is_participant IS NOT NEW.is_participant
       OR (NEW.is_participant = 1 AND (${changed(["authority_generation", "participant_added_at"])}))
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,
  `CREATE TRIGGER channel_rail_viewer_delete AFTER DELETE ON channel_viewers
     WHEN OLD.is_participant = 1
     BEGIN ${bumpRailsSql("SELECT OLD.workstream_id")} END`,
  // `UPDATE OF` two named columns, so the bump's own write to
  // `rail_waterline` cannot fire it again.
  `CREATE TRIGGER channel_rail_channel_update AFTER UPDATE OF scope, authority_generation ON channels
     WHEN ${changed(["scope", "authority_generation"])}
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,

  `CREATE TRIGGER channel_rail_recommendation_insert AFTER INSERT ON parent_sidekicks
     BEGIN ${bumpRailsSql("SELECT NEW.parent_id")} END`,
  `CREATE TRIGGER channel_rail_recommendation_delete AFTER DELETE ON parent_sidekicks
     BEGIN ${bumpRailsSql("SELECT OLD.parent_id")} END`,

  `CREATE TRIGGER channel_rail_sidekick_insert AFTER INSERT ON automation_directory
     BEGIN ${bumpRailsSql(`SELECT NEW.owning_workstream_id UNION ${sidekickListers("NEW")}`)} END`,
  `CREATE TRIGGER channel_rail_sidekick_owner_update
     AFTER UPDATE OF ${OWNED_AUTOMATION_COLUMNS.join(", ")} ON automation_directory
     WHEN ${changed(OWNED_AUTOMATION_COLUMNS)}
     BEGIN ${bumpRailsSql("SELECT OLD.owning_workstream_id UNION SELECT NEW.owning_workstream_id")} END`,
  `CREATE TRIGGER channel_rail_sidekick_listed_update
     AFTER UPDATE OF ${LISTED_SIDEKICK_COLUMNS.join(", ")} ON automation_directory
     WHEN ${changed(LISTED_SIDEKICK_COLUMNS)}
     BEGIN ${bumpRailsSql(sidekickListers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_sidekick_delete AFTER DELETE ON automation_directory
     BEGIN ${bumpRailsSql(`SELECT OLD.owning_workstream_id UNION ${sidekickListers("OLD")}`)} END`,

  // A link can name a resource before its row arrives.
  `CREATE TRIGGER channel_rail_resource_insert AFTER INSERT ON resources
     BEGIN ${bumpRailsSql(resourceLinkers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_resource_update
     AFTER UPDATE OF ${RAIL_RESOURCE_COLUMNS.join(", ")}, metadata_json ON resources
     WHEN ${changed(RAIL_RESOURCE_COLUMNS)}
       OR (${listedResourceVisibilitySql("OLD")}) IS NOT (${listedResourceVisibilitySql("NEW")})
     BEGIN ${bumpRailsSql(resourceLinkers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_resource_delete AFTER DELETE ON resources
     BEGIN ${bumpRailsSql(resourceLinkers("OLD"))} END`,
];

/** Advance one Channel's rail waterline from code, for a change no trigger sees. */
export function bumpChannelRail(sql: Sql, workstreamId: string): void {
  sql.exec(`UPDATE channels SET rail_waterline = rail_waterline + 1 WHERE workstream_id = ?`, workstreamId);
  sql.exec(`INSERT INTO channel_rail_changes (workstream_id) VALUES (?) ON CONFLICT(workstream_id) DO NOTHING`,
    workstreamId);
}

/** Take every Channel whose rail moved since the last drain. */
export function drainChannelRailChanges(sql: Sql): string[] {
  return sql.exec<{ workstream_id: string }>(`DELETE FROM channel_rail_changes RETURNING workstream_id`)
    .toArray().map((row) => row.workstream_id);
}

/** Whether a drain has anything to take: the alarm arms on it. */
export function channelRailChangesPending(sql: Sql): boolean {
  return sql.exec(`SELECT 1 FROM channel_rail_changes LIMIT 1`).toArray().length > 0;
}

/**
 * Replace a Channel's reported Main attachments when the list moved, and
 * advance its rail waterline if it did. The first report always moves it:
 * before it the rail had no `attached` at all.
 */
export function applyReportedSidekickAttachments(sql: Sql, workstreamId: string, sidekickIds: readonly string[]): void {
  const reported = sql.exec<{ sidekick_attachments_reported: number }>(
    `SELECT sidekick_attachments_reported FROM channels WHERE workstream_id = ?`, workstreamId,
  ).toArray()[0]?.sidekick_attachments_reported === 1;
  const current = sql.exec<{ sidekick_id: string }>(
    `SELECT sidekick_id FROM channel_sidekick_attachments WHERE workstream_id = ? ORDER BY position`, workstreamId,
  ).toArray().map((row) => row.sidekick_id);
  const next = [...new Set(sidekickIds)];
  if (reported && current.length === next.length && current.every((id, index) => id === next[index])) return;
  sql.exec(`DELETE FROM channel_sidekick_attachments WHERE workstream_id = ?`, workstreamId);
  for (const [position, sidekickId] of next.entries()) {
    sql.exec(`INSERT INTO channel_sidekick_attachments (workstream_id, sidekick_id, position) VALUES (?, ?, ?)`,
      workstreamId, sidekickId, position);
  }
  sql.exec(`UPDATE channels SET sidekick_attachments_reported = 1 WHERE workstream_id = ?`, workstreamId);
  bumpChannelRail(sql, workstreamId);
}

/**
 * Advance a Channel's rail waterline when Main's link list moved: same
 * resources, same relationships, same order. Read before the list is replaced.
 */
export function mainResourceLinksChanged(
  sql: Sql,
  workstreamId: string,
  links: readonly { resourceId: string; relationshipType: string }[],
): boolean {
  const current = sql.exec<{ resource_id: string; relationship_type: string }>(
    `SELECT resource_id, relationship_type FROM workspace_workstream_resource_links
      WHERE workstream_id = ? ORDER BY rowid`,
    workstreamId,
  ).toArray();
  return current.length !== links.length || current.some((row, index) =>
    row.resource_id !== links[index]!.resourceId || row.relationship_type !== links[index]!.relationshipType);
}
