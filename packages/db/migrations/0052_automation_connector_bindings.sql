-- Activity automations created before connector bindings were enforced stored
-- an empty object and matched every connection visible to their scope. Freeze
-- that legacy visibility into an explicit one-time connection snapshot so the
-- fail-closed consumer does not silently disable existing subscriptions.
UPDATE automation_subscriptions
SET connector_bindings_json = COALESCE(
  (
    SELECT json_group_object(connection.model_plugin_id, connection.id)
    FROM connector_connections AS connection
    WHERE connection.workspace_id = automation_subscriptions.workspace_id
      AND connection.status <> 'disabled'
      AND (
        connection.scope = 'workspace'
        OR (
          automation_subscriptions.scope = 'personal'
          AND connection.scope = 'personal'
          AND connection.owner_user_id = automation_subscriptions.owner_user_id
        )
      )
  ),
  '{}'
)
WHERE connector_bindings_json = '{}'
  AND EXISTS (
    SELECT 1
    FROM automation_template_versions AS version,
         json_each(version.trigger_definitions_json) AS trigger
    WHERE version.id = automation_subscriptions.template_version_id
      AND json_extract(trigger.value, '$.type') IN (
        'connector_activity',
        'semantic_activity',
        'webhook'
      )
  );
