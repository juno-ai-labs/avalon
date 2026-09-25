import { z } from "zod";

import type { ScheduledAlarmStore } from "./scheduled-alarms";
import {
  HostedParticipantProjectionAlarmSchema,
  PARTICIPANT_MIGRATION_ALARM,
  PARTICIPANT_PROJECTION_ALARM,
  ParticipantProjectionDeliverySchema,
  participantMigrationAlarmKey,
  participantProjectionAlarmKey,
} from "./scope-grant-storage";
import { SCOPE_INVITATION_DELIVERY_ALARM, scopeInvitationAlarmKey } from "./scope-invitation-storage";

/**
 * Moving one legacy `WorkstreamDO` or `SpaceDO` into the Organization object.
 *
 * The legacy object exports every row it holds in one transaction and freezes
 * itself; this module writes those rows under the parent id, also in one
 * transaction. `docs/hosted-conversation-parents.md` owns the procedure and the
 * table map; this file owns the column-level mapping.
 */

const SqlValueSchema = z.union([z.string(), z.number(), z.null()]);
const LegacyRowSchema = z.record(z.string(), SqlValueSchema);
export type LegacyRow = z.infer<typeof LegacyRowSchema>;

export const LegacyParentExportSchema = z.strictObject({
  /** False for an object that never held a parent: nothing to import. */
  found: z.boolean(),
  parentId: z.string().nullable(),
  tables: z.record(z.string(), z.array(LegacyRowSchema)),
});
export type LegacyParentExport = z.infer<typeof LegacyParentExportSchema>;

/**
 * The legacy tables the export carries, in dependency order. What is left out
 * is left out on purpose: the child-effect receipts (a replay older than the
 * import converges on the per-key waterlines, which is the rule the legacy
 * receipts fell back to past their own retention), socket ticket receipts
 * (every socket reconnects), the dead grant-delivery table, and the alarm rows
 * (rebuilt below from the rows they were derived from).
 */
export const LEGACY_PARENT_EXPORT_TABLES = [
  "workstream_metadata",
  "conversation_children",
  "substream_directory",
  "substream_user_directory",
  "projection_keys",
  "workstream_state_clock",
  "workstream_state_changes",
  "durable_outbox",
  "private_child_preparations",
  "private_child_memberships",
  "private_child_membership_effects",
  "scope_grant_revision",
  "scope_grants",
  "scope_grant_operations",
  "scope_grant_imports",
  "participant_projection_targets",
  "participant_projection_deliveries",
  "main_participant_migration",
  "child_participant_migrations",
  "scope_invitation_operations",
  "scope_invitations",
  "connector_participant_admissions",
  "workstream_sidekick_attachments",
  "workstream_direct_audience",
  "workstream_space_access_sources",
  "workstream_space_supplied_readers",
  "workstream_access_operations",
] as const;

interface TableMapping {
  legacy: (typeof LEGACY_PARENT_EXPORT_TABLES)[number];
  hosted: string;
  /** Hosted column → the value from one legacy row. `parent_id` is added by the caller. */
  columns: Record<string, (row: LegacyRow) => SqlStorageValue>;
}

function column(name: string): (row: LegacyRow) => SqlStorageValue {
  return (row) => {
    if (!(name in row)) throw new Error(`parent_import_column_missing:${name}`);
    return row[name] ?? null;
  };
}

function columns(...names: string[]): Record<string, (row: LegacyRow) => SqlStorageValue> {
  return Object.fromEntries(names.map((name) => [name, column(name)]));
}

/**
 * One entry per legacy table, in the order the rows must be written: children
 * before the rows that reference them, and breakout members before the
 * participant migrations whose freeze triggers would refuse them.
 */
function tableMappings(kind: "workstream" | "space"): TableMapping[] {
  return [
    {
      legacy: "workstream_metadata",
      hosted: "parent_metadata",
      columns: {
        parent_kind: () => kind,
        ...columns("workspace_id", "region", "authority_generation", "revision", "title", "description",
          "preview", "email_address", "scope", "exact_state", "created_by_user_id", "title_status", "system_kind",
          "last_activity_at", "completed_at", "archived_at", "latest_attention_ordinal",
          "unread_tracking_start_ordinal", "next_wakeup_due_at", "next_wakeup_prompt", "next_terminal_action_at",
          "source_created_at", "source_updated_at", "created_at", "updated_at"),
      },
    },
    {
      legacy: "conversation_children",
      hosted: "parent_children",
      columns: columns("substream_id", "kind", "created_by_user_id", "created_at", "status", "title", "updated_at",
        "archived_at", "lifecycle_version", "lifecycle_delivered_version", "lifecycle_not_before", "audience"),
    },
    {
      legacy: "substream_directory",
      hosted: "parent_child_projections",
      columns: columns("substream_id", "source_version", "payload_hash", "effect_json", "updated_at"),
    },
    {
      legacy: "substream_user_directory",
      hosted: "parent_child_viewer_projections",
      columns: columns("substream_id", "user_id", "source_version", "payload_hash", "effect_json", "updated_at"),
    },
    {
      legacy: "projection_keys",
      hosted: "parent_projection_keys",
      columns: columns("projection_key", "next_version", "last_payload_hash", "updated_at"),
    },
    {
      legacy: "workstream_state_clock",
      hosted: "parent_state_clock",
      columns: columns("next_sequence", "last_event_time"),
    },
    {
      legacy: "workstream_state_changes",
      hosted: "parent_state_changes",
      columns: columns("sequence", "state_key", "waterline", "event_id", "payload_hash", "state_json", "occurred_at"),
    },
    {
      legacy: "durable_outbox",
      hosted: "parent_outbox",
      // A row the legacy object had in flight comes back pending: it may have
      // reached the Queue, and a second delivery is fenced by the directory's
      // waterline and the regional effects' receipts.
      columns: {
        ...columns("message_id", "partition_key", "source_version", "source_epoch", "effect_kind", "payload_json",
          "payload_hash", "attempts", "created_at"),
        state: () => "pending",
        not_before: () => 0,
      },
    },
    {
      legacy: "private_child_preparations",
      hosted: "parent_breakout_preparations",
      columns: columns("operation_id", "substream_id", "creator_user_id", "request_json", "capture_json",
        "completed_parts_json", "prepared_context_json", "status", "error_code", "created_at", "updated_at",
        "prepared_conversation_hash"),
    },
    {
      legacy: "private_child_memberships",
      hosted: "parent_breakout_members",
      columns: columns("substream_id", "user_id", "active", "version", "added_by_user_id", "added_at", "removed_at",
        "updated_at"),
    },
    {
      legacy: "private_child_membership_effects",
      hosted: "parent_breakout_member_effects",
      columns: {
        ...columns("operation_id", "substream_id", "user_id", "actor_user_id", "active", "membership_version",
          "attempts", "created_at"),
        state: (row) => row.state === "delivered" ? "delivered" : "pending",
        not_before: () => 0,
      },
    },
    { legacy: "scope_grant_revision", hosted: "parent_grant_revision", columns: columns("revision") },
    {
      legacy: "scope_grants",
      hosted: "parent_grants",
      columns: columns("user_id", "scope_kind", "substream_id", "grant_json", "source_kind", "source_id"),
    },
    {
      legacy: "scope_grant_operations",
      hosted: "parent_grant_operations",
      columns: columns("operation_id", "request_json", "result_json", "created_at"),
    },
    {
      legacy: "scope_grant_imports",
      hosted: "parent_grant_imports",
      columns: columns("scope_kind", "substream_id", "request_json", "result_json"),
    },
    {
      legacy: "participant_projection_targets",
      hosted: "parent_participant_targets",
      columns: columns("substream_id", "transfer_id"),
    },
    {
      legacy: "participant_projection_deliveries",
      hosted: "parent_participant_deliveries",
      columns: columns("substream_id", "user_id", "revision", "payload_json", "acknowledged_revision"),
    },
    {
      legacy: "main_participant_migration",
      hosted: "parent_participant_migrations",
      columns: { substream_id: () => "0", ...columns("transfer_id", "incarnations_json", "phase") },
    },
    {
      legacy: "child_participant_migrations",
      hosted: "parent_participant_migrations",
      columns: { ...columns("substream_id", "transfer_id", "phase"), incarnations_json: () => null },
    },
    {
      legacy: "scope_invitation_operations",
      hosted: "parent_invitation_operations",
      columns: columns("operation_id", "request_json", "invitation_ids_json"),
    },
    {
      legacy: "scope_invitations",
      hosted: "parent_invitations",
      columns: columns("id", "operation_id", "actor_user_id", "actor_incarnation", "summary_json", "token_hash",
        "delivery_encrypted", "grant_operations_json", "delivered_at", "accepted_incarnation", "created_at"),
    },
    {
      legacy: "connector_participant_admissions",
      hosted: "parent_connector_admissions",
      columns: columns("event_id", "request_json"),
    },
    {
      legacy: "workstream_sidekick_attachments",
      hosted: "parent_sidekicks",
      columns: columns("sidekick_id", "attached_at"),
    },
    { legacy: "workstream_direct_audience", hosted: "parent_direct_audience", columns: columns("scope", "updated_at") },
    {
      legacy: "workstream_space_access_sources",
      hosted: "parent_space_sources",
      columns: columns("space_id", "scope", "participants_json", "space_revision", "membership_generation",
        "operation_id", "applied_at", "updated_at"),
    },
    {
      legacy: "workstream_space_supplied_readers",
      hosted: "parent_space_readers",
      columns: columns("space_id", "user_id"),
    },
    {
      legacy: "workstream_access_operations",
      hosted: "parent_access_operations",
      columns: columns("operation_id", "request_json", "result_json", "created_at"),
    },
  ];
}

export interface ParentImportResult {
  rows: number;
  /** False when the legacy object held no parent; the ledger row is closed either way. */
  found: boolean;
}

/**
 * Write one exported parent under its id and close its ledger row.
 *
 * Synchronous and one transaction, so the ledger says `imported` exactly when
 * every row is here. A second call for the same parent is refused by the
 * ledger rather than merged, because the first one already moved everything.
 */
export function importLegacyParent(
  storage: DurableObjectStorage,
  alarms: ScheduledAlarmStore,
  parentId: string,
  kind: "workstream" | "space",
  exported: LegacyParentExport,
  now: number,
): ParentImportResult {
  const data = LegacyParentExportSchema.parse(exported);
  if (data.found && data.parentId !== parentId) throw new Error("parent_import_identity_mismatch");
  return storage.transactionSync(() => {
    const ledger = storage.sql.exec<{ state: string }>(
      "SELECT state FROM parent_imports WHERE parent_id = ?", parentId,
    ).toArray()[0];
    if (ledger?.state === "imported") return { rows: 0, found: data.found };
    if (storage.sql.exec("SELECT 1 FROM parent_metadata WHERE parent_id = ?", parentId).toArray().length > 0) {
      throw new Error("parent_import_target_not_empty");
    }
    let rows = 0;
    if (data.found) {
      for (const mapping of tableMappings(kind)) {
        for (const row of data.tables[mapping.legacy] ?? []) {
          const names = ["parent_id", ...Object.keys(mapping.columns)];
          const values = [parentId, ...Object.values(mapping.columns).map((read) => read(row))];
          storage.sql.exec(
            `INSERT INTO ${mapping.hosted} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
            ...values,
          );
          rows += 1;
        }
      }
      rescheduleImportedWork(storage.sql, alarms, parentId, now);
    }
    storage.sql.exec(
      `INSERT INTO parent_imports (parent_id, parent_kind, state, source_rows, imported_at)
       VALUES (?, ?, 'imported', ?, ?)
       ON CONFLICT (parent_id) DO UPDATE SET state = 'imported', source_rows = excluded.source_rows,
         imported_at = excluded.imported_at, last_error_code = NULL`,
      parentId, kind, rows, now,
    );
    return { rows, found: data.found };
  });
}

/**
 * The legacy object's alarms, derived again from the rows they were derived
 * from: an undelivered participant projection, a pending participant
 * migration, and an invitation email not yet sent.
 */
function rescheduleImportedWork(sql: SqlStorage, alarms: ScheduledAlarmStore, parentId: string, now: number): void {
  for (const row of sql.exec<{ payload_json: string }>(
    `SELECT payload_json FROM parent_participant_deliveries
      WHERE parent_id = ? AND acknowledged_revision IS NULL`,
    parentId,
  ).toArray()) {
    const delivery = ParticipantProjectionDeliverySchema.parse(JSON.parse(row.payload_json));
    alarms.schedule({
      kind: PARTICIPANT_PROJECTION_ALARM,
      key: participantProjectionAlarmKey(parentId, delivery.substreamId, delivery.projection.userId,
        delivery.projection.revision),
      dueAt: now,
      payload: JSON.stringify(HostedParticipantProjectionAlarmSchema.parse({ parentId, delivery })),
    }, now);
  }
  for (const row of sql.exec<{ substream_id: string }>(
    "SELECT substream_id FROM parent_participant_migrations WHERE parent_id = ? AND phase = 'pending'", parentId,
  ).toArray()) {
    alarms.schedule({ kind: PARTICIPANT_MIGRATION_ALARM, key: participantMigrationAlarmKey(parentId, row.substream_id),
      dueAt: now }, now);
  }
  for (const row of sql.exec<{ id: string }>(
    `SELECT id FROM parent_invitations
      WHERE parent_id = ? AND delivered_at IS NULL AND json_extract(summary_json, '$.status') = 'pending'`,
    parentId,
  ).toArray()) {
    alarms.schedule({ kind: SCOPE_INVITATION_DELIVERY_ALARM, key: scopeInvitationAlarmKey(parentId, row.id),
      dueAt: now }, now);
  }
}

/** Record that a parent still lives in a legacy object, unless the ledger already knows it. */
export function notePendingParentImport(sql: SqlStorage, parentId: string, kind: "workstream" | "space"): void {
  sql.exec(
    `INSERT INTO parent_imports (parent_id, parent_kind, state) VALUES (?, ?, 'pending')
     ON CONFLICT (parent_id) DO NOTHING`,
    parentId, kind,
  );
}

/** The ledger's answer for one parent: whether a legacy object still holds it. */
export function parentImportState(sql: SqlStorage, parentId: string): "pending" | "imported" | null {
  const row = sql.exec<{ state: "pending" | "imported" }>(
    "SELECT state FROM parent_imports WHERE parent_id = ?", parentId,
  ).toArray()[0];
  return row?.state ?? null;
}

/** Pending parents due for a background import, oldest attempt first. */
export function dueParentImports(sql: SqlStorage, now: number, limit: number): Array<{
  parentId: string; kind: "workstream" | "space";
}> {
  return sql.exec<{ parent_id: string; parent_kind: "workstream" | "space" }>(
    `SELECT parent_id, parent_kind FROM parent_imports
      WHERE state = 'pending' AND not_before <= ? ORDER BY not_before, parent_id LIMIT ?`,
    now, limit,
  ).toArray().map((row) => ({ parentId: row.parent_id, kind: row.parent_kind }));
}

export function nextParentImportDueAt(sql: SqlStorage): number | null {
  return sql.exec<{ due_at: number | null }>(
    "SELECT MIN(not_before) AS due_at FROM parent_imports WHERE state = 'pending'",
  ).toArray()[0]?.due_at ?? null;
}

/**
 * A failed import backs off and names why. The schedule is the activity
 * Queue's own retry (5 s doubling to 300 s, `workstream-durable-object.md`'s
 * failure table) rather than a new number: an import is retried for the reasons
 * a Queue delivery is, a legacy object that is briefly unreachable.
 */
export function deferParentImport(sql: SqlStorage, parentId: string, errorCode: string, now: number): void {
  sql.exec(
    `UPDATE parent_imports
        SET attempts = attempts + 1,
            not_before = ? + MIN(300000, 5000 * (1 << MIN(attempts, 6))),
            last_error_code = ?
      WHERE parent_id = ? AND state = 'pending'`,
    now, errorCode.slice(0, 200), parentId,
  );
}
