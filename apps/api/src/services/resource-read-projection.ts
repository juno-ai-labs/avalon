/** Resource presentation fields shared by admitted and predicate-filtered reads. */
export const RESOURCE_READ_PROJECTION_SQL = `SELECT r.*,
    c.connector_type AS connector_type,
    CASE WHEN EXISTS (
      SELECT 1 FROM resource_watches rw
       WHERE rw.resource_id = r.id AND rw.workspace_id = r.workspace_id AND rw.enabled = 1
    ) THEN 1 ELSE 0 END AS watch_enabled
  FROM resources r
  LEFT JOIN connector_connections c ON c.id = r.connection_id`;
