/**
 * Resolve provider relationships through the identity index.
 * The caller must first assert the owning Durable Object's workspace identity.
 */
export function resolveWorkspaceEventResources(sql: SqlStorage, input: {
  workspaceId: string;
  connectionId: string;
  provider: string;
  providerResourceId: string | null;
  entityKeys: readonly string[];
}): string[] {
  // One JSON binding avoids increasing SQLite's bound-variable count with
  // the number of provider keys. IN drives exact identity seeks; a correlated OR scans every
  // resource in the connection once for every incoming event.
  const keys = [...new Set([input.providerResourceId, ...input.entityKeys]
    .filter((key): key is string => key !== null))];
  return sql.exec<{ id: string }>(
    `SELECT id FROM resources
      WHERE workspace_id = ? AND connection_id = ? AND provider = ?
        AND provider_resource_id IS NOT NULL
        AND provider_resource_id IN (SELECT value FROM json_each(?))
      ORDER BY id`,
    input.workspaceId, input.connectionId, input.provider, JSON.stringify(keys),
  ).toArray().map((row) => row.id);
}
