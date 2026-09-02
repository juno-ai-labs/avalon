import {
  WORKSTREAM_DESCRIPTION_MAX_CHARACTERS,
  WORKSTREAM_NAMING_GRACE_MS,
  WorkstreamSchema,
  workstreamParticipantPreview,
  type Workstream,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";

import { boundParameterChunks } from "./bound-parameters";
import {
  WorkspaceDirectoryScheduleTargetsResultSchema,
  type WorkspaceDirectoryListRequest,
  type WorkspaceDirectoryPage,
  type WorkspaceDirectoryScheduleTargetsResult,
} from "./workspace-directory-protocol";
import { epoch, iso } from "./workspace-projection";
import { insertWorkstreamEffectReceipt } from "./workspace-regional-effect-storage";
import type { WorkstreamRegionalEffectEnvelope } from "./workstream-regional-effect";

/**
 * The workspace's projected work-stream directory: its row shape, the one
 * statement every read of it starts from, the mappers that turn a row into the
 * contract's `Workstream`, and the projection write a WorkstreamDO regional
 * effect lands through.
 *
 * This is the largest read surface WorkspaceDO owns and the only one written
 * from outside the object's own domain, so it is kept whole and apart from the
 * RPC class: the row interface, the `SELECT` naming its columns, and the
 * `INSERT ... ON CONFLICT` that fills them have to change together, and a column
 * added to one of the three and missed in the others is silently wrong rather
 * than a type error.
 */

export interface WorkspaceDirectoryRow extends Record<string, SqlStorageValue> {
  workstream_id: string;
  /** 1 once an automation run's own work stream has been made visible. */
  automation_exposed?: number;
  authority_generation: number;
  common_waterline: number;
  common_event_id: string;
  title: string;
  description: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  origin_label: string | null;
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: number | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  source_created_at: number;
  source_updated_at: number;
  seen_attention_ordinal: number | null;
  manual_unread_from_ordinal: number | null;
  manual_unread_generation: number | null;
  latest_mention_attention_ordinal: number | null;
  is_participant: number | null;
  unseen: number | null;
  viewer_waterline: number | null;
  viewer_event_id: string | null;
  pin_position: number | null;
}

export function directoryCursor(value: string): { lastActivityAt: number; workstreamId: string } {
  const separator = value.indexOf(":");
  const lastActivityAt = Number(value.slice(0, separator));
  const workstreamId = value.slice(separator + 1);
  if (!Number.isSafeInteger(lastActivityAt) || lastActivityAt < 0 || !workstreamId) {
    throw new Error("workspace_directory_cursor_invalid");
  }
  return { lastActivityAt, workstreamId };
}

export function workstreamHarnessStatus(state: string): Workstream["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) {
    return "running";
  }
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  if (state === "cancelled") return "stopped";
  return "idle";
}

export function loadParticipantPreviews(
  sql: DurableObjectState["storage"]["sql"],
  workstreamIds: readonly string[],
): Map<string, ReturnType<typeof workstreamParticipantPreview>> {
  const previews = new Map<string, ReturnType<typeof workstreamParticipantPreview>>();
  if (workstreamIds.length === 0) return previews;
  const rows: { workstream_id: string; user_id: string }[] = [];
  for (const chunk of boundParameterChunks(workstreamIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...sql.exec<{ workstream_id: string; user_id: string }>(
      `SELECT viewer.workstream_id, viewer.user_id
         FROM workspace_workstream_viewers viewer
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = viewer.workstream_id
          AND directory.authority_generation = viewer.authority_generation
        WHERE viewer.workstream_id IN (${placeholders})
          AND viewer.is_participant = 1
        ORDER BY viewer.workstream_id, viewer.participant_added_at DESC, viewer.user_id`,
      ...chunk,
    ).toArray());
  }
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.workstream_id);
    if (list) list.push(row.user_id);
    else grouped.set(row.workstream_id, [row.user_id]);
  }
  for (const [workstreamId, userIds] of grouped) {
    previews.set(workstreamId, workstreamParticipantPreview(userIds));
  }
  return previews;
}

export function directoryWorkstream(
  row: WorkspaceDirectoryRow,
  workspaceId: string,
  preview: ReturnType<typeof workstreamParticipantPreview> = {
    participantUserIds: [],
    participantExtraCount: 0,
  },
): Workstream {
  const latest = Number(row.latest_attention_ordinal);
  const seen = row.seen_attention_ordinal === null
    ? Number(row.unread_tracking_start_ordinal)
    : Number(row.seen_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  const titleStatus = row.title_status === "naming"
    && Date.now() - row.source_created_at > WORKSTREAM_NAMING_GRACE_MS
    ? "automatic"
    : row.title_status;
  const participantPreview = row.scope === "personal"
    ? preview
    : { participantUserIds: [], participantExtraCount: 0 };
  return WorkstreamSchema.parse({
    id: row.workstream_id,
    workspaceId,
    title: truncateUtf16Safe(row.title, 180),
    titleStatus,
    objective: truncateUtf16Safe(row.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
    emailAddress: row.email_address,
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
    harnessStatus: workstreamHarnessStatus(row.exact_state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread: firstUnread !== null,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    unseen: row.unseen === 1,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    archivedAt: iso(row.archived_at),
    scope: row.scope,
    systemKind: row.system_kind,
    nextPendingWakeup: row.next_wakeup_due_at !== null && row.next_wakeup_prompt
      ? {
          dueAt: iso(row.next_wakeup_due_at),
          promptPreview: truncateUtf16Safe(row.next_wakeup_prompt.replace(/\s+/gu, " ").trim(), 40),
        }
      : null,
    pinPosition: row.pin_position,
    ...participantPreview,
  });
}

export function mapDirectoryWorkstreams(
  sql: DurableObjectState["storage"]["sql"],
  rows: readonly WorkspaceDirectoryRow[],
  workspaceId: string,
): Workstream[] {
  const personalIds = [...new Set(
    rows.filter((row) => row.scope === "personal").map((row) => row.workstream_id),
  )];
  const previews = loadParticipantPreviews(sql, personalIds);
  return rows.map((row) => directoryWorkstream(row, workspaceId, previews.get(row.workstream_id)));
}

export function mapDirectoryWorkstream(
  sql: DurableObjectState["storage"]["sql"],
  row: WorkspaceDirectoryRow,
  workspaceId: string,
): Workstream {
  return mapDirectoryWorkstreams(sql, [row], workspaceId)[0]!;
}

export function directoryStateVersion(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    commonEventId: row.common_event_id,
    viewerEventId: row.viewer_event_id,
    authorityGeneration: row.authority_generation,
    commonWaterline: row.common_waterline,
    viewerWaterline: row.viewer_waterline ?? 0,
  };
}

export function internalDirectoryItem(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    title: row.title,
    description: row.description,
    scope: row.scope,
    state: row.exact_state,
    systemKind: row.system_kind,
    lastActivityAt: iso(row.last_activity_at),
    archivedAt: iso(row.archived_at),
    updatedAt: iso(row.source_updated_at),
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
  };
}

export const SELECT_WORKSPACE_DIRECTORY = `SELECT directory.workstream_id,
    directory.authority_generation, directory.waterline AS common_waterline,
    directory.source_event_id AS common_event_id, directory.title,
    directory.description, directory.scope, directory.exact_state,
    directory.system_kind, directory.last_activity_at, directory.completed_at,
    directory.archived_at, directory.email_address, directory.origin_type,
    directory.automation_exposed,
    directory.origin_label, directory.created_by_user_id,
    directory.automation_subscription_id, directory.automation_run_id,
    directory.planned_for, directory.title_status,
    directory.latest_attention_ordinal, directory.unread_tracking_start_ordinal,
    directory.next_wakeup_due_at, directory.next_wakeup_prompt,
    directory.source_created_at, directory.source_updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.is_participant, viewer.unseen, viewer.waterline AS viewer_waterline,
    viewer.source_event_id AS viewer_event_id, pin.position AS pin_position
  FROM workspace_workstream_directory directory
  LEFT JOIN workspace_workstream_viewers viewer
    ON viewer.workstream_id = directory.workstream_id
   AND viewer.user_id = ?
   AND viewer.authority_generation = directory.authority_generation
  LEFT JOIN workspace_workstream_pins pin
    ON pin.workstream_id = directory.workstream_id AND pin.user_id = ?`;

export function applyWorkspaceDirectoryEnvelope(
  storage: DurableObjectStorage,
  envelope: WorkstreamRegionalEffectEnvelope,
  activeUsers: ReadonlySet<string>,
  originLabels: ReadonlyMap<string, string>,
): { changed: boolean; participantMembershipChanged: boolean } {
  return storage.transactionSync(() => {
    const receipt = storage.sql.exec<{ payload_hash: string }>(
      `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
      envelope.messageId,
    ).toArray()[0];
    if (receipt) {
      if (receipt.payload_hash !== envelope.payloadHash) {
        throw new Error("workspace_directory_effect_idempotency_conflict");
      }
      return { changed: false, participantMembershipChanged: false };
    }

    const now = Date.now();
    let changed = false;
    let participantMembershipChanged = false;
    if (envelope.effect.kind === "directory_common") {
      const current = storage.sql.exec<{
        authority_generation: number;
        waterline: number;
        payload_hash: string;
      }>(
        `SELECT authority_generation, waterline, payload_hash
           FROM workspace_workstream_directory WHERE workstream_id = ?`,
        envelope.workstreamId,
      ).toArray()[0];
      const applies = !current
        || envelope.generation > current.authority_generation
        || (envelope.generation === current.authority_generation
          && envelope.sourceVersion > current.waterline);
      if (current
        && envelope.generation === current.authority_generation
        && envelope.sourceVersion === current.waterline
        && envelope.payloadHash !== current.payload_hash) {
        throw new Error("workspace_directory_projection_version_conflict");
      }
      if (applies) {
        const effect = envelope.effect;
        const originLabel = effect.automationSubscriptionId
          ? originLabels.get(effect.automationSubscriptionId) ?? null
          : null;
        storage.sql.exec(
          `INSERT INTO workspace_workstream_directory
             (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
              title, description, preview, scope, exact_state, system_kind,
              last_activity_at, completed_at, archived_at, email_address,
              origin_type, origin_label, created_by_user_id,
              automation_subscription_id, automation_run_id, planned_for,
              title_status, latest_attention_ordinal,
              unread_tracking_start_ordinal, next_wakeup_due_at,
              next_wakeup_prompt, next_terminal_action_at, source_created_at,
              source_updated_at, projected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workstream_id) DO UPDATE SET
             authority_generation = excluded.authority_generation,
             waterline = excluded.waterline,
             source_event_id = excluded.source_event_id,
             payload_hash = excluded.payload_hash,
             title = excluded.title, description = excluded.description,
             preview = excluded.preview, scope = excluded.scope,
             exact_state = excluded.exact_state, system_kind = excluded.system_kind,
             last_activity_at = excluded.last_activity_at,
             completed_at = excluded.completed_at, archived_at = excluded.archived_at,
             email_address = excluded.email_address, origin_type = excluded.origin_type,
             origin_label = excluded.origin_label,
             created_by_user_id = excluded.created_by_user_id,
             automation_subscription_id = excluded.automation_subscription_id,
             automation_run_id = excluded.automation_run_id,
             planned_for = excluded.planned_for, title_status = excluded.title_status,
             latest_attention_ordinal = excluded.latest_attention_ordinal,
             unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
             next_wakeup_due_at = excluded.next_wakeup_due_at,
             next_wakeup_prompt = excluded.next_wakeup_prompt,
             next_terminal_action_at = excluded.next_terminal_action_at,
             source_created_at = excluded.source_created_at,
             source_updated_at = excluded.source_updated_at,
             projected_at = excluded.projected_at`,
          envelope.workstreamId,
          envelope.generation,
          envelope.sourceVersion,
          envelope.messageId,
          envelope.payloadHash,
          effect.title,
          effect.description,
          effect.preview,
          effect.scope,
          effect.state,
          effect.systemKind,
          epoch(effect.lastActivityAt),
          epoch(effect.completedAt),
          epoch(effect.archivedAt),
          effect.emailAddress ?? null,
          effect.originType ?? "ad_hoc",
          originLabel,
          effect.createdByUserId ?? null,
          effect.automationSubscriptionId ?? null,
          effect.automationRunId ?? null,
          epoch(effect.plannedFor),
          effect.titleStatus ?? "settled",
          effect.latestAttentionOrdinal ?? 0,
          effect.unreadTrackingStartOrdinal ?? 0,
          epoch(effect.nextWakeupDueAt),
          effect.nextWakeupPrompt ?? null,
          epoch(effect.nextTerminalActionAt),
          epoch(effect.createdAt ?? effect.lastActivityAt),
          epoch(effect.updatedAt ?? effect.lastActivityAt),
          now,
        );
        storage.sql.exec(
          `DELETE FROM workspace_workstream_resource_links WHERE workstream_id = ?`,
          envelope.workstreamId,
        );
        for (const link of effect.resourceLinks ?? []) {
          storage.sql.exec(
            `INSERT INTO workspace_workstream_resource_links
               (workstream_id, resource_id, watch_enabled, relationship_type,
                authority_generation, waterline, source_event_id, projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            envelope.workstreamId,
            link.resourceId,
            link.watchEnabled ? 1 : 0,
            link.relationshipType,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            now,
          );
          // This projection is the first workspace-authoritative proof that
          // the resource became canonical. Reservation release below is
          // separately fenced by its exact pending-input identity.
          storage.sql.exec(
            `UPDATE resources
                SET attachment_status = 'attached', updated_at = ?
              WHERE workspace_id = ? AND id = ?
                AND provider = 'avalon_upload' AND attachment_status = 'draft'`,
            new Date(now).toISOString(),
            envelope.workspaceId,
            link.resourceId,
          );
        }
        const projectedResourceIds = new Set(
          (effect.resourceLinks ?? []).map((link) => link.resourceId),
        );
        for (const release of effect.attachmentReservationReleases ?? []) {
          if (!projectedResourceIds.has(release.resourceId)) {
            throw new Error("attachment_reservation_release_missing_resource_link");
          }
          storage.sql.exec(
            `DELETE FROM pending_attachment_reservations
              WHERE workspace_id = ? AND workstream_id = ?
                AND input_id = ? AND resource_id = ?`,
            envelope.workspaceId,
            envelope.workstreamId,
            release.inputId,
            release.resourceId,
          );
        }
        changed = true;
      }
    } else if (envelope.effect.kind === "directory_user") {
      const effect = envelope.effect;
      const current = storage.sql.exec<{
        authority_generation: number;
        waterline: number;
        payload_hash: string;
        is_participant: number;
      }>(
        `SELECT authority_generation, waterline, payload_hash, is_participant
           FROM workspace_workstream_viewers WHERE workstream_id = ? AND user_id = ?`,
        envelope.workstreamId,
        effect.userId,
      ).toArray()[0];
      if (!activeUsers.has(effect.userId)) {
        const deleted = storage.sql.exec<{ is_participant: number }>(
          `DELETE FROM workspace_workstream_viewers
            WHERE workstream_id = ? AND user_id = ? RETURNING is_participant`,
          envelope.workstreamId,
          effect.userId,
        ).toArray()[0];
        changed = deleted !== undefined;
        participantMembershipChanged = deleted?.is_participant === 1;
      } else {
        const applies = !current
          || envelope.generation > current.authority_generation
          || (envelope.generation === current.authority_generation
            && envelope.sourceVersion > current.waterline);
        if (current
          && envelope.generation === current.authority_generation
          && envelope.sourceVersion === current.waterline
          && envelope.payloadHash !== current.payload_hash) {
          throw new Error("workspace_directory_viewer_version_conflict");
        }
        if (applies) {
          const wasParticipant = current?.is_participant === 1;
          storage.sql.exec(
            `INSERT INTO workspace_workstream_viewers
               (workstream_id, user_id, authority_generation, waterline,
                source_event_id, payload_hash, is_participant, participant_added_at,
                unread_count, you_are_mentioned,
                unseen, listable, seen_attention_ordinal, manual_unread_from_ordinal,
                manual_unread_generation, latest_mention_attention_ordinal,
                projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workstream_id, user_id) DO UPDATE SET
               authority_generation = excluded.authority_generation,
               waterline = excluded.waterline,
               source_event_id = excluded.source_event_id,
               payload_hash = excluded.payload_hash,
               is_participant = excluded.is_participant,
               participant_added_at = CASE
                 WHEN excluded.is_participant = 0 THEN NULL
                 ELSE COALESCE(
                   excluded.participant_added_at,
                   workspace_workstream_viewers.participant_added_at
                 )
               END,
               unread_count = excluded.unread_count,
               you_are_mentioned = excluded.you_are_mentioned,
               unseen = excluded.unseen,
               listable = excluded.listable,
               seen_attention_ordinal = excluded.seen_attention_ordinal,
               manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
               manual_unread_generation = excluded.manual_unread_generation,
               latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
               projected_at = excluded.projected_at`,
            envelope.workstreamId,
            effect.userId,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            envelope.payloadHash,
            effect.isParticipant ? 1 : 0,
            effect.isParticipant ? epoch(effect.participantAddedAt) : null,
            effect.unreadCount,
            effect.youAreMentioned ? 1 : 0,
            effect.unseen === true ? 1 : 0,
            effect.listable ? 1 : 0,
            effect.seenAttentionOrdinal ?? 0,
            effect.manualUnreadFromOrdinal ?? null,
            effect.manualUnreadGeneration ?? 0,
            effect.latestMentionAttentionOrdinal ?? 0,
            now,
          );
          changed = true;
          participantMembershipChanged = wasParticipant !== effect.isParticipant;
        }
      }
    }

    insertWorkstreamEffectReceipt(
      storage,
      envelope.messageId,
      envelope.workstreamId,
      envelope.payloadHash,
      now,
    );
    if (changed) advanceWorkspaceDirectoryVersion(storage, now);
    return { changed, participantMembershipChanged };
  });
}

export function listWorkspaceDirectory(
  storage: DurableObjectStorage,
  request: WorkspaceDirectoryListRequest,
): WorkspaceDirectoryPage {
  const cursor = request.before ? directoryCursor(request.before) : null;
  const rows = storage.sql.exec<WorkspaceDirectoryRow>(
    `${SELECT_WORKSPACE_DIRECTORY}
     WHERE directory.archived_at IS NULL AND pin.user_id IS NULL
       AND (directory.origin_type <> 'automation' OR directory.automation_exposed = 1)
       AND directory.exact_state NOT IN ('running', 'interrupting', 'preparing_context',
                                         'waiting_capacity')
       AND (? = 1 OR directory.system_kind IS NULL)
       AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       AND (? IS NULL OR directory.last_activity_at < ?
            OR (directory.last_activity_at = ? AND directory.workstream_id > ?))
     ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
    request.userId,
    request.userId,
    request.includeSystem ? 1 : 0,
    cursor?.lastActivityAt ?? null,
    cursor?.lastActivityAt ?? 0,
    cursor?.lastActivityAt ?? 0,
    cursor?.workstreamId ?? "",
    request.limit + 1,
  ).toArray();
  const hasMore = rows.length > request.limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? `${last.last_activity_at}:${last.workstream_id}`
    : null;
  if (!request.before) {
    const selected = new Set(rows.map((row) => row.workstream_id));
    const supplemental = [
      ...pinnedWorkspaceDirectoryRows(storage, request.userId, request.includeSystem),
      ...runningWorkspaceDirectoryRows(storage, request.userId, request.includeSystem),
    ];
    for (const row of supplemental) {
      if (selected.has(row.workstream_id)) continue;
      selected.add(row.workstream_id);
      rows.push(row);
    }
  }
  return {
    items: mapDirectoryWorkstreams(storage.sql, rows, request.workspaceId),
    stateVersions: rows.map(directoryStateVersion),
    nextCursor,
    directoryWaterline: workspaceDirectoryWaterline(storage),
  };
}

export function pinnedWorkspaceDirectoryRows(
  storage: DurableObjectStorage,
  userId: string,
  includeSystem: boolean,
): WorkspaceDirectoryRow[] {
  return storage.sql.exec<WorkspaceDirectoryRow>(
    `${SELECT_WORKSPACE_DIRECTORY}
     WHERE directory.archived_at IS NULL AND pin.user_id IS NOT NULL
       AND (directory.origin_type <> 'automation' OR directory.automation_exposed = 1)
       AND (? = 1 OR directory.system_kind IS NULL)
       AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
     ORDER BY pin.position, directory.workstream_id`,
    userId,
    userId,
    includeSystem ? 1 : 0,
  ).toArray();
}

/**
 * Running work streams are connection targets, not merely directory rows.
 * Return every visible one with the first page so an old active stream is
 * not hidden behind the recent-work cursor and omitted from socket prewarm.
 */
function runningWorkspaceDirectoryRows(
  storage: DurableObjectStorage,
  userId: string,
  includeSystem: boolean,
): WorkspaceDirectoryRow[] {
  return storage.sql.exec<WorkspaceDirectoryRow>(
    `${SELECT_WORKSPACE_DIRECTORY}
     WHERE directory.archived_at IS NULL
       AND (directory.origin_type <> 'automation' OR directory.automation_exposed = 1)
       AND directory.exact_state IN ('running', 'interrupting', 'preparing_context',
                                     'waiting_capacity')
       AND (? = 1 OR directory.system_kind IS NULL)
       AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
     ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
    userId,
    userId,
    includeSystem ? 1 : 0,
  ).toArray();
}

export function workspaceDirectoryVisible(
  storage: DurableObjectStorage,
  userId: string,
  workstreamId: string,
): boolean {
  return storage.sql.exec<{ one: number }>(
    `SELECT 1 AS one FROM workspace_workstream_directory directory
     LEFT JOIN workspace_workstream_viewers viewer
       ON viewer.workstream_id = directory.workstream_id
      AND viewer.user_id = ?
      AND viewer.authority_generation = directory.authority_generation
     WHERE directory.workstream_id = ? AND directory.archived_at IS NULL
       AND (directory.scope = 'workspace' OR viewer.is_participant = 1)`,
    userId,
    workstreamId,
  ).toArray().length === 1;
}

export function rewriteWorkspacePinOrder(
  storage: DurableObjectStorage,
  userId: string,
  requestedIds: string[],
  now: number,
): void {
  const current = storage.sql.exec<{ workstream_id: string }>(
    `SELECT workstream_id FROM workspace_workstream_pins
      WHERE user_id = ? ORDER BY position, workstream_id`,
    userId,
  ).toArray().map((row) => row.workstream_id);
  const pinned = new Set(current);
  const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
  const requestedSet = new Set(requested);
  const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
  for (const [position, workstreamId] of ordered.entries()) {
    storage.sql.exec(
      `UPDATE workspace_workstream_pins SET position = ?, updated_at = ?
        WHERE user_id = ? AND workstream_id = ?`,
      position,
      now,
      userId,
      workstreamId,
    );
  }
}

export function workspaceDirectoryWaterline(storage: DurableObjectStorage): number {
  return storage.sql.exec<{ waterline: number }>(
    `SELECT waterline FROM workspace_directory_state WHERE id = 1`,
  ).one().waterline;
}

export function advanceWorkspaceDirectoryVersion(storage: DurableObjectStorage, now: number): void {
  storage.sql.exec(
    `UPDATE workspace_directory_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
    now,
  );
}

/** The ceiling on how many work streams one person may pin. */
export const MAX_WORKSPACE_PINS_PER_USER = 1_000;

/**
 * Every future Terminal deadline this workspace's directory carries.
 *
 * Read by the RPC the scheduler calls and by the object's own terminal-alarm
 * reconciliation. One function so both see the same rows through the same
 * contract parse: the reconciliation used to reach the RPC for it, which meant
 * its mapping and its refusal of a corrupt row lived on the RPC's side of a
 * seam that no longer exists.
 */
export function workspaceTerminalScheduleTargets(
  storage: DurableObjectStorage,
): WorkspaceDirectoryScheduleTargetsResult {
  const rows = storage.sql.exec<{
    kind: "wakeup" | "terminal";
    workstream_id: string;
    due_at: number;
  }>(
    `SELECT 'terminal' AS kind, workstream_id, next_terminal_action_at AS due_at
       FROM workspace_workstream_directory
      WHERE archived_at IS NULL AND next_terminal_action_at IS NOT NULL
     ORDER BY due_at, workstream_id`,
  ).toArray();
  return WorkspaceDirectoryScheduleTargetsResultSchema.parse({
    items: rows.map((row) => ({
      kind: row.kind,
      workstreamId: row.workstream_id,
      dueAt: iso(row.due_at),
    })),
  });
}
