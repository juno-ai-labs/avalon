-- A single public Linear app uses one webhook ingress. Global retains only the
-- minimum organization-to-region directory needed to hand exact signed bytes
-- to the regional data plane that owns each Avalon workspace connection.
CREATE TABLE linear_organization_routes (
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 200),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (organization_id, region, workspace_id, connection_id)
);

CREATE INDEX linear_organization_routes_active_idx
  ON linear_organization_routes(organization_id, status, region);

CREATE UNIQUE INDEX linear_organization_routes_connection_idx
  ON linear_organization_routes(connection_id);
