-- Workspace Slack installs use a fixed, reviewed capability bundle. Existing
-- installs receive the model-facing grants here and will be reported as
-- reconnect-required until Slack has granted the corresponding bot scopes.
UPDATE connector_connections
SET granted_scopes_json = '["slack.search","slack.messages.read","slack.files.read","slack.users.read","slack.messages.write","slack.conversations.write","slack.reactions.write","slack.agent","slack.notifications.write"]',
    updated_at = CURRENT_TIMESTAMP
WHERE connector_type = 'slack'
  AND scope = 'workspace'
  AND status <> 'disabled';
