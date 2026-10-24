import { type WorkstreamWorkflowInput } from "@rally/contracts";
import type { AuthContext, Env } from "../env";

/** Non-session agent operations resolve the acting user's current membership. */
export async function agentToolAuth(env: Env, input: WorkstreamWorkflowInput,
  sessionPrefix: string, refused: () => Error): Promise<AuthContext> {
  if (input.executionPrincipal.type !== "user") throw refused();
  const userId = input.executionPrincipal.userId;
  const member = await env.DB.prepare(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
  ).bind(input.workspaceId, userId).first<{ role: AuthContext["role"] }>();
  if (!member) throw refused();
  return { sessionId: `${sessionPrefix}:${input.harnessRunId}`, userId, workspaceId: input.workspaceId,
    region: env.AVALON_REGION, role: member.role, analyticsWorkspaceId: null, principal: "connector" };
}
