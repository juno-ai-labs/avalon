import { terminalPollFailure } from "../workflows/connector-poll-result";
import { recordConnectorPollFailure as recordPollingHealthFailure } from "./integrations";

/** The caller supplies the workspace-routed database that owns this connection. */
export async function recordConnectorPollFailure(
  database: D1Database,
  input: { workspaceId: string; connectionId: string },
  error: unknown,
  at: string,
): Promise<{ code: string; message: string }> {
  const reason = terminalPollFailure(error);
  await recordPollingHealthFailure(database, input, { ...reason, source: "connector_poll" }, at);
  return reason;
}
