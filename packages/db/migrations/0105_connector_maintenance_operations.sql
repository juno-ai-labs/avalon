-- Regional, content-free operation receipts. Provider credentials remain in WorkspaceDO.
CREATE TABLE connector_maintenance_operations (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
);
