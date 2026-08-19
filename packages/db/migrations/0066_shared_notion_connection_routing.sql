-- Notion issues one redirect URI and one webhook subscription per public
-- connection, so both regions share a single connection reached through the
-- Global ingress. Global retains only the minimum Notion-workspace-to-region
-- directory needed to hand exact signed bytes, and the authorization code, to
-- the regional data plane that owns each Avalon workspace connection.
CREATE TABLE notion_workspace_routes (
  notion_workspace_id TEXT NOT NULL CHECK (length(notion_workspace_id) BETWEEN 1 AND 200),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (notion_workspace_id, region, workspace_id, connection_id)
);

CREATE INDEX notion_workspace_routes_active_idx
  ON notion_workspace_routes(notion_workspace_id, status, region);

CREATE UNIQUE INDEX notion_workspace_routes_connection_idx
  ON notion_workspace_routes(connection_id);
