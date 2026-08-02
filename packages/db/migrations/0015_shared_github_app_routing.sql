-- The public GitHub App has one setup URL and one webhook URL. The Global
-- ingress keeps only opaque installation/workspace routing metadata; signed
-- webhook bodies are handed to every regional data plane that owns a binding.
CREATE TABLE github_installation_routes (
  installation_id TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 32
    AND installation_id NOT GLOB '*[^0-9]*'
  ),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (installation_id, region, workspace_id)
);

CREATE INDEX github_installation_routes_active_idx
  ON github_installation_routes(installation_id, status, region);

-- A GitHub installation lifecycle delivery can win the race with the setup
-- redirect. Retain the exact signed bytes briefly, then replay them as soon as
-- setup establishes at least one regional route.
CREATE TABLE github_ingress_pending_deliveries (
  delivery_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 32
    AND installation_id NOT GLOB '*[^0-9]*'
  ),
  event_type TEXT NOT NULL,
  action TEXT,
  signature_header TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  dispatched_at TEXT
);

CREATE INDEX github_ingress_pending_installation_idx
  ON github_ingress_pending_deliveries(installation_id, dispatched_at, expires_at);
