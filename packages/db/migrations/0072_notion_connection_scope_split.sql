-- Before hosted MCP existed, Notion's public-integration bot grants were stored
-- as personal connections because a user approved the OAuth screen. Their
-- credentials and capabilities are nevertheless workspace bot credentials.
-- Convert only that historical dialect; new hosted-MCP rows carry the umbrella
-- capability below and must retain their personal owner.
UPDATE connector_connections
SET scope = 'workspace',
    owner_user_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE connector_type = 'notion'
  AND scope = 'personal'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(CASE
      WHEN json_valid(connector_connections.granted_scopes_json)
        THEN connector_connections.granted_scopes_json
      ELSE '[]'
    END)
    WHERE value = 'notion.personal.mcp'
  );
