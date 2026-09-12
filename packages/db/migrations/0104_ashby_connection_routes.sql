-- Opaque cross-region ingress routing only. Installation secrets and payloads stay regional.
CREATE TABLE ashby_connection_routes (
  connection_id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  updated_at TEXT NOT NULL
);
