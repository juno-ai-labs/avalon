/**
 * The WorkspaceDO SQLite migration list, kept out of `workspace-do.ts` so a
 * Worker graph that only needs the list (the migration-command consumer reads
 * its head version) does not load the whole Durable Object.
 */
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";
import { WORKSPACE_PRODUCT_SCHEMA_STATEMENTS } from "./workspace-product-schema";
import { SLACK_REACTION_COLUMN_STATEMENTS, WORKSPACE_DOMAIN_SCHEMA_STATEMENTS, workspaceIdentityFencesFor } from "./workspace-domain-schema";
import { SCHEDULED_ALARM_SCHEMA_STATEMENTS } from "./scheduled-alarms";
import { RESOURCE_SEARCH_MIGRATION_STATEMENTS, RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION, RESOURCE_SEARCH_AUDIENCE_MIGRATION } from './resource-search-projection';
import { ONBOARDING_JOURNEY_SQL } from './onboarding-journey';
import { AUTHORIZATION_STORAGE_MIGRATION, SPACE_MERGE_EMBED_LINKS_MIGRATION } from './authorization-storage';
import { OBJECT_RETIREMENT_SCHEMA_STATEMENTS } from "./object-retirement";
import { MEMORY_SEARCH_KEY_PURGE_MIGRATION, SEARCH_AUTHORIZATION_PUSH_MIGRATION } from './search-authorization-projection';
import { MEETING_NOTES_FINALIZATION_MIGRATION, MEETING_NOTES_RETIREMENT_MIGRATION } from "./meeting-notes-retirement";
import { AGENT_TEAM_SCHEMA } from "./agent-team-storage";
import { SCOPE_GRANT_DIRECTORY_SCHEMA } from "./scope-grant-directory";
import { CHANNEL_COLOR_SYNC_MIGRATION, CHANNEL_MESSAGE_SEARCH_MIGRATION, CHANNEL_RAIL_MIGRATION, CONVERSATION_ACCESS_REQUESTS_MIGRATION, SPACE_INDIVIDUAL_SCOPE_MIGRATION, SPACE_INVITEES_MIGRATION, SPACE_MESSAGE_MERGES_MIGRATION, SPACE_MESSAGES_MIGRATION, SPACE_PUBLIC_ONLY_MIGRATION, SPACE_VIEWER_JOINED_AT_MIGRATION, WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS, WORKSPACE_CHANNEL_READS_MIGRATION, WORKSPACE_PINNED_ORDER_MIGRATION, WORKSPACE_SPACE_SCHEMA_STATEMENTS, SUGGESTION_BACKFILL_MIGRATION, THREAD_BACKFILL_MIGRATION, THREAD_BACKFILL_RESUME_MIGRATION, IMPORT_RESERVATION_RECLAIM_MIGRATION, WORKSPACE_ACTIVITY_PUSH_MIGRATION, WORKSPACE_ACTIVITY_READS_MIGRATION, WORKSPACE_PEOPLE_RANKING_MIGRATION, WORKSPACE_REPLY_ALERT_MIGRATION, THREAD_ERA_PARENTS_DROP_MIGRATION, THREAD_ERA_TABLES_DROP_MIGRATION } from "./retired-workspace-schema";
import { HOSTED_PARENT_SCHEMA_STATEMENTS } from "./hosted-parent-schema";
import { EXTERNAL_CONVERSATION_BINDINGS_MIGRATION, EXTERNAL_BINDING_SPACE_MATCHED_MIGRATION } from "./workspace-external-binding-storage";
import { SIDEKICK_CONVERSATION_ATTACHMENT_SCHEMA_STATEMENTS } from "./workspace-sidekick-conversation-storage";
import { WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION } from "./personal-system-prompt";
import { WORKSPACE_MEMBER_PREFERENCES_MIGRATION, WORKSPACE_MEMBER_PUSH_PREFERENCES_MIGRATION, WORKSPACE_MEMBER_NOTIFY_PREFERENCES_MIGRATION } from "./member-preferences";
import { HOSTED_SIDEKICK_SCHEMA_STATEMENTS, SIDEKICK_REVIEW_SCHEMA_STATEMENTS, SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS, SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS, SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS, SIDEKICK_RUN_SEED_DROP_STATEMENTS } from "./hosted-sidekick-schema";
import { WORKSPACE_ARTIFACT_PINS_MIGRATION, RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE, WORKSPACE_ARTIFACT_UPDATES_MIGRATION, WORKSPACE_PINS_MIGRATION } from "./workspace-pin-storage";
import { WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION } from "./workspace-resource-versions";
import { MEMORY_FACTS_MIGRATION } from "./workspace-memory-facts-storage";
import { MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION, MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION, MEMORY_DIGEST_SYNC_MIGRATION, MEMORY_DIGEST_CANVAS_ARCHIVE_TRIGGER } from "./memory-digest-sync";
import { CONNECTOR_EVENT_PEOPLE_MIGRATION } from "./connector-event-people";
import { WORKSPACE_CONVERSATION_VIEW_MIGRATION } from "./workspace-conversation-view";
import { SIDEKICK_DELEGATION_SCHEMA_STATEMENTS } from "./sidekick-delegation-storage";
import { SIDEKICK_SOURCE_CONNECTION_SCHEMA_STATEMENTS } from "./sidekick-source-registrations";
import { CANVAS_ARCHIVE_STATEMENTS, CANVAS_ARTIFACTS_STATEMENTS, CANVAS_SCHEMA_STATEMENTS, CANVAS_SIDEKICK_PINS_STATEMENTS, SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS, SIDEKICK_CANVAS_ATTACHMENT_STATEMENTS, RETIREMENT_GRAPH_CANVAS_MIGRATION } from "./canvas-schema";
import { CANVAS_ACCESS_REQUESTS_STATEMENTS } from "./canvas-access-requests";
import { NOTIFICATION_INTENTS_CANVAS_SIDEKICK_KINDS_MIGRATION } from "./workspace-notification-intent-storage";
import { WORKSPACE_ACTIVITY_SCHEMA_STATEMENTS } from "./workspace-activity";
import { SIDEKICK_SOURCE_SCHEMA_STATEMENTS } from "./sidekick-source-storage";
import { SIDEKICK_SOURCE_NOTICE_SCHEMA_STATEMENTS } from "./sidekick-source-notices";
import { CANVAS_ARTIFACT_ACCESS_STATEMENTS } from './canvas-artifact-access';
import { CANVAS_SHARING_DEFAULTS_STATEMENTS } from "./canvas-sharing-defaults";
import { CANVAS_NOTICES_SCHEMA_STATEMENTS } from "./canvas-notices";
import { CANVAS_SHARE_FEDERATION_STATEMENTS } from './canvas-share-federation';
import { CANVA_RETIREMENT_MIGRATION } from "./canva-retirement";
import { GENERIC_WEBHOOK_RETIREMENT_MIGRATION } from "./generic-webhook-retirement";

/**
 * Every table emptied when `projects` is dropped: four cascade from it
 * directly, and two more cascade from `project_default_resources` beneath it.
 * Ordered parents-first so the list can be replayed as inserts.
 */
export const PROJECT_CASCADE_DEPENDENTS = [
  "project_participants",
  "workspace_project_order",
  "project_workstream_memberships",
  "project_default_resources",
  "project_default_resource_targets",
  "project_default_resource_publications",
] as const;

/**
 * Retire Projects: settle every undelivered effect, then drop the tables.
 *
 * Two steps in one transaction, and the order is the whole point.
 *
 * **Invalidate.** Every unsettled default target becomes `terminal` with
 * `project_retired` on it, and every unaccepted publication is accepted. Those
 * rows are the durable half of an at-least-once delivery; a Queue message
 * naming one may still be in flight, and what stops it writing into a Channel
 * whose audience the cutover has just changed is that the consumer finds
 * nothing current. The consumer leg stays for the platform's retry window and
 * acknowledges every redelivery as a tombstone.
 *
 * **Drop.** Children before parents, because `PRAGMA foreign_keys = OFF` is
 * silently a no-op once anything in the same Durable Object event has touched
 * SQLite (`docs/durable-object-sqlite.md`), so a parent dropped first would
 * cascade its children away and hide whichever of them still held rows.
 *
 * **There is no barrier in between, and there cannot be one.** This shipped
 * with a scratch table whose CHECK asserted that no `pending` row was left —
 * counted after the statements above had just settled every one of them, so
 * the count was zero by construction and the assertion could only ever pass.
 * A barrier that reads its own writes is not a gate. The PRD's "zero unsettled
 * Project effects" is met by the invalidation plus the tombstone consumer
 * rather than by an assertion: an undelivered Project default is *dropped*,
 * which is what PRD non-goal 5 asks for — Projects are deleted rather than
 * converted, so a default that never reached a Channel is not owed to anybody.
 *
 * Applied Channel state is untouched. A resource a Project delivered is
 * attached to the Channel's own authority, and this deletes the Organization's
 * record of *why* it was delivered, never the attachment.
 */
export const PROJECT_RETIREMENT_STATEMENTS: readonly string[] = [
  `UPDATE project_default_resource_targets
      SET state = 'terminal', last_error_code = 'project_retired',
          updated_at = unixepoch() * 1000
    WHERE state = 'pending'`,
  `UPDATE project_default_resource_publications
      SET state = 'accepted', accepted_at = unixepoch() * 1000,
          updated_at = unixepoch() * 1000
    WHERE state = 'pending'`,
  ...[...PROJECT_CASCADE_DEPENDENTS].reverse().map((table) => `DROP TABLE ${table}`),
  `DROP TABLE workspace_project_state`,
  `DROP TABLE projects`,
];

/**
 * Palette snapshots, frozen per migration.
 *
 * A CHECK vocabulary is baked into the text of the statement that created the
 * table, so interpolating a live constant here means editing already-shipped
 * SQL every time the palette moves: objects created before the edit keep the
 * old vocabulary, objects created after get the new one, and nothing records
 * that they diverged. Each migration therefore pins the list as it stood when
 * that migration shipped, and widening the vocabulary is a new migration.
 *
 * `workspace-project-palette.test.ts` asserts the newest snapshot still covers
 * `PROJECT_COLOR_KEYS_STORABLE`, so adding a colour without a migration fails
 * the build rather than the insert.
 */
export const PROJECT_COLOR_KEYS_AT_V14 = [
  "gray", "brown", "red", "orange", "yellow", "green",
  "teal", "cyan", "blue", "indigo", "purple", "pink",
] as const;

/**
 * Icons as they stood at v14, which is also how they stand at v45 — the set has
 * never changed. Pinned for the same reason the colours are: a CHECK vocabulary
 * lives in shipped SQL text and must stop moving when the live constant does.
 */
export const PROJECT_ICON_KEYS_FROZEN = [
  "briefcase", "target", "calendar-days", "list-checks", "clipboard-list",
  "file-text", "folder", "lightbulb", "star", "flag",
  "rocket", "chart-no-axes-combined", "calculator", "coins", "users",
  "user-search", "handshake", "megaphone", "palette", "image",
  "pen-tool", "package", "building-2", "globe-2", "heart",
] as const;

/**
 * The v14 twelve, plus the hue ring that replaced them and the `black` the
 * account accents took. This is what migration 45 builds its CHECK from; see
 * the snapshot rationale on `PROJECT_COLOR_KEYS_AT_V14`.
 */
export const PROJECT_COLOR_KEYS_AT_V45 = [
  "black", "rose", "red", "orange", "amber", "lime", "green", "emerald",
  "cyan", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "gray", "brown", "yellow", "teal",
] as const;

export function projectRegistrySql(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

/**
 * The workspace-identity guards on `automation_directory`.
 *
 * Shared with the v26 rebuild, which drops the table and drops these with it.
 * Recreating them there by hand is what left every upgraded object without the
 * guard while a fresh one kept it — two schemas in one fleet, and the only
 * thing standing between a cross-workspace directory row and the serving path
 * gone on every object that had ever run.
 *
 * Byte-identical to what the base migration shipped, because a migration
 * statement is hashed verbatim into `_sql_schema_migrations`: re-indenting them
 * here would make every deployed object refuse to boot.
 */
export function automationDirectoryWorkspaceIdentityGuards(): string[] {
  return [
    `CREATE TRIGGER automation_directory_workspace_identity_insert
      BEFORE INSERT ON automation_directory
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER automation_directory_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON automation_directory
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ];
}

/**
 * Frozen inventory through v53 of tables a `DROP TABLE connector_connections` would take with
 * it — twelve that cascade and `connector_oauth_attempts`, whose connection
 * pointer would be nulled. Migration 31 copies each one out and back around
 * the parent's replacement.
 *
 * A list rather than a query over `sqlite_schema`: a migration's statements are
 * hashed into every object's receipt, so what it does has to be decided in
 * source rather than by whatever an individual database happens to hold.
 * Do not extend this historical list: v54 adds connector_installations with
 * a non-cascading foreign key. A later parent rebuild must declare a new
 * inventory including it, without changing v31/v53 statement fingerprints.
 */
export const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53 = [
  "connector_oauth_attempts",
  "slack_agent_contexts",
  "slack_agent_feedback",
  "slack_agent_pending_prompts",
  "slack_agent_policies",
  "slack_agent_sessions",
  "slack_agent_thread_claims",
  "slack_delivery_preferences",
  "slack_ingress_jobs",
  "slack_link_challenges",
  "slack_unfurled_links",
  "slack_user_links",
  "webhook_receipts",
] as const;

/**
 * The same inventory as of v55, which is the first parent rebuild after v54
 * added `connector_installations`.
 *
 * Two things make it a separate constant rather than an edit to the list above.
 * A migration's statements are hashed into every deployed object's receipt, so
 * changing v31's or v53's text would invalidate receipts that already committed.
 * And `connector_installations` behaves differently from the other thirteen:
 * its foreign key carries no `ON DELETE` action, so the implicit `DELETE` inside
 * `DROP TABLE connector_connections` does not empty it — it *aborts the drop*.
 * Migration 55 therefore empties every dependent explicitly before replacing the
 * parent, rather than letting the cascade do it, which is the one way the recipe
 * differs from 53's.
 *
 * A table missing from this list loses its rows. The next parent rebuild
 * declares its own inventory again, from the schema as of that version.
 */
export const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53,
  "connector_installations",
] as const;

/**
 * Every table that cascades from `memory_scopes`, parent-first, so a restore
 * in this order never inserts a child before its parent. The last three reach
 * the scope through `memory_tables` and `memory_table_rows` rather than
 * directly, and would be emptied all the same.
 */
export const MEMORY_SCOPE_DEPENDENTS = [
  "memory_items",
  "memory_mutations",
  "memory_index_outbox",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_cells",
  "memory_table_mutations",
] as const;

// Frozen v121 inventory: migrations 63–120 add no connector foreign keys.
export const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55,
] as const;

// Frozen v62 inventory: migrations 56–61 add no connector foreign keys.
export const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55,
] as const;

/**
 * The version-capture triggers as migration 112 left them, named so migration
 * 113 can drop and restore them around the cause columns it replaces: SQLite
 * refuses to drop a column a trigger reads.
 */
export const RESOURCES_CREATE_INITIAL_VERSION_V112 = `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind, on_behalf_of_user_id)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at,
            NEW.revision_author_kind, NEW.revision_author_run_id, NEW.revision_author_user_id,
            NEW.revision_author_connection_id, NEW.revision_cause,
            NEW.revision_storage_kind, NEW.revision_on_behalf_of_user_id);
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object',
                revision_on_behalf_of_user_id = NULL
          WHERE id = NEW.id;
       END`;

export const RESOURCES_CREATE_SEMANTIC_VERSION_V112 = `CREATE TRIGGER resources_create_semantic_version
       AFTER UPDATE OF connection_id, resource_type, provider, provider_resource_id, title,
         mime_type, content_ref, canonical_url, metadata_json, last_hydrated_at,
         uploaded_by_user_id, attachment_status, content_sha256 ON resources
       WHEN NEW.current_version = OLD.current_version BEGIN
         UPDATE resources SET current_version = OLD.current_version + 1 WHERE id = NEW.id;
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind, on_behalf_of_user_id)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at,
                revision_author_kind, revision_author_run_id, revision_author_user_id,
                revision_author_connection_id, revision_cause, revision_storage_kind,
                revision_on_behalf_of_user_id
           FROM resources WHERE id = NEW.id;
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object',
                revision_on_behalf_of_user_id = NULL
          WHERE id = NEW.id;
       END`;

export const WORKSPACE_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workspace control-plane authority and realtime synchronization",
  statements: [
    `CREATE TABLE workspace_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      placement_affinity TEXT NOT NULL CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE workspace_sync_events (
      waterline INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      topics_json TEXT NOT NULL CHECK (json_valid(topics_json) AND length(topics_json) <= 4096),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT`,
    `CREATE TABLE workspace_connector_events (
      event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL CHECK (
        substr(payload_hash, 1, 7) = 'sha256:' AND length(payload_hash) = 71
        AND substr(payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      connection_id TEXT NOT NULL,
      connection_scope TEXT NOT NULL CHECK (connection_scope IN ('personal', 'workspace')),
      connection_owner_user_id TEXT,
      connector_type TEXT NOT NULL CHECK (length(connector_type) BETWEEN 1 AND 120),
      provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
      provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 1000),
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
      resource_type TEXT CHECK (resource_type IS NULL OR length(resource_type) <= 200),
      provider_resource_id TEXT CHECK (provider_resource_id IS NULL OR length(provider_resource_id) <= 2000),
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND length(actor_json) <= 262144),
      subject_json TEXT NOT NULL CHECK (json_valid(subject_json) AND length(subject_json) <= 262144),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      received_at INTEGER NOT NULL CHECK (received_at >= 0),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
      summary TEXT NOT NULL CHECK (length(summary) <= 65536),
      text_snippet TEXT NOT NULL CHECK (length(text_snippet) <= 4000),
      payload_ref TEXT CHECK (payload_ref IS NULL OR length(payload_ref) <= 2000),
      visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json) AND length(visibility_json) <= 262144),
      target_user_ids_json TEXT NOT NULL CHECK (json_valid(target_user_ids_json) AND length(target_user_ids_json) <= 262144),
      entity_keys_json TEXT NOT NULL CHECK (json_valid(entity_keys_json) AND length(entity_keys_json) <= 262144),
      dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 1000),
      raw_content_hash TEXT CHECK (raw_content_hash IS NULL OR length(raw_content_hash) <= 256),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 524288),
      external_people_json TEXT NOT NULL CHECK (json_valid(external_people_json) AND length(external_people_json) <= 262144),
      processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
      processing_attempt INTEGER NOT NULL DEFAULT -1 CHECK (processing_attempt BETWEEN -1 AND 5),
      workflow_instance_id TEXT CHECK (workflow_instance_id IS NULL OR length(workflow_instance_id) BETWEEN 1 AND 100),
      claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
      processed_at INTEGER CHECK (processed_at IS NULL OR processed_at >= 0),
      processing_error TEXT CHECK (processing_error IS NULL OR length(processing_error) <= 1000),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (connection_scope = 'personal' AND connection_owner_user_id IS NOT NULL)
        OR (connection_scope = 'workspace' AND connection_owner_user_id IS NULL)
      ),
      UNIQUE(connection_id, provider_event_id, event_type),
      UNIQUE(connection_id, dedupe_key)
    ) STRICT`,
    `CREATE INDEX workspace_connector_events_processing_idx
      ON workspace_connector_events(processing_status, received_at, event_sequence)`,
    `CREATE TABLE workspace_connector_event_ingress_receipts (
      ingress_event_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL CHECK (
        substr(payload_hash, 1, 7) = 'sha256:' AND length(payload_hash) = 71
        AND substr(payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      connector_event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      received_at INTEGER NOT NULL CHECK (received_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_connector_event_ingress_receipts_retention_idx
      ON workspace_connector_event_ingress_receipts(received_at, ingress_event_id)`,
    `CREATE TABLE workspace_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workspace_socket_ticket_receipts_expiry_idx
      ON workspace_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE workspace_directory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waterline INTEGER NOT NULL CHECK (waterline >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `INSERT INTO workspace_directory_state(id, waterline, updated_at) VALUES (1, 0, 0)`,
    `CREATE TABLE workspace_workstream_directory (
      workstream_id TEXT PRIMARY KEY,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 500),
      description TEXT NOT NULL CHECK (length(description) <= 4000),
      preview TEXT NOT NULL CHECK (length(preview) <= 1000),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (length(exact_state) BETWEEN 1 AND 80),
      system_kind TEXT CHECK (system_kind IS NULL OR length(system_kind) <= 80),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      email_address TEXT,
      origin_type TEXT NOT NULL CHECK (origin_type IN ('ad_hoc', 'automation')),
      origin_label TEXT CHECK (origin_label IS NULL OR length(origin_label) <= 120),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL CHECK (title_status IN ('naming', 'automatic', 'settled')),
      latest_attention_ordinal INTEGER NOT NULL CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT CHECK (next_wakeup_prompt IS NULL OR length(next_wakeup_prompt) <= 500),
      next_terminal_action_at INTEGER CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_directory_list_idx
      ON workspace_workstream_directory(archived_at, system_kind, last_activity_at DESC, workstream_id)`,
    `CREATE INDEX workspace_workstream_directory_automation_idx
      ON workspace_workstream_directory(automation_subscription_id, planned_for, archived_at)`,
    `CREATE INDEX workspace_workstream_directory_due_idx
      ON workspace_workstream_directory(next_wakeup_due_at, next_terminal_action_at, workstream_id)`,
    `CREATE INDEX workspace_workstream_directory_terminal_idx
      ON workspace_workstream_directory(next_terminal_action_at, workstream_id)
      WHERE next_terminal_action_at IS NOT NULL`,
    `CREATE TABLE workspace_workstream_viewers (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
      unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
      you_are_mentioned INTEGER NOT NULL CHECK (you_are_mentioned IN (0, 1)),
      listable INTEGER NOT NULL CHECK (listable IN (0, 1)),
      seen_attention_ordinal INTEGER NOT NULL CHECK (seen_attention_ordinal >= 0),
      manual_unread_from_ordinal INTEGER CHECK (manual_unread_from_ordinal IS NULL OR manual_unread_from_ordinal >= 0),
      manual_unread_generation INTEGER NOT NULL CHECK (manual_unread_generation >= 0),
      latest_mention_attention_ordinal INTEGER NOT NULL CHECK (latest_mention_attention_ordinal >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, user_id)
    ) STRICT`,
    `CREATE TABLE workspace_workstream_pins (
      user_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_pins_order_idx
      ON workspace_workstream_pins(user_id, position, workstream_id)`,
    `CREATE TABLE workspace_workstream_resource_links (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
      relationship_type TEXT NOT NULL CHECK (length(relationship_type) BETWEEN 1 AND 80),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, resource_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_resource_links_lookup_idx
      ON workspace_workstream_resource_links(resource_id, watch_enabled, workstream_id)`,
    `CREATE TABLE workspace_workstream_suggestion_feedback (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('contextual_routing', 'suggested_work')),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed')),
      resolved_at INTEGER NOT NULL CHECK (resolved_at >= 0),
      resolved_by_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, action_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_suggestion_feedback_activity_idx
      ON workspace_workstream_suggestion_feedback(source, resolved_at, status, activity_id)`,
    `CREATE TABLE workspace_workstream_effect_receipts (
      message_id TEXT PRIMARY KEY,
      workstream_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL CHECK (received_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_effect_receipts_received_idx
      ON workspace_workstream_effect_receipts(received_at, message_id)`,
    ...WORKSPACE_PRODUCT_SCHEMA_STATEMENTS,
    ...WORKSPACE_DOMAIN_SCHEMA_STATEMENTS,
    `CREATE TRIGGER workspace_identity_placement_valid_insert
      BEFORE INSERT ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_valid_update
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_immutable
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN OLD.placement_affinity IS NOT NULL
        AND NEW.placement_affinity <> OLD.placement_affinity
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
      END`,
  ],
}, {
  version: 2,
  description: "connector OAuth attempt telemetry columns the connection service reads",
  statements: [
    // `connection-service.ts` writes and reads these four alongside
    // `telemetry_operation_id`, which version 1 carried alone. The object
    // table was therefore narrower than the queries routed to it: every
    // connector OAuth attempt statement naming them fails once a region serves
    // this table from the object, and the maintenance import — which passes
    // each D1 column through by name — cannot land the rows at all. Added
    // rather than dropped at import because the columns are live product
    // telemetry, not migration residue.
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_event_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_scope TEXT`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_capability_count INTEGER`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_reconnect INTEGER NOT NULL DEFAULT 0`,
  ],
}, {
  version: 3,
  description: "drop the two workspace tables no code reads or writes",
  statements: [
    // As in the AgentLoopDO's migration 11, version 1 still creates these
    // and must: its statements are hashed into every deployed object's
    // `_sql_schema_migrations` receipt. `WORKSPACE_FENCED_TABLES` still names
    // `external_delivery_attempts` for the same reason — it feeds v1's
    // identity-fence triggers, so pruning the list would edit v1 in place.
    // Dropping the table takes those triggers and its index with it.
    //
    // `external_delivery_attempts` declared a unified outbound pipeline —
    // idempotency key, lease, attempt count, five states — for automation,
    // digest, mention, and note-privacy sends. Nothing ever wrote it, and the
    // delivery that does happen runs through `workstream_notification_intents`
    // and the per-channel services. Two pipelines in the schema, one of them
    // empty, is a standing invitation to extend the wrong one.
    `DROP TABLE IF EXISTS external_delivery_attempts`,
    // `slack_agent_channel_allowlist` was superseded before it was used:
    // `slack_agent_policies.public_channel_mode` and `private_channel_mode`
    // decide channel admission, and no query ever consulted the allowlist.
    `DROP TABLE IF EXISTS slack_agent_channel_allowlist`,
  ],
}, {
  version: 4,
  description: "hold this workspace's whole schedule behind its single alarm",
  statements: [
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
    // Product work already queued keeps its wake-up across the cutover. Every
    // other target — schedules, watches, maintenance, Terminal deadlines — is
    // reconciled from its own table by `refreshSchedule`, which the retiring
    // scheduler object calls on its next alarm; product work has no such
    // second writer, so a window queued before this deploy would otherwise
    // wait for an unrelated enqueue to rediscover it.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'product', 'workspace', MIN(due_at), NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
       FROM (
         SELECT process_after AS due_at FROM opportunity_batch_windows WHERE status = 'pending'
         UNION ALL
         SELECT lease_expires_at AS due_at FROM opportunity_batch_windows WHERE status = 'processing'
         UNION ALL
         SELECT COALESCE(lease_expires_at, due_at) AS due_at
           FROM suggested_work_sets WHERE due_at IS NOT NULL
       )
      WHERE due_at IS NOT NULL
     HAVING MIN(due_at) IS NOT NULL`,
  ],
}, {
  version: 5,
  description: "reconcile a carried-over workspace's schedule once",
  statements: [
    // Version 4 arrived with the scheduler object still running, so its final
    // alarm was what reconciled every non-product target. This change deletes
    // that object, and a schedule whose only pending wake-up lived there now
    // has no other writer until a person or a connector happens to touch the
    // workspace. One immediate entry, consumed once, closes that gap.
    //
    // A separate version rather than an amendment to 4: every object that
    // constructed between the two deploys recorded a hash of 4's statements,
    // and editing them in place emits `workspace_do_schema_hash_mismatch:4`.
    // The warning no longer blocks construction, but an appended migration is
    // still the only way to make old and new object schemas converge.
    //
    // Only for an object that already exists. A workspace created after this
    // deploy runs its whole ledger before it has an identity row, and arming a
    // reconcile for a database with nothing in it would make every new
    // workspace pay for a wake-up that can only find zero targets.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'schedule_bootstrap', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)`,
  ],
}, {
  version: 6,
  description: "per-list ordering for the pushed sidebar lists",
  statements: [
    // One counter per list, not one for both. `choosing-sockets-or-rest.md`:
    // fields that change independently need independent counters, or updates
    // to the faster one hide updates to the slower one. Rows are seeded here
    // so a push never has to decide what an absent counter means.
    `CREATE TABLE workspace_sidebar_list_state (
      list TEXT PRIMARY KEY CHECK (list IN ('automations', 'notes')),
      waterline INTEGER NOT NULL CHECK (waterline >= 0)
    ) STRICT`,
    `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('automations', 0)`,
    `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('notes', 0)`,
  ],
}, {
  version: 7,
  description: "drop the automation email-route marker Global no longer mirrors",
  statements: [
    // The column existed to track a lifecycle Global held a second copy of, so
    // that an interrupted transition could be reconciled. Global now records
    // only that an address is claimed, and every reader of this marker already
    // had the real answer beside it: inbound mail resolves an automation with
    // `status = 'active' AND lifecycle_state = 'visible'`, which is what the
    // marker was derived from in the first place.
    `ALTER TABLE automation_subscriptions DROP COLUMN email_route_status`,
  ],
}, {
  version: 8,
  description: "where Avalon's Slack status reaction sits, and which one it is",
  statements: [
    // The reaction on the message that started a run is the only status a
    // member sees without opening the thread. It used to be added once and
    // removed by nothing, so a finished run and a failed one looked identical
    // at the message that asked for them. Giving it a lifecycle means a later
    // invocation — delivery, which owns the terminal transition — has to know
    // what Avalon last put there and on which message.
    //
    // The timestamp is the *triggering* message, not the thread root, and the
    // two differ whenever a member replies inside an existing Avalon thread.
    // Reacting to the root would move the status off the message they just
    // sent and onto one they may have stopped looking at hours ago.
    ...SLACK_REACTION_COLUMN_STATEMENTS,
  ],
}, {
  version: 9,
  description: "admit a second person-notification kind alongside the mention",
  statements: [
    // `notification_kind` was pinned to a single literal, so being added to a
    // work stream — the other thing that is worth telling one person about —
    // had nowhere to be recorded. SQLite cannot alter a CHECK in place, so the
    // table is rebuilt the way `terminal_workspace` was in the work-stream
    // object's schema: new table, copy, drop, rename.
    //
    // Version 1 still creates the narrow table and must: its statements are
    // hashed into every deployed object's `_sql_schema_migrations` receipt,
    // and editing them in place emits `workspace_do_schema_hash_mismatch:1`
    // for every workspace that ran an earlier release. A new object therefore
    // creates the old shape and immediately rebuilds it,
    // which costs one empty copy once.
    `CREATE TABLE workstream_notification_intents_kinds (
      intent_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL CHECK (source_generation > 0),
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
      notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added')),
      payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'skipped', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_id TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (source_message_id, recipient_user_id, notification_kind)
    ) STRICT`,
    `INSERT INTO workstream_notification_intents_kinds
       (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
        source_generation, source_version, required_directory_version, notification_kind,
        payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
        last_error_code, created_at, updated_at, delivered_at)
     SELECT intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
        source_generation, source_version, required_directory_version, notification_kind,
        payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
        last_error_code, created_at, updated_at, delivered_at
       FROM workstream_notification_intents`,
    // Takes the old table's indexes and identity-fence triggers with it, which
    // is why both are restated below rather than left to version 1.
    `DROP TABLE workstream_notification_intents`,
    `ALTER TABLE workstream_notification_intents_kinds RENAME TO workstream_notification_intents`,
    `CREATE INDEX workstream_notification_intents_delivery_idx
      ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
    `CREATE INDEX workstream_notification_intents_terminal_idx
      ON workstream_notification_intents(workstream_id, state, created_at)`,
    `CREATE TRIGGER workstream_notification_intents_workspace_identity_insert
      BEFORE INSERT ON workstream_notification_intents
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workstream_notification_intents_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workstream_notification_intents
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 10,
  description: "carry the per-person unseen flag into the sidebar's viewer projection",
  statements: [
    // The sidebar reads this table, not the work-stream object, so a state the
    // object knows about and this projection does not is a dot that never
    // lights. Defaulted to 0 because every row already here belongs to
    // somebody who has had the work stream for a while — the same reading the
    // object's own backfill takes.
    `ALTER TABLE workspace_workstream_viewers
       ADD COLUMN unseen INTEGER NOT NULL DEFAULT 0 CHECK (unseen IN (0, 1))`,
  ],
}, {
  version: 11,
  description: "freeze and resume generic work-stream batch Queue dispatch",
  statements: [
    `CREATE TABLE workspace_batch_dispatches (
      operation_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      target_count INTEGER NOT NULL CHECK (target_count >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `CREATE TABLE workspace_batch_dispatch_targets (
      operation_id TEXT NOT NULL REFERENCES workspace_batch_dispatches(operation_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL,
      dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= 0),
      PRIMARY KEY (operation_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_batch_dispatch_targets_pending_idx
      ON workspace_batch_dispatch_targets(operation_id, workstream_id)
      WHERE dispatched_at IS NULL`,
  ],
}, {
  version: 12,
  description: "distinguish expiring Queue claims from drain-only Workflow ownership",
  statements: [
    // NULL is intentionally meaningful for rows already processing when this
    // migration lands: Queue claims did not exist before this version, so such
    // a row is a pre-cutover Workflow claim and remains exclusive until settle.
    `ALTER TABLE workspace_connector_events
       ADD COLUMN processing_orchestrator TEXT
       CHECK (processing_orchestrator IS NULL OR processing_orchestrator IN ('queue', 'workflow'))`,
  ],
}, {
  version: 13,
  description: "retain every semantic resource revision and its regional R2 objects",
  statements: [
    `ALTER TABLE resources
       ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1)`,
    `CREATE TABLE resource_versions (
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      connection_id TEXT,
      resource_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_resource_id TEXT,
      title TEXT NOT NULL,
      mime_type TEXT,
      content_ref TEXT,
      canonical_url TEXT,
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      last_hydrated_at TEXT,
      uploaded_by_user_id TEXT,
      attachment_status TEXT NOT NULL CHECK (attachment_status IN ('draft', 'attached')),
      model_content_ref TEXT,
      model_mime_type TEXT,
      model_content_sha256 TEXT,
      model_metadata_json TEXT CHECK (model_metadata_json IS NULL OR json_valid(model_metadata_json)),
      content_sha256 TEXT,
      model_content_status TEXT CHECK (model_content_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
      model_content_extractor_version TEXT,
      model_content_character_count INTEGER CHECK (model_content_character_count IS NULL OR model_content_character_count >= 0),
      model_content_extracted_at TEXT,
      model_content_error_code TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (resource_id, version)
    ) STRICT`,
    `CREATE INDEX resource_versions_workspace_idx
       ON resource_versions(workspace_id, resource_id, version DESC)`,
    `INSERT INTO resource_versions
       (resource_id, workspace_id, version, connection_id, resource_type, provider,
        provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
        last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
        model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
        model_content_status, model_content_extractor_version, model_content_character_count,
        model_content_extracted_at, model_content_error_code, captured_at)
     SELECT id, workspace_id, 1, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, updated_at
       FROM resources`,
    `CREATE TRIGGER resource_versions_workspace_identity_insert
       BEFORE INSERT ON resource_versions
       WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
       BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER resource_versions_workspace_identity_update
       BEFORE UPDATE OF workspace_id ON resource_versions
       WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
       BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at);
       END`,
    `CREATE TRIGGER resources_create_semantic_version
       AFTER UPDATE OF connection_id, resource_type, provider, provider_resource_id, title,
         mime_type, content_ref, canonical_url, metadata_json, last_hydrated_at,
         uploaded_by_user_id, attachment_status, content_sha256 ON resources
       WHEN NEW.current_version = OLD.current_version BEGIN
         UPDATE resources SET current_version = OLD.current_version + 1 WHERE id = NEW.id;
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at
           FROM resources WHERE id = NEW.id;
       END`,
    `CREATE TRIGGER resources_sync_current_version_derivative
       AFTER UPDATE OF model_content_ref, model_mime_type, model_content_sha256,
         model_metadata_json, model_content_status, model_content_extractor_version,
         model_content_character_count, model_content_extracted_at, model_content_error_code
       ON resources
       WHEN NEW.connection_id IS OLD.connection_id
        AND NEW.resource_type IS OLD.resource_type
        AND NEW.provider IS OLD.provider
        AND NEW.provider_resource_id IS OLD.provider_resource_id
        AND NEW.title IS OLD.title
        AND NEW.mime_type IS OLD.mime_type
        AND NEW.content_ref IS OLD.content_ref
        AND NEW.canonical_url IS OLD.canonical_url
        AND NEW.metadata_json IS OLD.metadata_json
        AND NEW.last_hydrated_at IS OLD.last_hydrated_at
        AND NEW.uploaded_by_user_id IS OLD.uploaded_by_user_id
        AND NEW.attachment_status IS OLD.attachment_status
        AND NEW.content_sha256 IS OLD.content_sha256 BEGIN
         UPDATE resource_versions
            SET model_content_ref = NEW.model_content_ref,
                model_mime_type = NEW.model_mime_type,
                model_content_sha256 = NEW.model_content_sha256,
                model_metadata_json = NEW.model_metadata_json,
                model_content_status = NEW.model_content_status,
                model_content_extractor_version = NEW.model_content_extractor_version,
                model_content_character_count = NEW.model_content_character_count,
                model_content_extracted_at = NEW.model_content_extracted_at,
                model_content_error_code = NEW.model_content_error_code
          WHERE resource_id = NEW.id AND version = NEW.current_version;
       END`,
    `CREATE TRIGGER resource_versions_enqueue_objects_before_delete
       BEFORE DELETE ON resource_versions BEGIN
         INSERT OR IGNORE INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
           SELECT OLD.content_ref, OLD.workspace_id, OLD.resource_id, 'original', datetime('now'), datetime('now')
            WHERE OLD.content_ref IS NOT NULL;
         INSERT OR IGNORE INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
           SELECT OLD.model_content_ref, OLD.workspace_id, OLD.resource_id, 'derivative', datetime('now'), datetime('now')
            WHERE OLD.model_content_ref IS NOT NULL;
       END`,
  ],
}, {
  version: 14,
  description: "make WorkspaceDO authoritative for projects and per-person ordering",
  statements: [
    `CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
      icon_key TEXT NOT NULL CHECK (icon_key IN (${projectRegistrySql(PROJECT_ICON_KEYS_FROZEN)})),
      icon_color_key TEXT NOT NULL CHECK (icon_color_key IN (${projectRegistrySql(PROJECT_COLOR_KEYS_AT_V14)})),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      status TEXT NOT NULL CHECK (status IN (
        'active', 'archiving', 'archived', 'restoring', 'cancelling_restore'
      )),
      creator_user_id TEXT NOT NULL,
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      archived_by_user_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      presentation_revision INTEGER NOT NULL DEFAULT 1 CHECK (presentation_revision > 0),
      audience_generation INTEGER NOT NULL DEFAULT 1 CHECK (audience_generation > 0),
      lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
      CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL))
    ) STRICT`,
    `CREATE TABLE project_participants (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('adding', 'active', 'removing', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (project_id, user_id)
    ) STRICT`,
    `CREATE INDEX project_participants_user_state_idx
      ON project_participants(user_id, state, project_id)`,
    `CREATE TABLE workspace_project_order (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, project_id)
    ) STRICT`,
    `CREATE INDEX workspace_project_order_user_position_idx
      ON workspace_project_order(user_id, position, project_id)`,
    `CREATE TABLE workspace_project_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waterline INTEGER NOT NULL CHECK (waterline >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `INSERT INTO workspace_project_state (id, waterline, updated_at) VALUES (1, 0, 0)`,
  ],
}, {
  version: 15,
  description: "stage many-to-many project membership for work streams",
  statements: [
    `CREATE TABLE project_workstream_memberships (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('joining', 'active', 'removing', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      joined_at INTEGER NOT NULL CHECK (joined_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
      CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
      PRIMARY KEY (project_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX project_workstream_memberships_workstream_state_idx
      ON project_workstream_memberships(workstream_id, state, project_id)`,
    `CREATE INDEX project_workstream_memberships_project_state_idx
      ON project_workstream_memberships(project_id, state, workstream_id)`,
  ],
}, {
  version: 16,
  description: "store project defaults and their per-work-stream Queue targets",
  statements: [
    `CREATE TABLE project_default_resources (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
      CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
      PRIMARY KEY (project_id, resource_id)
    ) STRICT`,
    `CREATE TABLE project_default_resource_targets (
      project_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      default_generation INTEGER NOT NULL CHECK (default_generation > 0),
      workstream_id TEXT NOT NULL,
      membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'terminal')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
      last_error_code TEXT,
      PRIMARY KEY (project_id, resource_id, default_generation, workstream_id, membership_generation),
      FOREIGN KEY (project_id, resource_id) REFERENCES project_default_resources(project_id, resource_id)
        ON DELETE CASCADE
    ) STRICT`,
    `CREATE INDEX project_default_resource_targets_pending_idx
      ON project_default_resource_targets(state, project_id, resource_id, workstream_id)`,
  ],
}, {
  version: 17,
  description: "publish project default-resource targets through a durable outbox",
  statements: [
    `CREATE TABLE project_default_resource_publications (
      project_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      default_generation INTEGER NOT NULL CHECK (default_generation > 0),
      workstream_id TEXT NOT NULL,
      membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
      requested_by_user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= 0),
      PRIMARY KEY (project_id, resource_id, default_generation, workstream_id, membership_generation),
      FOREIGN KEY (project_id, resource_id, default_generation, workstream_id, membership_generation)
        REFERENCES project_default_resource_targets(
          project_id, resource_id, default_generation, workstream_id, membership_generation
        ) ON DELETE CASCADE
    ) STRICT`,
    `CREATE INDEX project_default_resource_publications_due_idx
      ON project_default_resource_publications(state, next_attempt_at, project_id, resource_id)`,
    `INSERT INTO project_default_resource_publications (
       project_id, resource_id, default_generation, workstream_id, membership_generation,
       requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at, accepted_at
     )
     SELECT target.project_id, target.resource_id, target.default_generation, target.workstream_id,
            target.membership_generation, project.creator_user_id, 'pending', 0,
            target.updated_at, target.created_at, target.updated_at, NULL
       FROM project_default_resource_targets target
       JOIN projects project ON project.project_id = target.project_id
      WHERE target.state = 'pending'`,
  ],
}, {
  version: 18,
  description: "attribute every retained resource version to who moved its pointers and why",
  statements: [
    // Provenance is staged on the resource row rather than passed to capture,
    // because capture is a trigger: a swap that sets these columns in the same
    // UPDATE gives its version an author with nothing in between to go wrong.
    //
    // Staging is *consumed*: both capture triggers null these columns after
    // reading them, so they hold an author only for the one capture that swap
    // causes. Without that, every later writer of a captured column — the
    // derivative service healing a hash, a provider webhook renaming a page,
    // the origin backfill — mints a version wearing the previous swapper's
    // name, which is a confident lie where the honest answer is "not
    // recorded". None of these columns is in either trigger's `UPDATE OF`
    // list, so releasing them cannot re-enter capture.
    `ALTER TABLE resources ADD COLUMN revision_author_kind TEXT
       CHECK (revision_author_kind IS NULL
         OR revision_author_kind IN ('agent', 'member', 'connector', 'system'))`,
    `ALTER TABLE resources ADD COLUMN revision_author_run_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_author_user_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_author_connection_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_cause TEXT
       CHECK (revision_cause IS NULL
         OR revision_cause IN ('created', 'published', 'refetched', 'replaced'))`,
    // Staged like the rest, so the shape a version records is chosen by the
    // swap that creates it. Without this, capture could only ever write the
    // default, and the seam below would be reachable solely by updating a
    // version row after the fact — the second statement this design avoids.
    `ALTER TABLE resources ADD COLUMN revision_storage_kind TEXT NOT NULL DEFAULT 'object'`,
    // NULL is the honest answer for history captured before this version: the
    // rows record which pointers a state held, and nothing recorded who moved
    // them. Every capture after this migration carries an author or none
    // because its producer has not been taught one yet.
    `ALTER TABLE resource_versions ADD COLUMN author_kind TEXT
       CHECK (author_kind IS NULL
         OR author_kind IN ('agent', 'member', 'connector', 'system'))`,
    `ALTER TABLE resource_versions ADD COLUMN author_run_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN author_user_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN author_connection_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN cause TEXT
       CHECK (cause IS NULL
         OR cause IN ('created', 'published', 'refetched', 'replaced'))`,
    // What kind of thing the refs name. Every row says an immutable object in
    // the region's bucket, because every capture today is one — the value is
    // staged rather than assumed, so a later storage shape (the collaborative
    // editor's materialized snapshots) sets it the way an author is set. No
    // CHECK, so a new kind is a value its writer chooses rather than a
    // constraint SQLite would need the table rebuilt to alter.
    `ALTER TABLE resource_versions ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'object'`,
    // An identity that its kind cannot have is attribution the rail would
    // render as fact, so capture refuses it rather than storing it.
    `CREATE TRIGGER resource_versions_provenance_fence_insert
       BEFORE INSERT ON resource_versions
       WHEN (NEW.author_kind IS NULL AND (NEW.author_run_id IS NOT NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'agent' AND (NEW.author_run_id IS NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'member' AND (NEW.author_user_id IS NULL
              OR NEW.author_run_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'connector' AND (NEW.author_connection_id IS NULL
              OR NEW.author_run_id IS NOT NULL OR NEW.author_user_id IS NOT NULL))
         OR (NEW.author_kind = 'system' AND (NEW.author_run_id IS NOT NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
       BEGIN SELECT RAISE(ABORT, 'resource_version_provenance_mismatch'); END`,
    `DROP TRIGGER resources_create_initial_version`,
    `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at,
            NEW.revision_author_kind, NEW.revision_author_run_id, NEW.revision_author_user_id,
            NEW.revision_author_connection_id, NEW.revision_cause,
            NEW.revision_storage_kind);
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object'
          WHERE id = NEW.id;
       END`,
    `DROP TRIGGER resources_create_semantic_version`,
    `CREATE TRIGGER resources_create_semantic_version
       AFTER UPDATE OF connection_id, resource_type, provider, provider_resource_id, title,
         mime_type, content_ref, canonical_url, metadata_json, last_hydrated_at,
         uploaded_by_user_id, attachment_status, content_sha256 ON resources
       WHEN NEW.current_version = OLD.current_version BEGIN
         UPDATE resources SET current_version = OLD.current_version + 1 WHERE id = NEW.id;
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at,
                revision_author_kind, revision_author_run_id, revision_author_user_id,
                revision_author_connection_id, revision_cause, revision_storage_kind
           FROM resources WHERE id = NEW.id;
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object'
          WHERE id = NEW.id;
       END`,
  ],
}, {
  version: 19,
  description: "give every resource a short token-friendly alias beside its UUID",
  statements: [
    // Nothing in SQL can mint one — the generator is an HMAC over the
    // resource's coordinates — so existing rows start without an alias and a
    // bounded maintenance pass fills them in. Null is not a placeholder here:
    // a resource without an alias is addressed by UUID, which every internal
    // reference, storage key, and receipt uses regardless.
    `ALTER TABLE resources ADD COLUMN slug TEXT`,
    // Partial, so the rows still waiting on the pass do not collide with each
    // other. The object is one workspace, so unique here is unique per
    // workspace; a collision costs the allocator one more attempt.
    `CREATE UNIQUE INDEX resources_slug_idx ON resources(slug) WHERE slug IS NOT NULL`,
  ],
}, {
  version: 20,
  description: "reserve upload drafts while work-stream inputs are pending",
  statements: [
    `CREATE TABLE pending_attachment_reservations (
      workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
      workstream_id TEXT NOT NULL CHECK (length(workstream_id) = 36),
      input_id TEXT NOT NULL CHECK (length(input_id) = 36),
      resource_id TEXT NOT NULL CHECK (length(resource_id) = 36)
        REFERENCES resources(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL CHECK (length(user_id) = 36),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (input_id, resource_id)
    ) STRICT`,
    `CREATE INDEX pending_attachment_reservations_resource_idx
      ON pending_attachment_reservations(resource_id, workstream_id, input_id)`,
    `CREATE TRIGGER pending_attachment_reservations_workspace_identity_insert
      BEFORE INSERT ON pending_attachment_reservations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER pending_attachment_reservations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON pending_attachment_reservations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 21,
  description: "fence in-flight resource objects from asynchronous cleanup",
  statements: [
    // Publication registers an object before its R2 write so a failed request
    // cannot orphan bytes. Until the writer either publishes a pointer or
    // releases that registration, cleanup must not interpret the absence of a
    // pointer as abandonment: the writer may be between the R2 put and its
    // WorkspaceDO commit.
    `ALTER TABLE resource_object_deletion_outbox
       ADD COLUMN cleanup_eligible INTEGER NOT NULL DEFAULT 1
       CHECK (cleanup_eligible IN (0, 1))`,
    // The pre-existing lifecycle triggers enqueue superseded and deleted
    // pointers with INSERT OR IGNORE. If the same object is still carrying a
    // staging row, that insert correctly preserves one ownership record but
    // must also hand it from the publisher to cleanup. Separate promotion
    // triggers keep the released trigger bodies immutable and are correct in
    // either SQLite trigger order: they update an existing staged row, while a
    // missing row is inserted eligible by the original trigger's default.
    `CREATE TRIGGER resources_promote_replaced_original_after_update
       AFTER UPDATE OF content_ref ON resources
       WHEN OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id AND object_ref = OLD.content_ref;
       END`,
    `CREATE TRIGGER resources_promote_replaced_model_after_update
       AFTER UPDATE OF model_content_ref ON resources
       WHEN OLD.model_content_ref IS NOT NEW.model_content_ref
        AND OLD.model_content_ref IS NOT NULL BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id AND object_ref = OLD.model_content_ref;
       END`,
    `CREATE TRIGGER resources_promote_objects_after_delete
       AFTER DELETE ON resources BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id
            AND (object_ref = OLD.content_ref OR object_ref = OLD.model_content_ref);
       END`,
    `CREATE TRIGGER resource_versions_promote_objects_after_delete
       AFTER DELETE ON resource_versions BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id
            AND (object_ref = OLD.content_ref OR object_ref = OLD.model_content_ref);
       END`,
  ],
}, {
  version: 22,
  description: "index durable automations and typed external-event destinations",
  statements: [
    `CREATE TABLE automation_creation_claims (
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      client_creation_key TEXT NOT NULL,
      automation_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY(workspace_id, author_user_id, client_creation_key)
    ) STRICT`,
    `CREATE TABLE automation_directory (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'activating', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      attention_code TEXT,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0)
    ) STRICT`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    `CREATE TABLE workspace_external_event_registrations (
      registration_id TEXT PRIMARY KEY,
      destination_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      source_hash TEXT NOT NULL,
      effective_after_event_sequence INTEGER NOT NULL CHECK (effective_after_event_sequence >= 0),
      connection_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      automation_id TEXT,
      workstream_id TEXT,
      substream_id TEXT,
      destination_resource_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed', 'integrity_failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (destination_kind = 'automation' AND automation_id IS NOT NULL
          AND workstream_id IS NULL AND substream_id IS NULL AND destination_resource_id IS NULL)
        OR
        (destination_kind = 'workstream_resource_update' AND automation_id IS NULL
          AND workstream_id IS NOT NULL AND substream_id IS NOT NULL AND destination_resource_id IS NOT NULL)
      ),
      UNIQUE(registration_id, authority_generation, projection_version)
    ) STRICT`,
    `CREATE INDEX workspace_external_event_candidates_idx
      ON workspace_external_event_registrations(
        connection_id, event_type, resource_id, state, registration_id
      )`,
    `CREATE INDEX workspace_external_event_destination_idx
      ON workspace_external_event_registrations(
        destination_kind, destination_key, authority_generation, projection_version
      )`,
    `CREATE TABLE workspace_external_event_deliveries (
      delivery_id TEXT PRIMARY KEY,
      workspace_event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      registration_id TEXT NOT NULL REFERENCES workspace_external_event_registrations(registration_id),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      source_hash TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      destination_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'not_delivered', 'failed')),
      outcome_code TEXT,
      lease_id TEXT,
      lease_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_event_id, registration_id, authority_generation, destination_id)
    ) STRICT`,
    `CREATE INDEX workspace_external_event_deliveries_pending_idx
      ON workspace_external_event_deliveries(state, created_at, delivery_id)`,
    `CREATE TABLE automation_cutover_campaign (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('legacy', 'fenced', 'importing', 'cleaning', 'completed')),
      source_hash TEXT,
      source_witness_json TEXT CHECK (source_witness_json IS NULL OR json_valid(source_witness_json)),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TRIGGER automation_creation_claims_workspace_identity_insert
      BEFORE INSERT ON automation_creation_claims
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER automation_creation_claims_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON automation_creation_claims
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    ...automationDirectoryWorkspaceIdentityGuards(),
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_insert
      BEFORE INSERT ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 23,
  description: "rebuild durable-memory vectors with the OpenRouter embedding space",
  statements: [
    // The existing 1,024-dimensional Vectorize indexes can store a reduced
    // Qwen3 Embedding 8B output, but the Workers AI 0.6B and OpenRouter 8B
    // coordinates are not comparable.
    // Requeue only each active item's current upsert; invalidated, expired, and
    // historical revisions stay retired. The projection writes a model-derived
    // namespace, so old vectors are unreachable throughout the rebuild.
    `UPDATE memory_index_outbox
        SET status = 'pending', attempt_count = 0,
            available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
            completed_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE operation = 'upsert'
        AND EXISTS (
          SELECT 1
            FROM memory_items item
           WHERE item.memory_item_id = memory_index_outbox.memory_item_id
             AND item.memory_scope_id = memory_index_outbox.memory_scope_id
             AND item.workspace_id = memory_index_outbox.workspace_id
             AND item.revision = memory_index_outbox.revision
             AND item.invalidated_at IS NULL
             AND (item.expires_at IS NULL OR item.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`,
    // Existing objects may otherwise have no reason to wake after the rows are
    // requeued. The one-shot bootstrap reconciles the memory maintenance target
    // into the shared alarm index; fresh objects have no identity and pay no
    // empty wake-up.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'schedule_bootstrap', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)
     ON CONFLICT(kind, alarm_key) DO UPDATE SET
       due_at = MIN(due_at, excluded.due_at), retry_at = 0, attempt = 0,
       updated_at = excluded.updated_at`,
  ],
}, {
  version: 24,
  description: "store participant join time on the sidebar viewer overlay",
  statements: [
    // The facepile sorts by who joined, not by the last overlay rewrite.
    // `projected_at` moves on every unread and mention, and a message stamps
    // every participant with the same now(), so that column is UUID order.
    // Defaulted to NULL because every row already here predates the field;
    // NULL sorts last under DESC until the next directory_user effect lands.
    `ALTER TABLE workspace_workstream_viewers
       ADD COLUMN participant_added_at INTEGER
         CHECK (participant_added_at IS NULL OR participant_added_at >= 0)`,
  ],
}, {
  version: 25,
  description: "retire work-stream context suggestion feedback",
  statements: [
    `DROP TABLE workspace_workstream_suggestion_feedback`,
  ],
}, {
  version: 26,
  description: "freeze and receipt the note half of a generic batch",
  statements: [
    // NULL means the note archive has not been applied for this operation, and
    // is the state a fresh `mark_read` operation stays in, because `mark_read`
    // has nothing to do to a note.
    `ALTER TABLE workspace_batch_dispatches
       ADD COLUMN archived_note_count INTEGER
       CHECK (archived_note_count IS NULL OR archived_note_count >= 0)`,
    // Every row that predates this version belongs to an operation whose
    // confirmation named work streams and nothing else — the batch surface did
    // not reach notes at all. Zero is therefore the *true* receipt for it, and
    // writing it here is what stops a half-published operation that is retried
    // across this deploy from archiving notes its reader was never told about.
    // Left as NULL, that retry would read as "the note half has not run yet".
    `UPDATE workspace_batch_dispatches SET archived_note_count = 0`,
    // The note half's frozen target set, for the same reason the work-stream
    // half has one: the selection and the mutation are separate object calls,
    // and between them a note can enter the range — trivially so under an
    // open-ended heading like "Last hour". Without this the archive would take
    // rows the confirmation never counted, on the first attempt and not only on
    // a retry.
    //
    // No `dispatched_at` twin to the work-stream table: these are applied in
    // one statement here rather than published one message at a time, so there
    // is no partial progress through them to record.
    `CREATE TABLE workspace_batch_dispatch_note_targets (
      operation_id TEXT NOT NULL REFERENCES workspace_batch_dispatches(operation_id) ON DELETE CASCADE,
      note_id TEXT NOT NULL,
      PRIMARY KEY (operation_id, note_id)
    ) STRICT`,
  ],
}, {
  version: 27,
  description: "automations a work stream owns, and runs it has made visible",
  statements: [
    // A table rebuild, because SQLite cannot alter a CHECK in place and this
    // one has to admit a third scope. Copied whole and renamed, with the index
    // recreated after: the projection this table serves is read on every
    // sidebar open, and a rebuild that lost it would be a silent full scan.
    `CREATE TABLE automation_directory_v27 (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'activating', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      -- Set exactly when the scope is 'workstream': the room that owns the
      -- automation, which is also the only room it can deliver into. The rail
      -- reads it; the sidebar excludes it.
      owning_workstream_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      attention_code TEXT,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `INSERT INTO automation_directory_v27
       (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
        payload_hash, lifecycle, scope, owning_workstream_id, title, description,
        next_run_at, attention_code, projected_at)
     SELECT automation_id, workspace_id, author_user_id, authority_generation, projection_version,
            payload_hash, lifecycle, scope, NULL, title, description,
            next_run_at, attention_code, projected_at
       FROM automation_directory`,
    `DROP TABLE automation_directory`,
    `ALTER TABLE automation_directory_v27 RENAME TO automation_directory`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    // The rail's own read, which the sidebar index does not serve: it leads
    // with the workspace, and this one leads with the room.
    `CREATE INDEX automation_directory_workstream_idx
      ON automation_directory(owning_workstream_id, lifecycle, projected_at DESC)
      WHERE owning_workstream_id IS NOT NULL`,
    // Dropped with the table, so recreated with it. SQLite drops a table's
    // triggers when the table goes, and a rebuild that restores only the
    // indexes leaves the upgraded object without the one guard that stops a
    // row from another workspace reaching this directory.
    ...automationDirectoryWorkspaceIdentityGuards(),
    // What makes a run's own work stream visible. `origin_type` is never
    // rewritten — it is provenance, the run history still needs it, and an
    // exposed run is still a run.
    `ALTER TABLE workspace_workstream_directory ADD COLUMN automation_exposed INTEGER NOT NULL DEFAULT 0
       CHECK (automation_exposed IN (0, 1))`,
  ],
}, {
  // Renumbered from 26 during a rebase: `main` took 26 and 27 while this
  // branch was open, and a Durable Object migration is decided by its
  // number, so two 26s would diverge a fresh database from a hosted one.
  version: 28,
  description: "index live web artifacts beside the resource authority",
  statements: [
    // Beside `resources`, because an artifact *is* a resource with a serving
    // side: one row here per site resource, carrying what the resource row has
    // no column for. It is a per-workspace index for listing, revocation
    // fan-out, and cleanup — never the region-wide public-name authority. That
    // authority was added in platform D1 by its migration 0001; version 29 records
    // its already-reserved stub here. The UUID remains the supervisor name and
    // storage identity.
    `CREATE TABLE artifact_registry (
      artifact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('static', 'active')),
      stateful INTEGER NOT NULL DEFAULT 0 CHECK (stateful IN (0, 1)),
      current_version INTEGER NOT NULL CHECK (current_version > 0),
      manifest_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      UNIQUE(resource_id)
    ) STRICT`,
    // The revocation walk's workspace hop reads this: an artifact hangs off the
    // workspace, like an automation, because this table is what names them and
    // it lives here rather than in any work stream's own database.
    `CREATE INDEX artifact_registry_workspace_idx
      ON artifact_registry(workspace_id, updated_at DESC, artifact_id)`,
    `CREATE INDEX artifact_registry_workstream_idx
      ON artifact_registry(workstream_id, updated_at DESC, artifact_id)`,
    `CREATE TRIGGER artifact_registry_workspace_identity_insert
      BEFORE INSERT ON artifact_registry
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER artifact_registry_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON artifact_registry
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 29,
  description: "give live artifacts public hostname stubs",
  statements: [
    // Nullable for artifacts published before stub-addressed origins shipped.
    // Their first authorized open allocates and materializes the immutable
    // regional route before filling this field.
    `ALTER TABLE artifact_registry ADD COLUMN hostname_stub TEXT`,
    `CREATE UNIQUE INDEX artifact_registry_hostname_stub_idx
      ON artifact_registry(hostname_stub) WHERE hostname_stub IS NOT NULL`,
    `CREATE TRIGGER artifact_registry_hostname_stub_shape_insert
      BEFORE INSERT ON artifact_registry
      WHEN NEW.hostname_stub IS NOT NULL AND (
        NEW.hostname_stub <> lower(NEW.hostname_stub)
        OR NEW.hostname_stub GLOB '*[^a-z-]*'
        OR NEW.hostname_stub GLOB '-*'
        OR NEW.hostname_stub GLOB '*-'
        OR NEW.hostname_stub GLOB '*--*'
        OR length(NEW.hostname_stub) - length(replace(NEW.hostname_stub, '-', '')) <> 3
      )
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_invalid'); END`,
    `CREATE TRIGGER artifact_registry_hostname_stub_shape_update
      BEFORE UPDATE OF hostname_stub ON artifact_registry
      WHEN NEW.hostname_stub IS NOT NULL AND (
        NEW.hostname_stub <> lower(NEW.hostname_stub)
        OR NEW.hostname_stub GLOB '*[^a-z-]*'
        OR NEW.hostname_stub GLOB '-*'
        OR NEW.hostname_stub GLOB '*-'
        OR NEW.hostname_stub GLOB '*--*'
        OR length(NEW.hostname_stub) - length(replace(NEW.hostname_stub, '-', '')) <> 3
      )
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_invalid'); END`,
    `CREATE TRIGGER artifact_registry_hostname_stub_immutable
      BEFORE UPDATE OF hostname_stub ON artifact_registry
      WHEN OLD.hostname_stub IS NOT NULL AND NEW.hostname_stub IS NOT OLD.hostname_stub
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_immutable'); END`,
  ],
}, {
  version: 30,
  description: "park a ranking request that arrives while a pass is in flight",
  statements: [
    // Where a member's ranking request waits while a pass holds the lease.
    // `due_at` is that pass's own claim time until it settles, so a request
    // that took `MIN` against it inherited a time already past and ran the
    // moment the pass ended — under continuous admissions, back to back,
    // whatever the debounce said. `settleRanking` re-arms `due_at` from here.
    `ALTER TABLE suggested_work_sets ADD COLUMN pending_due_at INTEGER
      CHECK (pending_due_at IS NULL OR pending_due_at >= 0)`,
  ],
}, {
  version: 31,
  description: "connector connections and OAuth attempts admit a configured MCP server",
  statements: [
    // `connector_type` and `provider` are CHECK vocabularies, and SQLite cannot
    // widen one in place. `connector_connections` is the harder of the two:
    // thirteen tables cascade from it and one nulls, so the implicit delete
    // inside `DROP TABLE` would take a workspace's Slack sessions, unfurls,
    // ingress jobs and webhook receipts with it.
    //
    // The children are therefore *held* rather than rebuilt: each is copied to
    // a scratch table, the parent is replaced, and the rows are put back. That
    // keeps foreign keys enforced for the whole migration — `PRAGMA
    // foreign_keys = OFF` is silently a no-op once an object event has already
    // touched SQLite, so a rebuild that relies on it drops the children for
    // real — and it means this migration never restates a child's schema,
    // which is the other way a rebuild loses something: a column added by a
    // later migration, an index, a trigger, quietly not carried across.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.map((table) => (
      `CREATE TABLE ${table}_v31_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE connector_connections_v31 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('custom_mcp', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v31
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    // Empties every dependent, which is why they are held above. The rename
    // then puts the replacement under the name they all still reference.
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v31 RENAME TO connector_connections`,
    // Dropped with the old table, so recreated with it — the identity fences
    // included, since they are the only guard stopping a row from another
    // workspace reaching this object's connector table.
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    // Emptied first because the parent's replacement does not leave every
    // dependent empty: twelve cascade to nothing, while `connector_oauth_attempts`
    // nulls its pointer and keeps the row, which the hold would then duplicate.
    // Deleting makes the restore mean the same thing for both.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.flatMap((table) => [
      `DELETE FROM ${table}`,
      `INSERT INTO ${table} SELECT * FROM ${table}_v31_hold`,
      `DROP TABLE ${table}_v31_hold`,
    ]),
    // The attempt vocabulary is the same widening one step earlier in the flow:
    // a custom MCP authorization writes its pending receipt here before the
    // person reaches the server's consent screen. Nothing references this
    // table, so it is an ordinary rebuild.
    `CREATE TABLE connector_oauth_attempts_v31 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('custom_mcp', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v31
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v31 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 32,
  description: "automations become conversation parents: one directory row per automation, registrations without coordinates, no delivery ledger",
  statements: [
    // A run no longer has a work stream of its own; it is a child conversation
    // under its automation. Every directory row a run made is gone with the
    // class that made it, and the columns that described it stay as dead
    // columns: they sit inside CHECK constraints in the released table text,
    // and rebuilding the directory around them would cost more than leaving
    // `'ad_hoc'` and NULL in place. Nothing reads them.
    `DELETE FROM workspace_workstream_directory WHERE origin_type = 'automation'`,
    // Delivery is now one Queue message per matched registration, idempotent
    // where it lands, so there is no ledger of deliveries to lease or settle.
    `DROP TABLE IF EXISTS workspace_external_event_deliveries`,
    // The draft compiler, the August cutover, and the template gallery are all
    // retired; their tables hold nothing the new automation object reads.
    `DROP TABLE IF EXISTS automation_creation_claims`,
    `DROP TABLE IF EXISTS automation_cutover_campaign`,
    `DROP TABLE IF EXISTS automation_template_versions`,
    `DROP TABLE IF EXISTS automation_templates`,
    // The automation object was replaced, so its projection is rebuilt rather
    // than migrated: `AutomationDO` publishes its row through the same outbox
    // its children's aggregates travel through, versioned by `source_version`
    // alone. Recreated, not altered: the lifecycle CHECK loses `activating`.
    `DROP TABLE IF EXISTS automation_directory`,
    `CREATE TABLE automation_directory (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      owning_workstream_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    `CREATE INDEX automation_directory_workstream_idx
      ON automation_directory(owning_workstream_id, lifecycle, projected_at DESC)
      WHERE owning_workstream_id IS NOT NULL`,
    ...automationDirectoryWorkspaceIdentityGuards(),
    // Registrations are a complete replacement per destination, so the
    // generation, version and hash that ordered competing projections have no
    // job left. A work stream's watched-resource rows are kept; an
    // automation's belonged to the deleted class and are re-registered by the
    // new one when it is applied.
    `CREATE TABLE workspace_external_event_registrations_v32 (
      registration_id TEXT PRIMARY KEY,
      destination_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      effective_after_event_sequence INTEGER NOT NULL CHECK (effective_after_event_sequence >= 0),
      connection_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      automation_id TEXT,
      workstream_id TEXT,
      substream_id TEXT,
      destination_resource_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (destination_kind = 'automation' AND automation_id IS NOT NULL
          AND workstream_id IS NULL AND substream_id IS NULL AND destination_resource_id IS NULL)
        OR
        (destination_kind = 'workstream_resource_update' AND automation_id IS NULL
          AND workstream_id IS NOT NULL AND substream_id IS NOT NULL AND destination_resource_id IS NOT NULL)
      )
    ) STRICT`,
    `INSERT INTO workspace_external_event_registrations_v32
       (registration_id, destination_key, workspace_id, effective_after_event_sequence,
        connection_id, connector_type, event_type, resource_id, evaluator_json,
        destination_kind, automation_id, workstream_id, substream_id, destination_resource_id,
        state, created_at, updated_at)
     SELECT registration_id, destination_key, workspace_id, effective_after_event_sequence,
        connection_id, connector_type, event_type, resource_id, evaluator_json,
        destination_kind, automation_id, workstream_id, substream_id, destination_resource_id,
        state, created_at, updated_at
       FROM workspace_external_event_registrations
      WHERE destination_kind = 'workstream_resource_update' AND state IN ('active', 'removed')`,
    `DROP TABLE workspace_external_event_registrations`,
    `ALTER TABLE workspace_external_event_registrations_v32 RENAME TO workspace_external_event_registrations`,
    `CREATE INDEX workspace_external_event_candidates_idx
      ON workspace_external_event_registrations(
        connection_id, event_type, resource_id, state, registration_id
      )`,
    `CREATE INDEX workspace_external_event_destination_idx
      ON workspace_external_event_registrations(destination_kind, destination_key, state)`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_insert
      BEFORE INSERT ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 33,
  description: "project resource text through Turbopuffer with durable revision watermarks and existing-content backfill",
  statements: RESOURCE_SEARCH_MIGRATION_STATEMENTS,
}, {
  version: 34,
  description: 'resumable new-user onboarding with scoped connector selections',
  statements: [ONBOARDING_JOURNEY_SQL],
}, {
  version: 35,
  description: "project the authoritative Sidekick loading capability",
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN loadable INTEGER CHECK (loadable IN (0, 1))`,
  ],
}, {
  version: 36,
  description: "fence external evaluator replacements by owning object generation",
  statements: [`CREATE TABLE external_registration_generations (
    destination_key TEXT PRIMARY KEY, source_generation INTEGER NOT NULL,
    effective_after_event_sequence INTEGER NOT NULL
  ) STRICT`],
}, {
  version: 37,
  description: "persist each viewer's workstream access history",
  statements: [`CREATE TABLE workspace_workstream_access (
    user_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
    last_accessed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, workstream_id)
  ) STRICT`],
}, {
  version: 38,
  description: 'owner-backed authorization snapshots and exact conversation attachment discovery',
  statements: AUTHORIZATION_STORAGE_MIGRATION,
}, {
  version: 39,
  description: "index pending resource maintenance and search work without scanning completed resources",
  statements: [
    `CREATE INDEX resources_expired_drafts_idx ON resources(workspace_id, created_at, id)
      WHERE provider = 'avalon_upload' AND attachment_status = 'draft'`,
    `CREATE INDEX resources_missing_slug_idx ON resources(workspace_id, created_at, id)
      WHERE slug IS NULL`,
    `CREATE INDEX resource_search_pending_due_idx ON resource_search_versions(not_before, resource_id)
      WHERE pending = 1`,
  ],
}, { version: 40, description: "project shared workstream appearance", statements: [
  `ALTER TABLE workspace_workstream_directory ADD COLUMN appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
] }, {
  version: 41,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 42,
  description: "record the object graph retirement walks",
  statements: [
    // Captured before the tombstone and read after it. Once this workspace is
    // retired its directories refuse, so a walk that re-derived its descendants
    // from them would find nothing on the second pass and call itself finished.
    // `retired_at` is the receipt: completion is the absence of NULLs here
    // rather than a flag somebody sets, so a child that failed leaves the walk
    // visibly incomplete and resumable.
    `CREATE TABLE workspace_retirement_graph (
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation')),
      parent_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      retired_at INTEGER,
      PRIMARY KEY (parent_kind, parent_id)
    ) STRICT`,
  ],
}, {
  version: 43,
  description: 'invalidate resource search only for content and category changes',
  statements: RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION,
}, {
  version: 44,
  description: 'push search authorization decisions after source permission mutations',
  statements: SEARCH_AUTHORIZATION_PUSH_MIGRATION,
}, {
  version: 45,
  description: "the project palette becomes the hue ring",
  statements: [
    // `icon_color_key` is a CHECK vocabulary and SQLite cannot widen one in
    // place, so the table is replaced. Six tables cascade from `projects` —
    // four directly, and two more beneath `project_default_resources` — which
    // means the implicit delete inside `DROP TABLE` would take a workspace's
    // project membership, ordering and pending default-resource work with it.
    //
    // The children are held rather than rebuilt, exactly as v31 does: each is
    // copied wholesale, the parent is replaced, and the rows are put back
    // parents-first. Foreign keys stay enforced throughout — `PRAGMA
    // foreign_keys = OFF` is a silent no-op once the object event has touched
    // SQLite — and no child's schema, index or column is restated here, which
    // is the other way a rebuild quietly loses something.
    //
    // Nothing is remapped. `gray`, `brown`, `yellow` and `teal` left the picker
    // but stay in the vocabulary, so every existing project keeps the colour
    // its owner chose and this migration only ever widens what is accepted.
    ...PROJECT_CASCADE_DEPENDENTS.map((table) => (
      `CREATE TABLE ${table}_v45_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE projects_v45 (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
      icon_key TEXT NOT NULL CHECK (icon_key IN (${projectRegistrySql(PROJECT_ICON_KEYS_FROZEN)})),
      icon_color_key TEXT NOT NULL CHECK (icon_color_key IN (${projectRegistrySql(PROJECT_COLOR_KEYS_AT_V45)})),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      status TEXT NOT NULL CHECK (status IN (
        'active', 'archiving', 'archived', 'restoring', 'cancelling_restore'
      )),
      creator_user_id TEXT NOT NULL,
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      archived_by_user_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      presentation_revision INTEGER NOT NULL DEFAULT 1 CHECK (presentation_revision > 0),
      audience_generation INTEGER NOT NULL DEFAULT 1 CHECK (audience_generation > 0),
      lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
      CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO projects_v45
       (project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
        creator_user_id, archived_at, archived_by_user_id, created_at, updated_at,
        presentation_revision, audience_generation, lifecycle_generation)
     SELECT project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
            creator_user_id, archived_at, archived_by_user_id, created_at, updated_at,
            presentation_revision, audience_generation, lifecycle_generation
       FROM projects`,
    // Empties every dependent, which is why they are held above.
    `DROP TABLE projects`,
    `ALTER TABLE projects_v45 RENAME TO projects`,
    // Parents before children, so each insert sees the rows its keys point at.
    ...PROJECT_CASCADE_DEPENDENTS.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v45_hold`,
      `DROP TABLE ${table}_v45_hold`,
    ]),
  ],
}, {
  version: 46,
  description: 'persist initialization retry intent with pending search projections',
  statements: [
    `CREATE TRIGGER search_authz_pending_insert AFTER INSERT ON authorization_snapshots
      WHEN json_extract(NEW.snapshot_json, '$.decision.status') = 'unavailable'
      BEGIN INSERT OR IGNORE INTO search_authorization_push
        SELECT CASE WHEN resource_id IS NULL THEN 'parent' ELSE 'resource' END,
          COALESCE(resource_id, parent_id), 1, 0, NULL, 'cache_fill'
        FROM search_authorization_keys WHERE cache_key = NEW.cache_key; END`,
    `INSERT OR IGNORE INTO search_authorization_push
      SELECT CASE WHEN k.resource_id IS NULL THEN 'parent' ELSE 'resource' END,
        COALESCE(k.resource_id, k.parent_id), 1, 0, NULL, 'cache_fill'
      FROM search_authorization_keys k JOIN authorization_snapshots s USING(cache_key)
      WHERE json_extract(s.snapshot_json, '$.decision.status') = 'unavailable'`,
  ],
}, {
  version: 47,
  description: 'rewrite every indexed resource with its display attributes',
  // The index now serves a result's title, time and type beside its text.
  // Re-publishing at the current revision rewrites the lexical row in place
  // (an equal-revision upsert is admitted while the row is live) and leaves
  // completed embeddings alone. A row in backoff keeps its `not_before`: the
  // rewrite lands when that delay expires, and an upgrade never resets a
  // committed retry schedule.
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 48,
  description: 'register the search projection universe from the directories',
  // Search admission is complete only if every (member, conversation) pair
  // has a projected decision before the member's first search. The push job
  // now registers what its target reaches, so every live parent, every
  // connection and every attachment-admitted resource gets one push here.
  // Connector resources are admitted per connection and carry that key.
  statements: [
    'ALTER TABLE search_authorization_keys ADD COLUMN connection_id TEXT',
    'CREATE INDEX search_authorization_keys_connection ON search_authorization_keys(connection_id, cache_key)',
    `INSERT INTO search_authorization_push
     SELECT 'parent', workstream_id, 1, 0, NULL, 'workspace_mutation' FROM workspace_workstream_directory WHERE archived_at IS NULL
     UNION ALL SELECT 'parent', automation_id, 1, 0, NULL, 'workspace_mutation' FROM automation_directory WHERE lifecycle <> 'deleted'
     UNION ALL SELECT 'connection', id, 1, 0, NULL, 'workspace_mutation' FROM connector_connections
     UNION ALL SELECT 'resource', id, 1, 0, NULL, 'workspace_mutation' FROM resources WHERE connection_id IS NULL
     ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1`,
  ],
}, {
  version: 49,
  description: "project the Sidekick's chosen icon and colour",
  statements: [
    // Nullable and never backfilled: a Sidekick nobody has chosen for renders
    // the mark derived from its id, which is what every row here holds today.
    `ALTER TABLE automation_directory ADD COLUMN appearance_json TEXT
       CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
  ],
}, {
  version: 50,
  description: "memory scopes store a Sidekick's kind as sidekick",
  // `kind` is a CHECK vocabulary and the row is immutable by trigger, so the
  // stored `automation` cannot be renamed in place: the table is replaced, the
  // way migration 31 replaced `connector_connections`. Every dependent cascades
  // from it, so each is held in a scratch copy across the replacement and put
  // back afterwards, with foreign keys enforced the whole way — `PRAGMA
  // foreign_keys = OFF` is a no-op by the time a group runs. One step differs
  // from 31: the dependents are emptied child-first *before* the parent is
  // dropped rather than left to the drop's implicit delete. Two of them carry
  // FTS5 shadow tables whose triggers fire on every deleted row, and a cascade
  // reaching those from inside `DROP TABLE` locks the table being dropped
  // (`SQLITE_LOCKED`); an ordinary `DELETE` fires the same triggers cleanly.
  // The immutability trigger and the workspace identity fences go with the old
  // table and are recreated; no later migration added an index or a column to
  // this table, and no dependent's schema is restated here.
  statements: [
    ...MEMORY_SCOPE_DEPENDENTS.map((table) => `CREATE TABLE ${table}_v50_hold AS SELECT * FROM ${table}`),
    ...[...MEMORY_SCOPE_DEPENDENTS].reverse().map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE memory_scopes_v50 (
      memory_scope_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workstream', 'sidekick', 'user', 'workspace')),
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, kind, owner_id),
      CHECK (kind <> 'workspace' OR owner_id = workspace_id)
    ) STRICT`,
    `INSERT INTO memory_scopes_v50 (memory_scope_id, workspace_id, kind, owner_id, created_at)
     SELECT memory_scope_id, workspace_id,
            CASE kind WHEN 'automation' THEN 'sidekick' ELSE kind END,
            owner_id, created_at
       FROM memory_scopes`,
    // Childless by now, so nothing cascades. The rename then puts the
    // replacement under the name every dependent still references.
    `DROP TABLE memory_scopes`,
    `ALTER TABLE memory_scopes_v50 RENAME TO memory_scopes`,
    `CREATE TRIGGER memory_scopes_are_immutable BEFORE UPDATE ON memory_scopes
      BEGIN SELECT RAISE(ABORT, 'memory_scope_immutable'); END`,
    ...workspaceIdentityFencesFor("memory_scopes"),
    ...MEMORY_SCOPE_DEPENDENTS.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v50_hold`,
      `DROP TABLE ${table}_v50_hold`,
    ]),
  ],
}, {
  version: 51,
  description: 'mark every resource pending after the 2026-09-10 consumer version skew dead-lettered rewrites',
  // The deploy that added display and connection attributes ran Durable
  // Objects on the new build while Queue consumers still ran the old one, and
  // the old consumer rejected the new document shape into the dead-letter
  // queue after `publishResourceSearch` had already cleared `pending`. The
  // retry log carries no resource id, so the stale rows cannot be listed;
  // this is migration 47's pass again, at its measured cost. A row in backoff
  // keeps its `not_before`, as in 47. See docs/text-search.md, "Version skew
  // between producers and the consumer".
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 52,
  description: 'unlist the Terminal recovery backups already attached',
  // Repository checkout has always attached its pre-replacement archive as an
  // ordinary generated resource, so every one made before this version is in
  // its work stream's artifacts rail and its model inventory. The producer now
  // marks new ones unlisted; these are the ones already written.
  //
  // Scoped by the identity the backup path derives rather than by title, which
  // carries a repository name. Idempotent, and no wider than the one producer:
  // `terminal-final-diff:` captures are the work's own output and stay listed.
  //
  // Two triggers on `resources` matter here, and they behave oppositely.
  //
  // `resources_search_update` will **not** fire: migration 43 narrowed it to
  // the columns search reads plus `metadata_json`'s `description` key, and
  // `listing` is neither. A backup indexed before this upgrade would therefore
  // never be re-projected, and would stay in search results forever while
  // absent from every other surface — so the second statement performs the
  // same upsert that trigger would have, over exactly the rows the first
  // marked.
  //
  // `resources_create_semantic_version` **will** fire, because it watches
  // `metadata_json` wholesale and this row's `current_version` is unchanged.
  // Each marked backup therefore gains a `resource_versions` row identical to
  // its predecessor but for the flag. That is accepted rather than suppressed:
  // making the trigger's `WHEN` false means bumping `current_version` in this
  // statement, which leaves the counter ahead of the history it indexes. The
  // version is attributed instead — the staging columns exist precisely so a
  // producer can say who moved the pointers, and `system` is the true answer.
  // `revision_cause` stays null because this is not `created`, `published`,
  // `refetched` or `replaced`, and null is what that column already means for
  // a capture whose producer has no cause to name.
  statements: [
    `UPDATE resources
        SET metadata_json = json_set(metadata_json, '$.listing', 'unlisted'),
            revision_author_kind = 'system'
      WHERE provider = 'avalon_generated'
        AND provider_resource_id LIKE 'terminal-workspace-backup:%'
        AND COALESCE(json_extract(metadata_json, '$.listing'), '') != 'unlisted'`,
    `INSERT INTO resource_search_versions (resource_id, revision, pending, not_before)
     SELECT id, 1, 1, 0 FROM resources
      WHERE provider = 'avalon_generated'
        AND provider_resource_id LIKE 'terminal-workspace-backup:%'
        AND json_extract(metadata_json, '$.listing') = 'unlisted'
     ON CONFLICT(resource_id)
       DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0`,
  ],
}, {
  version: 53,
  description: "admit Ashby without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.map((table) => (
      `CREATE TABLE ${table}_v53_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE connector_connections_v53 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'custom_mcp', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v53
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v53 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.flatMap((table) => [
      `DELETE FROM ${table}`,
      `INSERT INTO ${table} SELECT * FROM ${table}_v53_hold`,
      `DROP TABLE ${table}_v53_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v53 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v53
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v53 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, { version: 54, description: "durable connector installation lifecycle", statements: [
  `CREATE TABLE connector_installations (
    connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id),
    workspace_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    document_json TEXT NOT NULL CHECK (json_valid(document_json)),
    cleanup_ciphertext TEXT, cleanup_iv TEXT, cleanup_key_version INTEGER
  ) STRICT`,
  `CREATE TABLE connector_installation_steps (
    step_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, generation INTEGER NOT NULL,
    state TEXT NOT NULL, intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX connector_installation_steps_connection ON connector_installation_steps(connection_id, generation)`,
  `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
    WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
  `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
    WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
]
}, {
  version: 55,
  description: "admit Fireflies without losing connector dependents",
  statements: [
    // Held before the parent is replaced, because dropping it would otherwise
    // cascade through every one of them. `connector_installations` is the
    // reason this list exists separately from v53's: its foreign key does not
    // cascade, so the parent's implicit DELETE would *abort* rather than empty
    // it — which is why every dependent is emptied here, before the drop,
    // rather than relying on the cascade to do it.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.map((table) => (
      `CREATE TABLE ${table}_v55_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v55 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v55
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v55 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    // v54's cardinality indexes went with the table it just replaced. A rebuild
    // restores every index the parent carried, not only the ones the migration
    // that created the parent wrote.
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    // Fireflies' own cardinality, in Ashby's shape: one active workspace
    // connection per workspace and one active personal connection per member,
    // while a disabled row never blocks reconnecting.
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v55_hold`,
      `DROP TABLE ${table}_v55_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v55 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v55
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v55 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, { version: 56, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_workspace_identity\" AS SELECT * FROM \"workspace_identity\"",
  "CREATE TABLE \"_region_copy_connector_oauth_attempts\" AS SELECT * FROM \"connector_oauth_attempts\"",
  "DROP TRIGGER \"workspace_identity_placement_valid_insert\"",
  "DROP TRIGGER \"workspace_identity_placement_valid_update\"",
  "DROP TRIGGER \"workspace_identity_placement_immutable\"",
  "DROP TRIGGER \"connector_oauth_attempts_workspace_identity_insert\"",
  "DROP TRIGGER \"connector_oauth_attempts_workspace_identity_update\"",
  "DELETE FROM \"connector_oauth_attempts\"",
  "DELETE FROM \"workspace_identity\"",
  "DROP TABLE \"workspace_identity\"",
  "DROP TABLE \"connector_oauth_attempts\"",
  "CREATE TABLE workspace_identity (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      workspace_id TEXT NOT NULL UNIQUE,\n      region TEXT NOT NULL,\n      placement_affinity TEXT NOT NULL CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    ) STRICT",
  "CREATE TABLE \"connector_oauth_attempts\" (\n      id TEXT PRIMARY KEY,\n      region TEXT NOT NULL,\n      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),\n      user_id TEXT NOT NULL,\n      workspace_id TEXT NOT NULL,\n      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),\n      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,\n      error_code TEXT,\n      expires_at TEXT NOT NULL,\n      completed_at TEXT,\n      created_at TEXT NOT NULL,\n      updated_at TEXT NOT NULL,\n      telemetry_operation_id TEXT,\n      telemetry_event_version INTEGER NOT NULL DEFAULT 1,\n      telemetry_scope TEXT,\n      telemetry_capability_count INTEGER,\n      telemetry_reconnect INTEGER NOT NULL DEFAULT 0\n    ) STRICT",
  "INSERT INTO \"workspace_identity\" SELECT * FROM \"_region_copy_workspace_identity\"",
  "INSERT INTO \"connector_oauth_attempts\" SELECT * FROM \"_region_copy_connector_oauth_attempts\"",
  "DROP TABLE \"_region_copy_workspace_identity\"",
  "DROP TABLE \"_region_copy_connector_oauth_attempts\"",
  "CREATE INDEX connector_oauth_attempts_expiry_idx\n      ON connector_oauth_attempts(status, expires_at, id)",
  "CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx\n      ON connector_oauth_attempts(telemetry_operation_id)\n      WHERE telemetry_operation_id IS NOT NULL",
  "CREATE TRIGGER workspace_identity_placement_valid_insert\n      BEFORE INSERT ON workspace_identity\n      WHEN NEW.placement_affinity IS NULL\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');\n      END",
  "CREATE TRIGGER workspace_identity_placement_valid_update\n      BEFORE UPDATE OF placement_affinity ON workspace_identity\n      WHEN NEW.placement_affinity IS NULL\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');\n      END",
  "CREATE TRIGGER workspace_identity_placement_immutable\n      BEFORE UPDATE OF placement_affinity ON workspace_identity\n      WHEN OLD.placement_affinity IS NOT NULL\n        AND NEW.placement_affinity <> OLD.placement_affinity\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');\n      END",
  "CREATE TRIGGER connector_oauth_attempts_workspace_identity_insert\n      BEFORE INSERT ON connector_oauth_attempts\n      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)\n      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END",
  "CREATE TRIGGER connector_oauth_attempts_workspace_identity_update\n      BEFORE UPDATE OF workspace_id ON connector_oauth_attempts\n      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)\n      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END",
  "PRAGMA defer_foreign_keys = OFF"
]
}, MEETING_NOTES_RETIREMENT_MIGRATION, MEETING_NOTES_FINALIZATION_MIGRATION, { version: 59, description: "implicit agent teams and message reply routes", statements: [...AGENT_TEAM_SCHEMA] }, { version: 60, description: "index explicit scope grants for guest discovery", statements: [...SCOPE_GRANT_DIRECTORY_SCHEMA] }, { version: 61, description: "protect connector resource access URLs separately from navigation metadata", statements: ["ALTER TABLE resources ADD COLUMN protected_access_json TEXT"] }, {
  version: 62,
  description: "admit Canva without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.map((table) => (
      `CREATE TABLE ${table}_v62_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v62 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v62
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v62 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX canva_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'canva' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v62_hold`,
      `DROP TABLE ${table}_v62_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v62 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v62
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v62 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 63,
  description: "spaces: directory, membership, general, defaults, bootstrap",
  statements: [...WORKSPACE_SPACE_SCHEMA_STATEMENTS],
}, {
  version: 64,
  description: "retire projects behind the space cutover",
  statements: [...PROJECT_RETIREMENT_STATEMENTS],
}, {
  version: 65,
  description: "breakout directory projections",
  statements: [...WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS],
}, {
  version: 66,
  description: "scope channel pins to space placements and clear legacy pins",
  statements: [
    "DROP TABLE workspace_workstream_pins",
    `CREATE TABLE workspace_workstream_pins (
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES workspace_space_directory(space_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, space_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_pins_order_idx
      ON workspace_workstream_pins(user_id, space_id, position, workstream_id)`,
  ],
}, {
  version: 67,
  description: "directed workspace impersonation relationships",
  statements: [
    `CREATE TABLE workspace_impersonation_relationships (
      workspace_id TEXT NOT NULL,
      impersonator_user_id TEXT NOT NULL,
      represented_user_id TEXT NOT NULL,
      authority_basis TEXT NOT NULL CHECK (length(authority_basis) BETWEEN 1 AND 180),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (workspace_id, impersonator_user_id, represented_user_id, authority_basis)
    ) STRICT`,
    `CREATE INDEX workspace_impersonation_relationships_targets_idx
      ON workspace_impersonation_relationships(workspace_id, impersonator_user_id, revoked_at, represented_user_id)`,
    ...workspaceIdentityFencesFor("workspace_impersonation_relationships"),
  ],
}, {
  version: 68,
  description: "durable atomic moves between spaces",
  statements: [
    `CREATE TABLE space_intents_v68 (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (
        'add', 'remove', 'move', 'audience', 'archive', 'restore'
      )),
      space_id TEXT NOT NULL,
      workstream_id TEXT,
      space_revision INTEGER NOT NULL CHECK (space_revision > 0),
      membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
      source_space_id TEXT,
      source_space_revision INTEGER CHECK (source_space_revision IS NULL OR source_space_revision > 0),
      source_membership_generation INTEGER CHECK (
        source_membership_generation IS NULL OR source_membership_generation > 0
      ),
      delivery_generation INTEGER CHECK (delivery_generation IS NULL OR delivery_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'settled', 'cancelled')),
      cursor TEXT,
      last_error_code TEXT,
      receipts_json TEXT NOT NULL CHECK (json_valid(receipts_json)),
      requested_by_user_id TEXT NOT NULL,
      not_before INTEGER NOT NULL,
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (kind = 'move' AND source_space_id IS NOT NULL
          AND source_space_revision IS NOT NULL AND source_membership_generation IS NOT NULL)
        OR (kind <> 'move' AND source_space_id IS NULL
          AND source_space_revision IS NULL AND source_membership_generation IS NULL)
      )
    ) STRICT`,
    `INSERT INTO space_intents_v68 (
       operation_id, kind, space_id, workstream_id, space_revision,
       membership_generation, source_space_id, source_space_revision,
       source_membership_generation, delivery_generation, state, cursor,
       last_error_code, receipts_json, requested_by_user_id, not_before,
       attempts, created_at, updated_at
     )
     SELECT operation_id, kind, space_id, workstream_id, space_revision,
            membership_generation, NULL, NULL, NULL, delivery_generation, state,
            cursor, last_error_code, receipts_json, requested_by_user_id,
            not_before, attempts, created_at, updated_at
       FROM space_intents`,
    `DROP TABLE space_intents`,
    `ALTER TABLE space_intents_v68 RENAME TO space_intents`,
    `CREATE INDEX space_intents_unsettled_idx
      ON space_intents(state, not_before, operation_id)`,
  ],
}, {
  version: 69,
  description: "preserve breakout appearance in workspace projections",
  statements: [
    "ALTER TABLE workspace_breakout_directory ADD COLUMN appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))",
  ],
}, {
  version: 70,
  description: 'remember which search decision KV acknowledged',
  // A push re-derives every decision under its target, and most come out the
  // same. With the acknowledged fingerprint beside the key, an unchanged
  // decision skips its KV write. Existing keys start unknown and write once.
  statements: ['ALTER TABLE search_authorization_keys ADD COLUMN published_decision TEXT'],
}, {
  version: 71,
  description: "remember accepted workspace sockets until their first frame",
  statements: [
    // The first-frame watch's ledger; see docs/realtime-sockets.md.
    `CREATE TABLE workspace_socket_unheard (
      connection_id TEXT PRIMARY KEY NOT NULL,
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0)
    ) STRICT`,
  ],
}, {
  version: 72,
  description: "host channel and space parents; name the directories channels, breakouts and spaces",
  statements: [...HOSTED_PARENT_SCHEMA_STATEMENTS],
}, {
  version: 73,
  description: "remember how many tools a discovered connection last exposed",
  // Read by `GET /connections` so Settings needs no per-row provider call; NULL
  // until the first discovery. The second column records that the list's
  // one-time background discovery was spent, so a failing one is not retried
  // on every list. See docs/connectors.md#settings-tool-counts.
  statements: [
    `ALTER TABLE connector_connections ADD COLUMN discovered_tool_count INTEGER
      CHECK (discovered_tool_count IS NULL OR discovered_tool_count >= 0)`,
    "ALTER TABLE connector_connections ADD COLUMN tool_count_backfill_attempted_at TEXT",
  ],
}, {
  version: 74,
  description: "give a workspace sync event an audience",
  // The people a per-person event is for (their digest, their connection),
  // so replay after a reconnect reaches the same sockets the live send did.
  // Null is the whole Organization, which every earlier event was.
  statements: [
    "ALTER TABLE workspace_sync_events ADD COLUMN audience_json TEXT CHECK (audience_json IS NULL OR json_valid(audience_json))",
  ],
}, {
  version: 75,
  description: "drop the legacy parent import ledger",
  // Every live Organization had imported every parent before WorkstreamDO and
  // SpaceDO were deleted, so nothing is left to import. A retired
  // Organization's pending rows were residue: retirement dropped their import.
  // See docs/hosted-conversation-parents.md.
  statements: [
    "DROP TABLE parent_imports",
  ],
}, {
  version: 76,
  description: "rewrite a resource's search rows when who may read it changes",
  // Search rows now carry their audience; see
  // docs/PRDs/2026-09-26_search-audience-filtering/design.md.
  statements: RESOURCE_SEARCH_AUDIENCE_MIGRATION,
}, {
  version: 77,
  description: 'rewrite every indexed resource with its audience',
  // Rows written before migration 76 carry no audience, and phase 3 of
  // docs/PRDs/2026-09-26_search-audience-filtering filters on it. This is
  // migration 47's pass again: an equal-revision upsert rewrites the lexical
  // row in place, and existing semantic chunks are left alone. A row in
  // backoff keeps its `not_before`, as in 47.
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 78,
  description: "index the stored object a resource or version points at",
  // The maintenance schedule asks, for each object waiting in
  // `resource_object_deletion_outbox`, whether a resource or an older version
  // still points at it. Nothing indexed those columns, so one waiting row
  // scanned every resource and every version (460,000 rows at Juno Labs) on
  // each refresh, and a Channel directory effect with links refreshes it:
  // most of `receiveChildEffects`' 700 ms of CPU. Connector resources store no
  // object, so the partial indexes hold only the few rows that do.
  statements: [
    "CREATE INDEX resources_content_ref_idx ON resources(content_ref) WHERE content_ref IS NOT NULL",
    "CREATE INDEX resources_model_content_ref_idx ON resources(model_content_ref) WHERE model_content_ref IS NOT NULL",
    "CREATE INDEX resource_versions_content_ref_idx ON resource_versions(content_ref) WHERE content_ref IS NOT NULL",
    "CREATE INDEX resource_versions_model_content_ref_idx ON resource_versions(model_content_ref) WHERE model_content_ref IS NOT NULL",
  ],
}, {
  version: 79,
  description: "narrow parent_metadata to a parent's identity",
  // A parent reads its presentation from its directory row (`channels`,
  // `spaces`) since the change before this one, so the 19 copied columns are
  // dead weight written on every Main effect. Nothing references this table,
  // so a plain rebuild keeps the rows. See docs/hosted-conversation-parents.md.
  statements: [
    `CREATE TABLE parent_metadata_v79 (
      parent_id TEXT PRIMARY KEY,
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'space')),
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO parent_metadata_v79
       (parent_id, parent_kind, workspace_id, region, authority_generation, revision, created_at, updated_at)
     SELECT parent_id, parent_kind, workspace_id, region, authority_generation, revision, created_at, updated_at
       FROM parent_metadata`,
    "DROP TABLE parent_metadata",
    "ALTER TABLE parent_metadata_v79 RENAME TO parent_metadata",
  ],
}, {
  version: 80,
  description: "remember what each resource's latest connector event said",
  // Ingest drops an event that says what the last one for the same resource
  // already said. A table of its own rather than a column on
  // `workspace_connector_events`, so the migration builds no index over the
  // rows already there. See docs/connectors.md#dropping-events-that-say-nothing-new.
  statements: [
    `CREATE TABLE workspace_connector_event_latest_content (
      connection_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      provider_resource_id TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL CHECK (
        substr(content_fingerprint, 1, 7) = 'sha256:' AND length(content_fingerprint) = 71
      ),
      event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      -- The newest occurrence this content stands for, stored or dropped.
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      -- The newest repeat dropped against this row, kept so a different
      -- event arriving late can restore it as the state that followed.
      dropped_json TEXT CHECK (dropped_json IS NULL OR json_valid(dropped_json)),
      PRIMARY KEY (connection_id, event_type, provider_resource_id)
    ) STRICT`,
    // The retention reaper deletes events; the cascade looks them up here.
    `CREATE INDEX workspace_connector_event_latest_content_event_idx
      ON workspace_connector_event_latest_content(event_id)`,
    // A late delivery that restored a dropped repeat, so its redelivery can
    // still wake the restored event's processing.
    "ALTER TABLE workspace_connector_event_ingress_receipts ADD COLUMN restored_event_id TEXT",
  ],
}, {
  version: 81,
  description: "record who each Sidekick runs as",
  // Search's person side lists a Sidekick's conversations for its executor as
  // well as its author, as the canonical Sidekick check does, without reading
  // each SidekickDO. Null until the Sidekick next publishes its row; see
  // docs/PRDs/2026-09-26_search-audience-filtering/design.md.
  statements: ["ALTER TABLE automation_directory ADD COLUMN run_as_user_id TEXT"],
}, {
  version: 82,
  description: "advance a Channel's rail waterline when anything its rail lists moves",
  // The socket's `channel_rails` answer and the waterline on each Channel row
  // that says when to ask again. See docs/hosted-conversation-parents.md.
  statements: CHANNEL_RAIL_MIGRATION,
}, {
  version: 83,
  description: "index when authorization deliveries come due",
  // The alarm reads `MIN(not_before)` on every wake; see docs/durable-object-alarms.md.
  statements: [
    "CREATE INDEX authorization_delivery_due_idx ON authorization_delivery(not_before)",
  ],
}, {
  version: 84,
  description: "purge the search-authorization keys memory search registered per run",
  statements: MEMORY_SEARCH_KEY_PURGE_MIGRATION,
}, {
  version: 85,
  description: "bind external conversations to Rally addresses",
  // One record for provider rooms and threads, keyed by installation and path;
  // every Slack Agent session's thread key becomes an active thread binding.
  // See docs/external-conversation-bindings.md.
  statements: EXTERNAL_CONVERSATION_BINDINGS_MIGRATION,
}, {
  version: 86,
  description: "a Sidekick's home Breakout, and the conversations attached to it",
  // The home column sits beside `owning_workstream_id` so the directory's
  // CHECK on that column needs no rebuild; "0" is a Channel's Main
  // conversation, which is every existing Sidekick's home. The attachment
  // table is not `parent_sidekicks`: that one means "may load this Sidekick as
  // a skill". See docs/automation-lifecycle.md.
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN owning_substream_id TEXT NOT NULL DEFAULT '0'`,
    ...SIDEKICK_CONVERSATION_ATTACHMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 87,
  description: "let a person order the Pinned section under All",
  // A table of its own, not a new kind in `workspace_container_order`, so an
  // older Worker never reads a row it cannot parse; see docs/pinning.md.
  statements: WORKSPACE_PINNED_ORDER_MIGRATION,
}, {
  version: 88,
  description: "a member's personal system prompt",
  statements: WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION,
}, {
  version: 89,
  description: "a member's display preferences",
  statements: WORKSPACE_MEMBER_PREFERENCES_MIGRATION,
}, {
  version: 90,
  description: "record whether a room's Space is one it joined by name",
  // Provenance the Slack Connect spawn check needs, which neither the room
  // id nor the Space's scope keeps; see docs/external-conversation-bindings.md.
  statements: EXTERNAL_BINDING_SPACE_MATCHED_MIGRATION,
}, {
  version: 91,
  description: "Sidekick parents move into the Organization object",
  // The directory row becomes the definition row, beside the revisions,
  // schedules, runs and children the Sidekick's own object held, and a ledger
  // of the Sidekicks still to import. See hosted-sidekick-schema.ts.
  statements: HOSTED_SIDEKICK_SCHEMA_STATEMENTS,
}, {
  version: 92,
  description: "drop the Sidekick import ledger",
  // Every Sidekick outside a retired Organization was imported before the
  // legacy class was deleted, so the ledger has nothing left to record.
  statements: [`DROP TABLE sidekick_imports`],
}, {
  version: 93,
  description: "index shares that were pending before shares were claimed at sign-in",
  // Signing in finds a share through D1's scope_share_recipients, which only
  // shares made after it existed have rows in. One alarm per parent with a
  // pending share writes its rows, once, with the alarm system's retries.
  statements: [`INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
     SELECT 'parent_invitation_index', parent_id, unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
       FROM parent_invitations
      WHERE json_extract(summary_json, '$.status') = 'pending'
      GROUP BY parent_id
     ON CONFLICT(kind, alarm_key) DO NOTHING`],
}, {
  version: 94,
  description: "make every private Space Organization-wide",
  // Every Space is Organization-wide. A Space grants no reader to its
  // Channels, so no Channel changes; see docs/architecture.md#spaces-space-access-sources-and-projects.
  statements: SPACE_PUBLIC_ONLY_MIGRATION,
}, {
  version: 95,
  description: "requests to join a Channel or Breakout, addressed to an approver",
  statements: CONVERSATION_ACCESS_REQUESTS_MIGRATION,
}, {
  version: 96,
  description: "Organization invitees listed in a Space until they join",
  statements: SPACE_INVITEES_MIGRATION,
}, {
  version: 97,
  description: "one pin table for threads, Channels and breakouts, and the Threads and Channel feed indexes",
  // The old pin tables stay and are still written; see workspace-pin-storage.ts.
  statements: WORKSPACE_PINS_MIGRATION,
}, {
  version: 98,
  description: "a Channel's unread waterline and each person's read position in it",
  // Breakout-identical columns, advanced only by placing a thread; see
  // workspace-channel-read-storage.ts and docs/architecture.md#spaces-space-access-sources-and-projects.
  statements: WORKSPACE_CHANNEL_READS_MIGRATION,
}, {
  version: 99,
  description: "threads and Breakouts store their Channel's colour, and every existing thread is marked to take it",
  // Triggers mark a thread whenever its colour can move; the lane that read them is retired.
  statements: CHANNEL_COLOR_SYNC_MIGRATION,
}, {
  version: 100,
  description: "a work list of one-off jobs over every thread, and every thread listed to have its description summarized",
  // The lane is channel colour sync's without triggers; retired with it.
  statements: THREAD_BACKFILL_MIGRATION,
}, {
  version: 101,
  description: "how far each person has read each thread, breakout and Channel, as the app reports it for Activity",
  // One waterline per person and subject, moved by app events; see workspace-activity-feed.ts.
  statements: WORKSPACE_ACTIVITY_READS_MIGRATION,
}, {
  version: 102,
  description: "a Space may be individual: each member's Personal Channel",
  // A rebuild, because SQLite cannot widen a CHECK; see
  // SPACE_INDIVIDUAL_SCOPE_MIGRATION and docs/architecture.md#spaces-space-access-sources-and-projects.
  statements: SPACE_INDIVIDUAL_SCOPE_MIGRATION,
}, {
  version: 103,
  description: "seat every existing member in General and give them a Personal Channel",
  // One alarm per Organization that has an identity; it walks the members and
  // takes the same steps a joining member's relationship change does. A fresh
  // object has no identity and no members, and pays nothing.
  statements: [`INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
     SELECT 'personal_channel_backfill', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)
     ON CONFLICT(kind, alarm_key) DO NOTHING`],
}, {
  version: 104,
  description: "messages in a Channel itself, outside any thread",
  // Existing Generals get what General opens with from migration 103's pass; see
  // SPACE_MESSAGES_MIGRATION and docs/architecture.md#spaces-space-access-sources-and-projects.
  statements: SPACE_MESSAGES_MIGRATION,
}, {
  version: 105,
  description: "which Activity rows have been pushed to whom, and when pushing them began",
  // Started threads and breakouts and finished runs push like mentions; see workspace-activity-push.ts.
  statements: WORKSPACE_ACTIVITY_PUSH_MIGRATION,
}, {
  version: 106,
  description: "which push notifications each person has turned off",
  // Read when a push is decided and again when it is sent; see member-preferences.ts.
  statements: WORKSPACE_MEMBER_PUSH_PREFERENCES_MIGRATION,
}, {
  version: 107,
  description: "how each kind of notification reaches each person",
  // Push, email or a connector's surface per kind; see member-preferences.ts.
  statements: WORKSPACE_MEMBER_NOTIFY_PREFERENCES_MIGRATION,
}, {
  version: 108,
  description: "every digest sends at the start of the day at 07:45",
  // Everyone moves, not only digests still on the old 09:00 default: a stored
  // 09:00 cannot say whether someone chose it. An evening time is kept, and a
  // digest with no days gets weekdays. Email and Personal Channel destinations
  // need the account address and the Space id, which this object cannot
  // derive, so each digest is marked and the reconciler adds whichever it
  // lacks and switches it on. The derived `schedules` rows are dropped rather
  // than rewritten, since their next instant needs the owner's timezone; the
  // reconciler rebuilds them on the same visit. (Digests are retired.)
  statements: [
    `ALTER TABLE digest_schedules ADD COLUMN default_destinations_pending INTEGER NOT NULL DEFAULT 0
       CHECK (default_destinations_pending IN (0, 1))`,
    `DELETE FROM digest_schedule_times WHERE minute_of_day < 720`,
    `INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day)
     SELECT id, 465 FROM digest_schedules`,
    `UPDATE digest_schedules
        SET day_mask = CASE WHEN day_mask = 0 THEN 62 ELSE day_mask END,
            default_destinations_pending = 1,
            version = version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    `DELETE FROM schedules WHERE digest_schedule_id IS NOT NULL`,
  ],
}, {
  version: 109,
  description: "a Channel message can be a thread's merged result and Channel news",
  // See SPACE_MESSAGE_MERGES_MIGRATION and docs/architecture.md#retired-documents.
  statements: SPACE_MESSAGE_MERGES_MIGRATION,
}, {
  version: 110,
  description: "a pin can be an artifact, carrying the thread it was generated in",
  // See WORKSPACE_ARTIFACT_PINS_MIGRATION and docs/pinning.md.
  statements: WORKSPACE_ARTIFACT_PINS_MIGRATION,
}, {
  version: 111,
  description: "a ledger of new versions of pinned artifacts, for their Activity rows and pushes",
  // See WORKSPACE_ARTIFACT_UPDATES_MIGRATION and docs/pinning.md#artifact-pins.
  statements: WORKSPACE_ARTIFACT_UPDATES_MIGRATION,
}, {
  version: 112,
  description: "an agent's resource version names the person its run acted for",
  statements: [
    // An agent version names its run, and the run's person lives in the
    // thread's object, out of reach of anything here that asks whose change a
    // version was. Staged and consumed like the rest of the provenance, so a
    // later write by somebody else never inherits it. NULL is "not recorded":
    // a run nobody started, or a version from before this migration.
    `ALTER TABLE resources ADD COLUMN revision_on_behalf_of_user_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN on_behalf_of_user_id TEXT`,
    `DROP TRIGGER resources_create_initial_version`,
    RESOURCES_CREATE_INITIAL_VERSION_V112,
    `DROP TRIGGER resources_create_semantic_version`,
    RESOURCES_CREATE_SEMANTIC_VERSION_V112,
  ],
}, {
  version: 113,
  description: "a person renaming an artifact is a version cause of its own",
  // A rename moves `title`, which the semantic-version trigger captures, so
  // every rename records a version whether or not it has a cause to name. A
  // cause of its own keeps it out of what a pin counts as news
  // (`artifactUpdateSql`) and lets history say what happened. SQLite cannot
  // widen a CHECK in place, and `resources` is a referenced parent, so each
  // cause column is replaced rather than its table rebuilt: a wider column is
  // added and filled, the triggers that read the old one are dropped so it
  // can be, and the new one takes its name. The triggers come back unchanged.
  statements: [
    `DROP TRIGGER resources_create_initial_version`,
    `DROP TRIGGER resources_create_semantic_version`,
    `DROP TRIGGER resource_versions_queue_artifact_update`,
    `ALTER TABLE resources ADD COLUMN revision_cause_v113 TEXT
       CHECK (revision_cause_v113 IS NULL
         OR revision_cause_v113 IN ('created', 'published', 'refetched', 'replaced', 'renamed'))`,
    `UPDATE resources SET revision_cause_v113 = revision_cause WHERE revision_cause IS NOT NULL`,
    `ALTER TABLE resources DROP COLUMN revision_cause`,
    `ALTER TABLE resources RENAME COLUMN revision_cause_v113 TO revision_cause`,
    `ALTER TABLE resource_versions ADD COLUMN cause_v113 TEXT
       CHECK (cause_v113 IS NULL
         OR cause_v113 IN ('created', 'published', 'refetched', 'replaced', 'renamed'))`,
    `UPDATE resource_versions SET cause_v113 = cause WHERE cause IS NOT NULL`,
    `ALTER TABLE resource_versions DROP COLUMN cause`,
    `ALTER TABLE resource_versions RENAME COLUMN cause_v113 TO cause`,
    RESOURCES_CREATE_INITIAL_VERSION_V112,
    RESOURCES_CREATE_SEMANTIC_VERSION_V112,
    RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE,
  ],
}, {
  version: 114,
  description: "one ledger of every new resource version, for open previews and pinned artifacts alike",
  // See WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION and docs/websocket-architecture.md.
  statements: WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION,
}, {
  version: 115,
  description: "every open thread listed for the suggestion backfill",
  // See SUGGESTION_BACKFILL_MIGRATION and docs/workstream-durable-object.md#retired-documents.
  statements: SUGGESTION_BACKFILL_MIGRATION,
}, {
  version: 116,
  description: "agent memory facts and sweep receipts, every live prose memory imported as a fact, and the item store dropped",
  // See MEMORY_FACTS_MIGRATION and docs/agent-memory.md.
  statements: MEMORY_FACTS_MIGRATION,
}, {
  version: 117,
  description: "conversations holding a memory digest copy and the facts each copy holds, marked for a refresh when a visibility input changes or a held fact is retracted, and the revision digest reads are ordered by",
  // The lane is channel colour sync's; see memory-digest-sync.ts.
  statements: MEMORY_DIGEST_SYNC_MIGRATION,
}, {
  version: 118,
  description: "every earlier Channel merge's embeds are linked to its Channel",
  // See SPACE_MERGE_EMBED_LINKS_MIGRATION and docs/authorization.md.
  statements: SPACE_MERGE_EMBED_LINKS_MIGRATION,
}, {
  version: 119,
  description: "a watch on every conversation import's reservation, archiving one whose thread has not opened an hour on",
  // See IMPORT_RESERVATION_RECLAIM_MIGRATION and docs/workstream-durable-object.md#retired-documents.
  statements: IMPORT_RESERVATION_RECLAIM_MIGRATION,
}, {
  version: 120,
  description: "a Channel's own messages are projected into the search index, every existing one queued once",
  // See CHANNEL_MESSAGE_SEARCH_MIGRATION and docs/text-search.md.
  statements: CHANNEL_MESSAGE_SEARCH_MIGRATION,
}, {
  version: 121,
  description: "admit personal Apollo connections without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.map((table) => (
      `CREATE TABLE ${table}_v121_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v121 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('apollo', 'ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      discovered_tool_count INTEGER CHECK (discovered_tool_count IS NULL OR discovered_tool_count >= 0),
      tool_count_backfill_attempted_at TEXT,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v121
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id, discovered_tool_count, tool_count_backfill_attempted_at)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id, discovered_tool_count, tool_count_backfill_attempted_at
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v121 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX canva_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'canva' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX apollo_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'apollo' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v121_hold`,
      `DROP TABLE ${table}_v121_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v121 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('apollo', 'ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v121
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v121 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 122,
  description: "preserve up to 10,000 connector people as ordered rows rather than one bounded JSON cell",
  statements: CONNECTOR_EVENT_PEOPLE_MIGRATION,
}, {
  version: 123,
  description: "resolve merged conversations independently of execution and archive state",
  statements: [
    `ALTER TABLE parent_children ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1))`,
    `UPDATE parent_children SET resolved = 1
      WHERE (substream_id = '0' AND parent_id IN (
        SELECT source_workstream_id FROM space_messages WHERE source_workstream_id IS NOT NULL
      )) OR (parent_id, substream_id) IN (
        SELECT subject_id, json_extract(metadata_json, '$.mergedFrom.breakoutId')
          FROM workspace_activity_events
          WHERE event_type = 'workstream_message_created' AND subject_type = 'workstream'
            AND json_extract(metadata_json, '$.mergedFrom.breakoutId') IS NOT NULL
      )`,
  ],
}, {
  version: 124,
  description: "cache visible conversation turns and backfill every existing conversation",
  statements: WORKSPACE_CONVERSATION_VIEW_MIGRATION,
}, {
  version: 125,
  description: "index participating-conversation replies and distinguish queued batches from actual per-channel alerts",
  statements: WORKSPACE_REPLY_ALERT_MIGRATION,
}, {
  version: 126,
  description: "seek a person's authored messages for People ranking without scanning Organization history",
  statements: WORKSPACE_PEOPLE_RANKING_MIGRATION,
}, {
  version: 127,
  description: "make grants the sole participant authority and retire historical roster writers",
  statements: [
    `ALTER TABLE parent_participant_migrations ADD COLUMN import_roster INTEGER NOT NULL DEFAULT 1 CHECK (import_roster IN (0, 1))`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind, alarm_key, due_at, created_at, updated_at)
       SELECT 'parent_participant_migration', child.parent_id || ':' || child.substream_id, 0, 0, 0
         FROM parent_children child JOIN parent_metadata parent ON parent.parent_id = child.parent_id
        WHERE parent.parent_kind = 'workstream' AND child.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM parent_participant_migrations migration
                           WHERE migration.parent_id = child.parent_id AND migration.substream_id = child.substream_id)
          AND (EXISTS (SELECT 1 FROM parent_child_projections source
                        WHERE source.parent_id = child.parent_id AND source.substream_id = child.substream_id)
            OR EXISTS (SELECT 1 FROM parent_breakout_members member
                        WHERE member.parent_id = child.parent_id AND member.substream_id = child.substream_id))
       UNION
       SELECT 'parent_participant_migration', source.parent_id || ':0', 0, 0, 0
         FROM parent_child_projections source JOIN parent_metadata parent ON parent.parent_id = source.parent_id
        WHERE source.substream_id = '0' AND parent.parent_kind = 'workstream'
          AND NOT EXISTS (SELECT 1 FROM parent_children child WHERE child.parent_id = source.parent_id AND child.substream_id = '0')
          AND NOT EXISTS (SELECT 1 FROM parent_participant_migrations migration WHERE migration.parent_id = source.parent_id AND migration.substream_id = '0')`,
  ],
}, {
  version: 128,
  description: "store Sidekick consent separately from human access and receipt prepared delegation changes",
  statements: SIDEKICK_DELEGATION_SCHEMA_STATEMENTS,
}, {
  version: 129,
  description: "separate run coordinators and legacy task accounts from Sidekick human access",
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN legacy_account_user_id TEXT`,
    `ALTER TABLE automation_directory ADD COLUMN delegation_attention_code TEXT`,
    `ALTER TABLE automation_directory ADD COLUMN delegation_migrated INTEGER NOT NULL DEFAULT 0 CHECK(delegation_migrated IN (0,1))`,
    `UPDATE automation_directory SET legacy_account_user_id=COALESCE(run_as_user_id,author_user_id)`,
    `ALTER TABLE sidekick_runs ADD COLUMN coordinator_user_id TEXT`,
    `UPDATE sidekick_runs SET coordinator_user_id=run_as_user_id WHERE run_as_user_id IS NOT NULL`,
    `CREATE TABLE sidekick_claim_access(sidekick_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(sidekick_id,user_id)) STRICT`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind,alarm_key,due_at,created_at,updated_at)
     SELECT 'sidekick_delegation_migration',automation_id || ':0',0,0,0 FROM automation_directory WHERE region IS NOT NULL`,
  ],
}, {
  version: 130,
  description: "reconcile configured Sidekick sources after connection authority changes",
  statements: SIDEKICK_SOURCE_CONNECTION_SCHEMA_STATEMENTS,
}, {
  version: 131,
  description: "automatically enroll existing Sidekick creators without replacing recorded withdrawals",
  statements: [
    `UPDATE automation_directory SET delegation_migrated=0
      WHERE region IS NOT NULL AND lifecycle<>'deleted'
        AND NOT EXISTS (SELECT 1 FROM sidekick_delegations grant
          WHERE grant.sidekick_id=automation_id AND grant.user_id=author_user_id)`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind,alarm_key,due_at,created_at,updated_at)
     SELECT 'sidekick_delegation_migration',automation_id || ':0',0,0,0 FROM automation_directory
      WHERE region IS NOT NULL AND lifecycle<>'deleted' AND delegation_migrated=0`,
  ],
}, {
  version: 132,
  description: "count Sidekick run finishes toward a scheduled wizard review and record each review request",
  statements: SIDEKICK_REVIEW_SCHEMA_STATEMENTS,
}, {
  version: 133,
  description: "resume a stopped thread backfill where it stopped, and bound each pass to the conversations it started with",
  statements: THREAD_BACKFILL_RESUME_MIGRATION,
}, {
  version: 134,
  description: "record when a person became a Channel participant, so Activity tells them only what happened after",
  // See SPACE_VIEWER_JOINED_AT_MIGRATION.
  statements: SPACE_VIEWER_JOINED_AT_MIGRATION,
}, {
  version: 135,
  description: "receipt each conversation the retirement walk closes, so an interrupted pass keeps its progress",
  statements: [
    // Keyed by the conversation object's own identity: its name is derived
    // from the parent id and substream id alone, whatever kind the parent is.
    // A row means that object confirmed its tombstone; the parent's receipt in
    // `workspace_retirement_graph` still decides completion. See
    // docs/workspace-retirement.md#retiring-a-workspace.
    `CREATE TABLE workspace_retirement_children (
      parent_id TEXT NOT NULL,
      substream_id TEXT NOT NULL,
      retired_at INTEGER NOT NULL,
      PRIMARY KEY (parent_id, substream_id)
    ) STRICT`,
  ],
}, {
  // Versions 136 to 140 are the Canvases and Sidekicks pivot's schema, one
  // migration per subsystem: each table it creates is created in its final
  // shape and each table it widens is copied once. None shipped before they
  // were folded; docs/workstream-durable-object.md#sql-only-schema-migration
  // records the fold.
  version: 136,
  description: "the Sidekick schema for Canvases and Sidekicks: run rows in the shared conversation, run requesters, audiences and viewer reads; the demo seed column retires, and a Thread-owned Sidekick keeps its owner's audience",
  // See SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS, SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS,
  // SIDEKICK_RUN_SEED_DROP_STATEMENTS, SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS and
  // docs/automation-lifecycle.md.
  statements: [
    ...SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS,
    ...SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS,
    ...SIDEKICK_RUN_SEED_DROP_STATEMENTS,
    ...SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS,
    // The Canvases and Sidekicks decision: a Thread no longer owns a
    // Sidekick. Its audience is kept, as `convertThreadToCanvas` keeps a
    // Thread's: a Sidekick owned by an Organization-wide Thread (and, when a
    // Breakout owned it, an Organization-wide Breakout) becomes an
    // Organization Sidekick; one owned by a personal Thread or a personal
    // Breakout becomes a `people` Sidekick shared with that owner's viewers,
    // the narrower owner's when both are personal. A viewer row is what
    // admitted a person to a personal Thread or Breakout, so every one is
    // kept except the author's, whom the audience never lists; admission
    // still requires the person to be in the Organization when they read. An
    // owner with no directory row left fails closed: the Sidekick becomes
    // personal to its author. The owning columns stay as dead columns
    // (released CHECKs name them), so the row's home is cleared to satisfy
    // the scope CHECK. A Sidekick a room archive paused under the old rule is
    // archived, as the current rule would have left it. See
    // docs/automation-lifecycle.md#creation-and-ownership.
    //
    // It bumped only the owning room's rail, and no row has one after this;
    // dropped first so clearing the home bumps no owning room. The conversion
    // still bumps the rails of the rooms that recommend or attach a converted
    // Sidekick, through `channel_rail_sidekick_listed_update`.
    `DROP TRIGGER IF EXISTS channel_rail_sidekick_owner_update`,
    // The old rule read a room archive's marker as terminal whatever the
    // lifecycle, so a draft or active row that carries it is archived too
    // rather than becoming a live Organization Sidekick.
    `UPDATE automation_directory SET lifecycle = 'deleted', paused_by = NULL
      WHERE owning_room_archived_at IS NOT NULL AND lifecycle <> 'deleted'`,
    // A personal Breakout's viewers, whatever its Thread's scope.
    `INSERT OR IGNORE INTO sidekick_audience (sidekick_id, user_id, added_at)
      SELECT sidekick.automation_id, viewer.user_id, viewer.projected_at
        FROM automation_directory sidekick
        JOIN breakouts breakout ON breakout.workstream_id = sidekick.owning_workstream_id
         AND breakout.substream_id = sidekick.owning_substream_id AND breakout.scope = 'personal'
        JOIN breakout_viewers viewer ON viewer.workstream_id = breakout.workstream_id
         AND viewer.substream_id = breakout.substream_id
       WHERE sidekick.scope = 'workstream' AND sidekick.owning_substream_id <> '0'
         AND viewer.user_id <> sidekick.author_user_id`,
    // Otherwise a personal Thread's viewers.
    `INSERT OR IGNORE INTO sidekick_audience (sidekick_id, user_id, added_at)
      SELECT sidekick.automation_id, viewer.user_id, COALESCE(viewer.participant_added_at, viewer.projected_at)
        FROM automation_directory sidekick
        JOIN channels thread ON thread.workstream_id = sidekick.owning_workstream_id AND thread.scope = 'personal'
        JOIN channel_viewers viewer ON viewer.workstream_id = thread.workstream_id
       WHERE sidekick.scope = 'workstream' AND viewer.user_id <> sidekick.author_user_id
         AND NOT EXISTS (SELECT 1 FROM breakouts breakout
           WHERE breakout.workstream_id = sidekick.owning_workstream_id
             AND breakout.substream_id = sidekick.owning_substream_id AND breakout.scope = 'personal')`,
    `UPDATE automation_directory SET
        scope = CASE WHEN EXISTS (SELECT 1 FROM channels thread
            WHERE thread.workstream_id = automation_directory.owning_workstream_id AND thread.scope = 'workspace')
          AND (automation_directory.owning_substream_id = '0' OR EXISTS (SELECT 1 FROM breakouts breakout
            WHERE breakout.workstream_id = automation_directory.owning_workstream_id
              AND breakout.substream_id = automation_directory.owning_substream_id AND breakout.scope = 'workspace'))
          THEN 'workspace' ELSE 'personal' END,
        owning_workstream_id = NULL, owning_substream_id = '0'
      WHERE scope = 'workstream'`,
  ],
}, {
  version: 137,
  description: "the Canvas schema: directory, participants, access requests and artifacts; pins, Sidekick attachments, the retirement graph and memory digest holders admit a Canvas",
  // See CANVAS_SCHEMA_STATEMENTS and docs/canvases.md#data-model,
  // CANVAS_ACCESS_REQUESTS_STATEMENTS and docs/canvas-access-requests.md,
  // MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION, MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION
  // and docs/agent-memory.md, RETIREMENT_GRAPH_CANVAS_MIGRATION and docs/workspace-retirement.md.
  statements: [
    ...CANVAS_SCHEMA_STATEMENTS,
    ...CANVAS_ACCESS_REQUESTS_STATEMENTS,
    ...CANVAS_ARTIFACTS_STATEMENTS,
    ...SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS,
    ...CANVAS_SIDEKICK_PINS_STATEMENTS,
    ...RETIREMENT_GRAPH_CANVAS_MIGRATION,
    ...MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION,
    ...MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION,
  ],
}, {
  version: 138,
  description: "admit the Sidekick run, reply, pinned-Canvas version and access-request notices among the notification intents",
  // See NOTIFICATION_INTENTS_CANVAS_SIDEKICK_KINDS_MIGRATION and docs/push-notifications.md.
  statements: NOTIFICATION_INTENTS_CANVAS_SIDEKICK_KINDS_MIGRATION,
}, {
  version: 139,
  description: "drop the Thread-era tables nothing reads, and the Thread rows of the shared tables",
  // See THREAD_ERA_TABLES_DROP_MIGRATION and docs/workspace-retirement.md.
  statements: THREAD_ERA_TABLES_DROP_MIGRATION,
}, {
  version: 140,
  description: "record each person's Activity: one row per notice they were sent",
  // See WORKSPACE_ACTIVITY_SCHEMA_STATEMENTS and docs/activity.md.
  statements: WORKSPACE_ACTIVITY_SCHEMA_STATEMENTS,
}, {
  version: 141,
  description: "drop the Thread, Breakout and Channel tables the Thread operations kept, and digest schedules",
  // See THREAD_ERA_PARENTS_DROP_MIGRATION and docs/workspace-retirement.md.
  statements: THREAD_ERA_PARENTS_DROP_MIGRATION,
}, {
  version: 142,
  description: "retain a Canvas archive tombstone and remove archived Canvases from active admission",
  statements: [...CANVAS_ARCHIVE_STATEMENTS, ...MEMORY_DIGEST_CANVAS_ARCHIVE_TRIGGER],
}, {
  version: 143,
  description: "retire email admission and addresses while preserving Sidekick definitions and conversations",
  statements: [
    `UPDATE sidekick_revisions SET definition_json = json_set(definition_json, '$.triggers',
       json(COALESCE((SELECT json_group_array(json(value)) FROM json_each(definition_json, '$.triggers')
         WHERE json_extract(value, '$.type') <> 'inbound_email'), '[]')))
      WHERE EXISTS (SELECT 1 FROM json_each(definition_json, '$.triggers')
        WHERE json_extract(value, '$.type') = 'inbound_email')`,
    // Keep the accepted loading decision: retiring a trigger must not expose
    // its instructions to conversations. Only an explicit publication or
    // manager reconciliation may change that capability.
    `UPDATE sidekick_runs SET opening_json = json_remove(opening_json, '$.resourceId') WHERE opening_json IS NOT NULL`,
    `ALTER TABLE automation_directory DROP COLUMN email_address`,
    `DROP TABLE sidekick_email_receipts`,
    `DROP TABLE IF EXISTS automation_email_receipts`,
    `DROP TABLE IF EXISTS automation_email_rate_windows`,
    `DROP TABLE IF EXISTS workstream_email_receipts`,
  ],
}, {
  version: 144,
  description: "a Sidekick's Canvas attachments become the one record of which Canvases it works on, and mark the one a Canvas's Chat made",
  // See SIDEKICK_CANVAS_ATTACHMENT_STATEMENTS and docs/automation-lifecycle.md#attached-conversations.
  statements: SIDEKICK_CANVAS_ATTACHMENT_STATEMENTS,
}, {
  version: 145,
  description: "index live child projections so Canvas activity reads do not scan completed history",
  statements: [
    `CREATE INDEX sidekick_child_projections_running_idx ON sidekick_child_projections(sidekick_id)
      WHERE json_extract(effect_json, '$.archivedAt') IS NULL
        AND json_extract(effect_json, '$.state') IN ('scheduled', 'running', 'preparing_context', 'waiting_capacity', 'interrupting')`,
  ],
}, {
  version: 146,
  description: "record who lets events into a Sidekick apart from who it may act as, and the requests that ask",
  // See SIDEKICK_SOURCE_SCHEMA_STATEMENTS and docs/sidekick-sources.md. The
  // second list admits a request's three notice kinds on the intents and
  // Activity (SIDEKICK_SOURCE_NOTICE_SCHEMA_STATEMENTS).
  statements: [...SIDEKICK_SOURCE_SCHEMA_STATEMENTS, ...SIDEKICK_SOURCE_NOTICE_SCHEMA_STATEMENTS],
}, { version: 147, description: 'separate Canvas artifact audiences and durably propagate local serving access',
  statements: CANVAS_ARTIFACT_ACCESS_STATEMENTS,
}, {
  version: 148,
  description: "record whether anyone has chosen a Canvas's artifact audience, so an agent's default never overrides a choice",
  // Every existing Canvas counts as chosen: its audience may be a manager's
  // deliberate choice, and nothing stored says otherwise.
  statements: [
    `ALTER TABLE canvas_directory ADD COLUMN artifact_visibility_chosen INTEGER NOT NULL DEFAULT 0
      CHECK(artifact_visibility_chosen IN (0,1))`,
    `UPDATE canvas_directory SET artifact_visibility_chosen = 1`,
  ],
}, {
  version: 149,
  description: "the audiences a new Canvas starts with, chosen by the Organization's administrators",
  // See canvas-sharing-defaults.ts. No row is every default.
  statements: CANVAS_SHARING_DEFAULTS_STATEMENTS,
}, {
  version: 150,
  description: "a Canvas's notices: the kind they record, whether a Canvas turned them on, and each person's choice for one Canvas",
  // See canvas-notices.ts and docs/PRDs/2026-11-14_canvas-notices.
  statements: CANVAS_NOTICES_SCHEMA_STATEMENTS,
}, {
  version: 151,
  description: "tell a guest's other Organizations when a Canvas shared with them here changes",
  // See canvas-share-federation.ts and docs/canvas-share-federation.md. No
  // backfill: a list is built from the Canvases themselves whenever a socket
  // subscribes, so nothing here has to catch up.
  statements: CANVAS_SHARE_FEDERATION_STATEMENTS,
}, CANVA_RETIREMENT_MIGRATION, {
  version: 153,
  description: "record the provider item a connector event is about, apart from its resource",
  // See NormalizedActivity.item and docs/connectors.md. A stored event
  // without one reads as its resource being the item, which is what every
  // adapter meant before Gmail and GitHub named a message or a comment. Gmail
  // is backfilled because its subject already held the message id the item
  // carries now, so a stored email event reads back as a new one would; a
  // GitHub event's comment or review id is not in its stored subject, so it
  // stays without one. The id is checked against the column's bounds so an
  // odd stored subject is skipped rather than failing the migration.
  statements: [
    `ALTER TABLE workspace_connector_events ADD COLUMN item_type TEXT
       CHECK (item_type IS NULL OR length(item_type) BETWEEN 1 AND 200)`,
    `ALTER TABLE workspace_connector_events ADD COLUMN item_id TEXT
       CHECK (item_id IS NULL OR length(item_id) BETWEEN 1 AND 2000)
       CHECK ((item_id IS NULL) = (item_type IS NULL))`,
    `UPDATE workspace_connector_events
        SET item_type = 'gmail_message', item_id = json_extract(subject_json, '$.messageId')
      WHERE provider = 'google' AND resource_type = 'gmail_thread' AND item_type IS NULL
        AND json_valid(subject_json) AND json_type(subject_json, '$.messageId') = 'text'
        AND length(json_extract(subject_json, '$.messageId')) BETWEEN 1 AND 2000`,
  ],
}, GENERIC_WEBHOOK_RETIREMENT_MIGRATION, {
  version: 155,
  description: "give the connectors onboarding stage its new place after personal setup",
  // The stage once came before personal setup and was retired in October; a
  // row still parked there has not set up a profile, so it resumes at personal
  // setup as reading it did until now. From here on `connectors` is the Gmail
  // and Google Drive step that follows personal setup (onboarding-journey.ts).
  statements: [
    `UPDATE onboarding_journeys SET stage = 'profile', revision = revision + 1 WHERE stage = 'connectors'`,
  ],
}];
