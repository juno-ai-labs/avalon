-- GitHub, Linear, and Notion deliver resource changes through signed webhooks.
-- Keep their watches enabled for direct activity routing, but remove the legacy
-- poll deadline so they never contribute a Durable Object scheduler alarm.
UPDATE resource_watches
   SET watch_type = 'webhook',
       next_poll_at = NULL
 WHERE connection_id IN (
   SELECT id
     FROM connector_connections
    WHERE connector_type IN ('github', 'linear', 'notion')
 );

-- Presentation/direct-routing state follows the enabled canonical watch even
-- when a webhook watch intentionally has no poll timestamp.
UPDATE workstream_resources AS wr
   SET watch_enabled = CASE
     WHEN EXISTS (
       SELECT 1
         FROM resource_watches rw
        WHERE rw.workstream_id = wr.workstream_id
          AND rw.resource_id = wr.resource_id
          AND rw.enabled = 1
     ) THEN 1
     ELSE 0
   END;
