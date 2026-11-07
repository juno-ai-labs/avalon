/**
 * A Channel's rail, as the Organization socket delivers it: Main's
 * participants, the Sidekicks the rail lists, and Main's attached resources.
 *
 * Set reads over `json_each` against WorkspaceDO's own SQLite, so one answer
 * is one consistent snapshot. A Channel the viewer could not be sent a row for
 * is `unavailable`, never a second authorization path.
 * `docs/hosted-conversation-parents.md` owns the projection and its
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
  type WorkstreamAppearance,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

import { listedResourceVisibilitySql } from "../services/resource-listing";
import { sidekickAudienceAllows } from "./sidekick-audience";
import { channelListedSql, mainOpenableSql, type AccessClass } from "./listing-rules";

type Sql = SqlStorage;

/** Told which Sidekick's stored appearance no longer parses, and why; it is left out. */
export type InvalidAppearanceReport = (automationId: string, code: string) => void;

export interface AutomationDirectoryRow extends Record<string, SqlStorageValue> {
  loadable: number | null;
  appearance_json: string | null;
  automation_id: string;
  lifecycle: "draft" | "active" | "paused";
  scope: "personal" | "workspace";
  title: string;
  description: string;
  next_run_at: number | null;
  projected_at: number;
}

/** A stored appearance, or undefined with the reason reported when it no longer parses. */
export function parsedAppearance(json: string | null, prefix: string, report: (code: string) => void): WorkstreamAppearance | undefined {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    report(`${prefix}_invalid:-root-:invalid_json`);
    return undefined;
  }
  const parsed = WorkstreamAppearanceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  report(zodDiagnosticCode(parsed.error, prefix) ?? `${prefix}_invalid`);
  return undefined;
}

function storedAppearance(row: AutomationDirectoryRow, report: InvalidAppearanceReport): WorkstreamAppearance | undefined {
  return parsedAppearance(row.appearance_json, "automation_appearance", (code) => report(row.automation_id, code));
}

/** A directory row as a summary; an appearance that no longer parses is left out and reported. */
export function automationSummary(
  row: AutomationDirectoryRow & {
    last_run_at?: number | null;
    /** Rows on the `people` list (`AUTOMATION_AUDIENCE_SQL`); absent from a read that did not ask. */
    shared_count?: number;
    /** The viewer's read state of the shared conversation (`AUTOMATION_VIEWER_SQL`); sidebar reads only. */
    unread?: number;
    needs_input?: number;
  },
  report: InvalidAppearanceReport,
): AutomationSummary {
  const appearance = storedAppearance(row, report);
  return {
    id: row.automation_id,
    loadable: row.loadable === 1,
    ...(appearance ? { appearance } : {}),
    name: row.title || "New Sidekick",
    description: row.description,
    emailAddress: null,
    scope: row.scope,
    status: row.lifecycle,
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
    lastRunAt: row.last_run_at == null ? null : new Date(row.last_run_at).toISOString(),
    updatedAt: new Date(row.projected_at).toISOString(),
    ...(row.shared_count === undefined ? {} : {
      audience: row.shared_count > 0 ? "people" as const : row.scope === "workspace" ? "workspace" as const : "personal" as const,
    }),
    ...(row.unread === undefined ? {} : { unread: row.unread === 1 }),
    ...(row.needs_input === undefined ? {} : { needsInput: row.needs_input === 1 }),
  };
}

/** `shared_count` for `automationSummary`, over an `automation_directory` aliased `directory`. */
export const AUTOMATION_AUDIENCE_SQL = `(SELECT COUNT(*) FROM sidekick_audience shared
   WHERE shared.sidekick_id = directory.automation_id) AS shared_count`;

/**
 * `unread` and `needs_input` for `automationSummary`, for the viewer bound to
 * `?1`, over an `automation_directory` aliased `directory`.
 *
 * Unread is the shared conversation's own read state as it last reported it
 * for this viewer (`sidekick_viewer_reads`) against its latest attention
 * ordinal (its `directory_common` projection): a manual unread mark, or a
 * message past what they saw. A viewer who has never opened the conversation
 * has no read state there and reads as unread, as a Channel they have not
 * opened is `unseen`; its author, who wrote it in that conversation, does not.
 * Needs input is the delegation attention or the conversation waiting on input.
 */
export const AUTOMATION_VIEWER_SQL = `CASE
     WHEN reads.user_id IS NULL THEN CASE WHEN directory.author_user_id = ?1 THEN 0 ELSE 1 END
     WHEN reads.manual_unread_from_ordinal IS NOT NULL THEN 1
     WHEN COALESCE(json_extract(main.effect_json, '$.latestAttentionOrdinal'), 0) > reads.seen_attention_ordinal THEN 1
     ELSE 0 END AS unread,
   CASE WHEN directory.delegation_attention_code IS NOT NULL
          OR json_extract(main.effect_json, '$.state') = 'needs_input' THEN 1 ELSE 0 END AS needs_input`;

/** The joins `AUTOMATION_VIEWER_SQL` reads, for the viewer bound to `?1`. */
export const AUTOMATION_VIEWER_JOINS = `LEFT JOIN sidekick_viewer_reads reads
     ON reads.sidekick_id = directory.automation_id AND reads.user_id = ?1
   LEFT JOIN sidekick_child_projections main
     ON main.sidekick_id = directory.automation_id AND main.substream_id = '0'`;

/** Each Channel's Main participants at the Channel's generation, newest first. */
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
  run_as_user_id: string | null;
  lifecycle: string;
  scope: string;
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

/** `HostedSidekick.readSkillSummary`'s answer, with the viewer as principal and Main's participants as the audience. */
function sidekickShown(row: SidekickRow, channel: RailChannel, participants: readonly string[], viewerId: string): boolean {
  return row.lifecycle !== "deleted" && sidekickAudienceAllows({
    scope: row.scope,
    authorUserId: row.author_user_id,
    runAsUserId: row.run_as_user_id,
  }, {
    principalUserId: viewerId,
    conversationParentId: channel.workstreamId,
    audienceScope: channel.scope === "workspace" ? "workspace" : "personal",
    audienceUserIds: participants,
  });
}

function sidekickAttachment(row: SidekickRow): SidekickAttachment {
  return {
    id: row.automation_id,
    name: row.title,
    description: row.description,
    available: row.lifecycle === "active" && row.loadable === 1,
  };
}

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
  accessClass: AccessClass;
  workspaceId: string;
  workstreamIds: readonly string[];
  onInvalidAppearance: InvalidAppearanceReport;
}

export interface ChannelRailsAnswer {
  /** One per visible Channel, in the order they were asked for. */
  rails: ChannelRail[];
  /** Asked for, and not a Channel this viewer is sent a row for. */
  unavailable: string[];
}

/**
 * The rails of these Channels for one viewer. A rail is Main's (its resources,
 * Sidekicks and roster), so it answers only somebody who may open Main
 * (`mainOpenableSql`); a Channel listed to them only through a Breakout is
 * `unavailable`, as is anything else they may not open.
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
        AND ${mainOpenableSql("directory", "viewer", request.accessClass, "?1")}`,
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

  // Recommended is the explicit recommendations; a room owns no Sidekick.
  const explicit = groupIds(sql.exec<{ workstream_id: string; sidekick_id: string }>(
    `SELECT parent_id AS workstream_id, sidekick_id FROM parent_sidekicks
      WHERE parent_id IN (SELECT value FROM json_each(?))
      ORDER BY parent_id, attached_at, sidekick_id`,
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
  for (const ids of [...explicit.values(), ...attachedIds.values()]) {
    for (const id of ids) sidekickIds.add(id);
  }
  const sidekicks = new Map(sidekickIds.size === 0 ? [] : sql.exec<SidekickRow>(
    `SELECT automation_id, author_user_id, run_as_user_id, lifecycle, scope, title, description, loadable
       FROM automation_directory WHERE automation_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...sidekickIds]),
  ).toArray().map((row) => [row.automation_id, row]));

  const resources = new Map<string, ChannelRailResource[]>();
  for (const row of sql.exec<{
    workstream_id: string; id: string; title: string; resource_type: string; mime_type: string | null;
    relationship_type: string; current_version: number | null;
  }>(
    // The link table is replaced whole, so rowid is Main's display order.
    // Notes are not resources here, and an unlisted resource is not advertised.
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
        // Released clients parse the list; no room owns a Sidekick any more.
        owned: [],
        recommended: summaries(explicit.get(workstreamId) ?? []),
        ...(channel.reported ? { attached: summaries(attachedIds.get(workstreamId) ?? []) } : {}),
      },
      resources: resources.get(workstreamId) ?? [],
    };
  });
  return { rails, unavailable };
}

/**
 * One page of a Space's active Channels this viewer may see, in id order after
 * `after`. System Channels are left off, as every sidebar list leaves them
 * off, so they never fill a page or become its cursor. Visibility is decided in the page query, so a page never holds a
 * Channel the viewer cannot be told about and one request reads one page, however
 * many of the Space's Channels are hidden from them. The caller has already
 * asked whether they may see the Space at all.
 */
export function visibleSpaceChannelIdsAfter(
  sql: Sql,
  request: { spaceId: string; userId: string; accessClass: AccessClass; breakouts: boolean; after: string | null; limit: number },
): string[] {
  return sql.exec<{ workstream_id: string }>(
    `SELECT membership.workstream_id
       FROM space_channel_memberships membership
       JOIN channels directory ON directory.workstream_id = membership.workstream_id
       JOIN parent_metadata parent
         ON parent.parent_id = directory.workstream_id AND parent.parent_kind = 'workstream'
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
      WHERE membership.space_id = ? AND membership.state = 'active' AND membership.workstream_id > ?
        AND directory.archived_at IS NULL AND directory.system_kind IS NULL
        AND ${channelListedSql("directory", "viewer", request.accessClass, { breakouts: request.breakouts, userId: "?1" })}
      ORDER BY membership.workstream_id
      LIMIT ?`,
    request.userId,
    request.spaceId,
    request.after ?? "",
    request.limit,
  ).toArray().map((row) => row.workstream_id);
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
 * `full` means the entry does not fit what is left of the current frame; the
 * caller either `roll`s to another or stops there. A rail too large for even
 * an empty frame is named in `oversized` instead, and the client paints that
 * Channel from its snapshot.
 */
export class ChannelRailFrames {
  private readonly closed: FrameDraft[] = [];
  private draft: FrameDraft;
  private used: number;
  private readonly empty: number;
  readonly oversizedRails: Array<{ workstreamId: string; bytes: number }> = [];

  constructor(private readonly requestId: string, private readonly limit: number) {
    this.draft = this.blank();
    // The longer spelling of `final`.
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
    const railBytes = jsonBytes(rail);
    if (this.empty + railBytes > this.limit) {
      const outcome = this.addOversized(rail);
      if (outcome === "oversized") this.oversizedRails.push({ workstreamId: rail.workstreamId, bytes: railBytes });
      return outcome;
    }
    const cost = railBytes + (this.draft.rails.length > 0 ? 1 : 0);
    if (this.used + cost > this.limit) return "full";
    this.draft.rails.push(rail);
    this.used += cost;
    return "added";
  }

  /** Name a Channel the client paints from its snapshot rather than from a rail. */
  addOversized(rail: Pick<ChannelRail, "workstreamId" | "railWaterline">): "oversized" | "full" {
    const entry = { workstreamId: rail.workstreamId, railWaterline: rail.railWaterline };
    const cost = jsonBytes(entry) + (this.draft.oversized.length > 0 ? 1 : 0);
    if (this.used + cost > this.limit) return "full";
    this.draft.oversized.push(entry);
    this.used += cost;
    return "oversized";
  }

  /** Close the current frame and start an empty one. */
  roll(): void {
    this.closed.push(this.draft);
    this.draft = this.blank();
    this.used = this.empty;
  }

  /** Every frame, in order; only the last is `final`. */
  finish(): WorkspaceChannelRailsEvent[] {
    const drafts = [...this.closed, this.draft];
    return drafts.map((draft, index) => ({ ...draft, nextAfter: null, final: index === drafts.length - 1 }));
  }
}

// ---------------------------------------------------------------------------
// The rail waterline: schema, triggers, and the change ledger.
// ---------------------------------------------------------------------------

/**
 * Advance these Channels' rail waterlines and note them in the ledger. An id
 * that is not a Channel (a Space parent, an unlinked resource) matches nothing.
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

/**
 * What an owned entry shows, and which room owns it. Not the run times or
 * `projected_at`, which move on every scheduled run and are not shown.
 */
const OWNED_AUTOMATION_COLUMNS = [
  "title", "description", "lifecycle", "loadable", "appearance_json", "scope", "owning_workstream_id",
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
 * WorkspaceDO migration 82: Main's reported attachments, the waterline, the
 * change ledger, and a trigger on every table a rail reads whose writers are
 * not already Channel-row writers. Main's link and attachment lists are
 * compared in `applyDirectoryEnvelope` instead: every Main effect rewrites
 * them, and a trigger there would fire on each one.
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
  // `UPDATE OF` names two columns, so the bump's own write cannot fire it again.
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

/**
 * Whether a Channel's Main has never reported its Sidekick attachments, so its
 * rail has no `attached` list yet. False for a Channel this object does not
 * hold.
 */
export function mainAttachmentsUnreported(sql: Sql, workstreamId: string): boolean {
  return sql.exec<{ reported: number }>(
    `SELECT sidekick_attachments_reported AS reported FROM channels WHERE workstream_id = ?`, workstreamId,
  ).toArray()[0]?.reported === 0;
}

/**
 * Replace a Channel's reported Main attachments, and advance its rail
 * waterline, when the list moved. The first report always moves it: before it
 * the rail had no `attached` at all.
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

/** Whether Main's link list moved: same resources, relationships and order. Read before it is replaced. */
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
