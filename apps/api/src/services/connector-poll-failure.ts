import { terminalPollFailure } from "../workflows/connector-poll-result";

/** The caller supplies the workspace-routed database that owns this connection. */
export async function recordConnectorPollFailure(
  database: D1Database,
  input: { workspaceId: string; connectionId: string },
  error: unknown,
  at: string,
): Promise<{ code: string; message: string }> {
  const reason = terminalPollFailure(error);
  await database.prepare(
    `UPDATE connector_connections
     SET status = 'error', error_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).bind(JSON.stringify(reason), at, input.connectionId, input.workspaceId).run();
  return reason;
}
