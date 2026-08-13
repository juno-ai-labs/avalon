-- A JSON tool receipt can name more than one resource. This join makes that
-- dependency explicit so replacing or deleting a derivative invalidates the
-- complete receipt and queues its regional replay object for cleanup.
CREATE TABLE attachment_tool_receipts (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
  derivative_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, tool_invocation_id)
);

CREATE INDEX idx_attachment_tool_receipts_invocation
  ON attachment_tool_receipts(tool_invocation_id, resource_id);

CREATE TRIGGER resources_invalidate_attachment_receipts_before_delete
BEFORE DELETE ON resources
BEGIN
  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT invocation.output_ref, OLD.id, 'receipt', datetime('now'), datetime('now')
      FROM attachment_tool_receipts receipt
      JOIN tool_invocations invocation ON invocation.id = receipt.tool_invocation_id
     WHERE receipt.resource_id = OLD.id AND invocation.output_ref IS NOT NULL;

  DELETE FROM tool_invocations
   WHERE id IN (
     SELECT tool_invocation_id FROM attachment_tool_receipts WHERE resource_id = OLD.id
   );
END;

CREATE TRIGGER resources_invalidate_attachment_receipts_before_derivative_change
BEFORE UPDATE OF model_content_sha256 ON resources
WHEN OLD.model_content_sha256 IS NOT NEW.model_content_sha256
BEGIN
  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT invocation.output_ref, OLD.id, 'receipt', datetime('now'), datetime('now')
      FROM attachment_tool_receipts receipt
      JOIN tool_invocations invocation ON invocation.id = receipt.tool_invocation_id
     WHERE receipt.resource_id = OLD.id
       AND receipt.derivative_sha256 IS NOT COALESCE(NEW.model_content_sha256, '')
       AND invocation.output_ref IS NOT NULL;

  DELETE FROM tool_invocations
   WHERE id IN (
     SELECT tool_invocation_id
       FROM attachment_tool_receipts
      WHERE resource_id = OLD.id
        AND derivative_sha256 IS NOT COALESCE(NEW.model_content_sha256, '')
   );
END;
