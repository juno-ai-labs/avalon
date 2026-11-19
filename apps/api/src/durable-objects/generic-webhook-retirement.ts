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
 * or one of its plugins. `alias` is the `json_each` row the trigger is read
 * from, so the test can be nested inside another array's.
 */
function keepTrigger(alias: string): string {
  return `COALESCE(json_extract(${alias}.value, '$.type'), '') <> 'webhook'
  AND COALESCE(json_extract(${alias}.value, '$.connectorType'), '') <> 'generic_webhook'
  AND COALESCE(json_extract(${alias}.value, '$.suggestedSourcePluginId'), '') NOT IN ${WEBHOOK_PLUGIN_IDS}`;
}
const KEEP_TRIGGER = keepTrigger("entry");
/** At least one of the revision's triggers survives the purge. */
const KEEPS_A_TRIGGER = `EXISTS (SELECT 1 FROM json_each(definition_json, '$.triggers') AS kept WHERE ${keepTrigger("kept")})`;
/**
 * A stored evaluator rule names its source by binding key and, sometimes, a
 * suggested plugin; never a connector type. So a rule also goes when its
 * binding key is one a removed trigger of the same revision bound.
 */
const KEEP_RULE = `${KEEP_EVALUATOR}
  AND COALESCE(json_extract(entry.value, '$.source.sourceBindingKey'), '') NOT IN (
    SELECT json_extract(removed.value, '$.sourceBindingKey') FROM json_each(definition_json, '$.triggers') AS removed
     WHERE NOT (${keepTrigger("removed")}) AND json_extract(removed.value, '$.sourceBindingKey') IS NOT NULL)`;
const KEEP_PLUGIN = `COALESCE(json_extract(entry.value, '$.pluginId'), '') NOT IN ${WEBHOOK_PLUGIN_IDS}`;
const KEEP_PLUGIN_ID = `entry.value NOT IN ${WEBHOOK_PLUGIN_IDS}`;
/** A custom tool that still requires some plugin once the generic webhooks' are taken out. */
const KEEP_TOOL = `EXISTS (SELECT 1 FROM json_each(entry.value, '$.requiredPlugins') AS required
  WHERE required.value NOT IN ${WEBHOOK_PLUGIN_IDS})`;
/** Each kept custom tool, without the generic webhooks' plugin ids in `requiredPlugins`. */
const PURGED_TOOLS = `(SELECT json_group_array(json_set(json(entry.value), '$.requiredPlugins', (
    SELECT json_group_array(required.value) FROM json_each(entry.value, '$.requiredPlugins') AS required
     WHERE required.value NOT IN ${WEBHOOK_PLUGIN_IDS})))
  FROM json_each(definition_json, '$.customTools') AS entry WHERE ${KEEP_TOOL})`;

/**
 * Retire the generic webhook connector and the Sidekick `webhook` trigger
 * (docs/connectors.md, changelog "An event names its item; the generic webhook
 * connector and `webhook` trigger are removed").
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
 *   its live projection and from each stored revision. So are a revision's
 *   evaluator rules bound to a removed trigger's binding key, and the generic
 *   webhooks' plugin ids in its custom tools' `requiredPlugins`; a custom tool
 *   that required nothing else goes too, since it could not run. A revision's
 *   `definition_hash` is written, never verified, and is left as it was.
 *
 * What a Sidekick that only listened for webhooks becomes: one with no
 * triggers, which nothing starts on its own. Its lifecycle is unchanged, so an
 * active one stays active and can still be asked to run. If it also had custom
 * tools its revision stops being ready (`ready` false, in the column and the
 * draft), because a ready draft with tools must have a trigger; it keeps
 * working as accepted, and applying it again waits for an edit that gives it
 * one. One with no tools is a ready, instruction-only Sidekick.
 *
 * There are no schedules or resource watches to retire: the connector neither
 * polled nor supported watches. Its `config_json` (the event-type allowlist
 * and a creation idempotency key) holds nothing secret and stays.
 *
 * Triggers then refuse a new generic webhook connection, a revival or an
 * event registration from any writer still running the old code. A later
 * migration that rebuilds `connector_connections` drops the triggers on it
 * with the table: it must recreate these, and Canva's (migration 152).
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
    // Before the triggers go: a rule is matched to them by binding key.
    `UPDATE sidekick_revisions
        SET evaluator_rules_json = ${filteredArray("evaluator_rules_json", "$.evaluators", KEEP_RULE)}
      WHERE evaluator_rules_json IS NOT NULL
        AND ${holdsRejected("evaluator_rules_json", "$.evaluators", KEEP_RULE)}`,
    `UPDATE sidekick_revisions
        SET definition_json = json_set(definition_json, '$.customTools', ${PURGED_TOOLS})
      WHERE EXISTS (SELECT 1 FROM json_each(definition_json, '$.customTools') AS tool,
          json_each(tool.value, '$.requiredPlugins') AS required WHERE required.value IN ${WEBHOOK_PLUGIN_IDS})`,
    // A ready draft with custom tools needs a trigger, so one the purge is
    // about to leave without any is no longer ready: it still parses, and
    // applying it again waits for an edit that gives it one.
    `UPDATE sidekick_revisions
        SET definition_json = json_set(definition_json, '$.ready', json('false')), ready = 0
      WHERE json_extract(definition_json, '$.ready') = 1
        AND json_array_length(definition_json, '$.customTools') > 0
        AND ${holdsRejected("definition_json", "$.triggers", KEEP_TRIGGER)}
        AND NOT ${KEEPS_A_TRIGGER}`,
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
