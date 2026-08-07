-- Connections created after the original Slack workspace-principal migration
-- did not receive a persisted policy row. Keep the runtime defaults explicit
-- so administrators can inspect and update every installed workspace app.
INSERT INTO slack_agent_policies (connection_id, created_at, updated_at)
SELECT id, created_at, updated_at
FROM connector_connections
WHERE connector_type = 'slack' AND scope = 'workspace'
ON CONFLICT(connection_id) DO NOTHING;
