import { filteredArray, holdsRejected } from "./connector-retirement-sql";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";

/**
 * Canva connections and triggers, as SQL: the plugin ids its connections were
 * given, which is how a Sidekick's definition names them, and the connections
 * themselves. Rows are kept (disabled) so these stay answerable after the
 * purge; the `connector_type` CHECK constraints still admit `canva` because
 * narrowing them would rebuild `connector_connections` and every dependent for
 * a value the trigger below already refuses.
 */
const CANVA_PLUGIN_IDS = `(SELECT model_plugin_id FROM connector_connections WHERE connector_type = 'canva')`;
const CANVA_CONNECTION_IDS = `(SELECT id FROM connector_connections WHERE connector_type = 'canva')`;

const KEEP_EVALUATOR = `COALESCE(json_extract(entry.value, '$.source.connectorType'), '') <> 'canva'
  AND COALESCE(json_extract(entry.value, '$.source.suggestedSourcePluginId'), '') NOT IN ${CANVA_PLUGIN_IDS}`;
const KEEP_TRIGGER = `COALESCE(json_extract(entry.value, '$.suggestedSourcePluginId'), '') NOT IN ${CANVA_PLUGIN_IDS}`;
const KEEP_PLUGIN = `COALESCE(json_extract(entry.value, '$.pluginId'), '') NOT IN ${CANVA_PLUGIN_IDS}`;
const KEEP_PLUGIN_ID = `entry.value NOT IN ${CANVA_PLUGIN_IDS}`;

/**
 * Retire the Canva connector (docs/connectors.md#2026-11-17).
 *
 * The adapter, its OAuth and its polling are gone from the code, so nothing
 * could use a Canva connection again; this makes stored state say so instead
 * of leaving live-looking rows behind. Each step is what a person disconnecting
 * Canva and deleting its triggers by hand would have caused:
 *
 * - every Canva connection is disabled and its credentials cleared, as
 *   `ConnectionService.disable` does (Rally can no longer reach Canva's
 *   revocation endpoint, so the remote grant lapses on Canva's side);
 * - its poll schedules are disabled, its event registrations removed and its
 *   resource watches deleted;
 * - each design's encrypted access envelope is cleared, while the design row
 *   stays, because conversations may name it and `artifact_registry` cascades
 *   from `resources`;
 * - every Sidekick's evaluators, triggers and plugin bindings that named a
 *   Canva connection are removed, from its live projection and from each
 *   stored revision, so no definition names a connector Rally no longer has.
 *   A revision's `definition_hash` is written, never verified, and is left as
 *   it was.
 *
 * Triggers then refuse a new Canva connection or event registration from any
 * writer still running the old code.
 */
export const CANVA_RETIREMENT_MIGRATION: DurableObjectSqliteMigration = {
  version: 152,
  description: "retire the Canva connector: disable its connections and remove its triggers",
  statements: [
    `UPDATE automation_directory
        SET evaluator_projection_json = ${filteredArray("evaluator_projection_json", "$", KEEP_EVALUATOR)}
      WHERE evaluator_projection_json IS NOT NULL
        AND ${holdsRejected("evaluator_projection_json", "$", KEEP_EVALUATOR)}`,
    `UPDATE automation_directory
        SET default_plugin_ids_json = ${filteredArray("default_plugin_ids_json", "$", KEEP_PLUGIN_ID)}
      WHERE default_plugin_ids_json IS NOT NULL
        AND ${holdsRejected("default_plugin_ids_json", "$", KEEP_PLUGIN_ID)}`,
    // Binding key to plugin id: drop the keys whose plugin is Canva's.
    `UPDATE automation_directory
        SET activity_source_plugin_ids_json = (SELECT json_group_object(entry.key, entry.value)
          FROM json_each(activity_source_plugin_ids_json) AS entry WHERE ${KEEP_PLUGIN_ID})
      WHERE activity_source_plugin_ids_json IS NOT NULL
        AND ${holdsRejected("activity_source_plugin_ids_json", "$", KEEP_PLUGIN_ID)}`,
    // Plugin id to connection id: drop Canva's plugin ids.
    `UPDATE automation_directory
        SET connector_bindings_json = (SELECT json_group_object(entry.key, entry.value)
          FROM json_each(connector_bindings_json) AS entry WHERE entry.key NOT IN ${CANVA_PLUGIN_IDS})
      WHERE connector_bindings_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(connector_bindings_json) AS entry WHERE entry.key IN ${CANVA_PLUGIN_IDS})`,
    `UPDATE sidekick_revisions
        SET evaluator_rules_json = ${filteredArray("evaluator_rules_json", "$.evaluators", KEEP_EVALUATOR)}
      WHERE evaluator_rules_json IS NOT NULL
        AND ${holdsRejected("evaluator_rules_json", "$.evaluators", KEEP_EVALUATOR)}`,
    `UPDATE sidekick_revisions
        SET definition_json = ${filteredArray("definition_json", "$.triggers", KEEP_TRIGGER)}
      WHERE ${holdsRejected("definition_json", "$.triggers", KEEP_TRIGGER)}`,
    `UPDATE sidekick_revisions
        SET definition_json = ${filteredArray("definition_json", "$.recommendedPlugins", KEEP_PLUGIN)}
      WHERE ${holdsRejected("definition_json", "$.recommendedPlugins", KEEP_PLUGIN)}`,
    `UPDATE workspace_external_event_registrations
        SET state = 'removed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE connector_type = 'canva' AND state = 'active'`,
    `UPDATE schedules SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE connector_connection_id IN ${CANVA_CONNECTION_IDS} AND enabled = 1`,
    `DELETE FROM resource_watches WHERE connection_id IN ${CANVA_CONNECTION_IDS}`,
    `UPDATE resources SET protected_access_json = NULL
      WHERE provider = 'canva' AND protected_access_json IS NOT NULL`,
    `UPDATE connector_connections
        SET status = 'disabled', encrypted_credentials = NULL, credential_iv = NULL, next_poll_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE connector_type = 'canva'
        AND (status <> 'disabled' OR encrypted_credentials IS NOT NULL OR next_poll_at IS NOT NULL)`,
    `CREATE TRIGGER canva_connections_retired BEFORE INSERT ON connector_connections
       WHEN NEW.connector_type = 'canva'
       BEGIN SELECT RAISE(ABORT, 'canva_retired'); END`,
    `CREATE TRIGGER canva_connection_revival_retired BEFORE UPDATE OF status ON connector_connections
       WHEN NEW.connector_type = 'canva' AND NEW.status <> 'disabled'
       BEGIN SELECT RAISE(ABORT, 'canva_retired'); END`,
    `CREATE TRIGGER canva_registrations_retired BEFORE INSERT ON workspace_external_event_registrations
       WHEN NEW.connector_type = 'canva'
       BEGIN SELECT RAISE(ABORT, 'canva_retired'); END`,
  ],
};
