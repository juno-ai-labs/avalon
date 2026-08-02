-- Regional inbound-email ingestion uses an expiring lease rather than an
-- unbounded "in progress" marker. If a Worker is interrupted, a later Resend
-- retry can atomically reclaim the receipt after the lease expires.
ALTER TABLE workstream_email_receipts ADD COLUMN lease_token TEXT;
ALTER TABLE workstream_email_receipts ADD COLUMN lease_expires_at TEXT;

CREATE INDEX workstream_email_receipts_lease_idx
  ON workstream_email_receipts(lease_expires_at)
  WHERE processed_at IS NULL;

-- Resource authorization starts from an inbound resource and resolves its
-- attached work streams. The original composite primary key is ordered in the
-- opposite direction.
CREATE INDEX workstream_resources_resource_idx
  ON workstream_resources(resource_id, workstream_id);
