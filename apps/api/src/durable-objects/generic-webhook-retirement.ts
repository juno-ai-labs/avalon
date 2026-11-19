import { filteredArray, holdsRejected } from "./connector-retirement-sql";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";

/**
 * Generic webhook connections, as SQL: the plugin ids they were given, which
 * is how a Sidekick's definition names them, and the connections themselves.
 * Rows are kept (disabled) so these stay answerable after the purge; the
 * `connector_type` CHECK constraints still admit `generic_webhook` because
 * narrowing them would rebuild `connector_connections` and every dependent for
 * a value the triggers below already refuse.
 */
const WEBHOOK_PLUGIN_IDS = `(SELECT model_plugin_id FROM connector_connections WHERE connector_type = 'generic_webhook')`;
const WEBHOOK_CONNECTION_IDS = `(SELECT id FROM connector_connections WHERE connector_type = 'generic_webhook')`;

const KEEP_EVALUATOR = `COALESCE(json_extract(entry.value, '$.source.connectorType'), '') <> 'generic_webhook'
  AND COALESCE(json_extract(entry.value, '$.source.suggestedSourcePluginId'), '') NOT IN ${WEBHOOK_PLUGIN_IDS}`;
/**
 * A `webhook` trigger existed only for this connector, so every one goes,
 * whichever plugin it names; so does an activity trigger naming the connector
 * or one of its plugins.
 */
const KEEP_TRIGGER = `COALESCE(json_extract(entry.value, '$.type'), '') <> 'webhook'
  AND COALESCE(json_extract(entry.value, '$.connectorType'), '') <> 'generic_webhook'
  AND COALESCE(json_extract(entry.value, '$.suggestedSourcePluginId'), '') NOT IN ${WEBHOOK_PLUGIN_IDS}`;
const KEEP_PLUGIN = `COALESCE(json_extract(entry.value, '$.pluginId'), '') NOT IN ${WEBHOOK_PLUGIN_IDS}`;
const KEEP_PLUGIN_ID = `entry.value NOT IN ${WEBHOOK_PLUGIN_IDS}`;

/**
 * Retire the generic webhook connector and the Sidekick `webhook` trigger
 * (docs/connectors.md, changelog 2026-11-19).
 *
 * The adapter, its ingress route, its creation and secret-rotation paths and
 * the `webhook` trigger type are gone from the code, so nothing could use a
 * generic webhook connection again, and a stored `webhook` trigger no longer
 * parses as a Sidekick definition. This makes stored state say so instead of
 * leaving live-looking rows and unreadable definitions behind:
 *
 * - every generic webhook connection is disabled and its credentials cleared,
 *   as `ConnectionService.disable` does. Its credentials were the only place
 *   its HMAC signing secret lived, so clearing them retires the secret;
 * - its event registrations are removed, and its `webhook_receipts` rows —
 *   the signature-hash replay ledger, swept only when a delivery for the same
 *   connection claims one, which can no longer happen — are deleted;
 * - every Sidekick's `webhook` triggers, and its evaluators, triggers and
 *   plugin bindings that named a generic webhook connection, are removed from
 *   its live projection and from each stored revision. A revision's
 *   `definition_hash` is written, never verified, and is left as it was.
 *
 * There are no schedules or resource watches to retire: the connector neither
 * polled nor supported watches. Its `config_json` (the event-type allowlist
 * and a creation idempotency key) holds nothing secret and stays.
 *
 * Triggers then refuse a new generic webhook connection, a revival or an
 * event registration from any writer still running the old code.
 */
export const GENERIC_WEBHOOK_RETIREMENT_MIGRATION: DurableObjectSqliteMigration = {
  version: 154,
  description: "retire the generic webhook connector: disable its connections and remove webhook triggers",
  statements: [
    `UPDATE automation_directory
        SET evaluator_projection_json = ${filteredArray("evaluator_projection_json", "$", KEEP_EVALUATOR)}
      WHERE evaluator_projection_json IS NOT NULL
        AND ${holdsRejected("evaluator_projection_json", "$", KEEP_EVALUATOR)}`,
    `UPDATE automation_directory
        SET default_plugin_ids_json = ${filteredArray("default_plugin_ids_json", "$", KEEP_PLUGIN_ID)}
      WHERE default_plugin_ids_json IS NOT NULL
        AND ${holdsRejected("default_plugin_ids_json", "$", KEEP_PLUGIN_ID)}`,
    // Binding key to plugin id: drop the keys whose plugin is a generic webhook's.
    `UPDATE automation_directory
        SET activity_source_plugin_ids_json = (SELECT json_group_object(entry.key, entry.value)
          FROM json_each(activity_source_plugin_ids_json) AS entry WHERE ${KEEP_PLUGIN_ID})
      WHERE activity_source_plugin_ids_json IS NOT NULL
        AND ${holdsRejected("activity_source_plugin_ids_json", "$", KEEP_PLUGIN_ID)}`,
    // Plugin id to connection id: drop the generic webhooks' plugin ids.
    `UPDATE automation_directory
        SET connector_bindings_json = (SELECT json_group_object(entry.key, entry.value)
          FROM json_each(connector_bindings_json) AS entry WHERE entry.key NOT IN ${WEBHOOK_PLUGIN_IDS})
      WHERE connector_bindings_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(connector_bindings_json) AS entry WHERE entry.key IN ${WEBHOOK_PLUGIN_IDS})`,
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
      WHERE connector_type = 'generic_webhook' AND state = 'active'`,
    `DELETE FROM webhook_receipts WHERE connection_id IN ${WEBHOOK_CONNECTION_IDS}`,
    `UPDATE connector_connections
        SET status = 'disabled', encrypted_credentials = NULL, credential_iv = NULL, next_poll_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE connector_type = 'generic_webhook'
        AND (status <> 'disabled' OR encrypted_credentials IS NOT NULL OR next_poll_at IS NOT NULL)`,
    `CREATE TRIGGER generic_webhook_connections_retired BEFORE INSERT ON connector_connections
       WHEN NEW.connector_type = 'generic_webhook'
       BEGIN SELECT RAISE(ABORT, 'generic_webhook_retired'); END`,
    `CREATE TRIGGER generic_webhook_connection_revival_retired BEFORE UPDATE OF status ON connector_connections
       WHEN NEW.connector_type = 'generic_webhook' AND NEW.status <> 'disabled'
       BEGIN SELECT RAISE(ABORT, 'generic_webhook_retired'); END`,
    `CREATE TRIGGER generic_webhook_registrations_retired BEFORE INSERT ON workspace_external_event_registrations
       WHEN NEW.connector_type = 'generic_webhook'
       BEGIN SELECT RAISE(ABORT, 'generic_webhook_retired'); END`,
  ],
};
