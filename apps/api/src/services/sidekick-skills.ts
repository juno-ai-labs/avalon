import { asAutomationId, asUserId, asWorkspaceId, type SidekickSkillSource, type WorkstreamWorkflowInput } from "@rally/contracts";
import type { HarnessSkill } from "@rally/agent-harness";
import type { Env } from "../env";
import { automationDOName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createIdentityObjectPort } from "../runtime/identity-port";

export const sidekickSkillName = (id: string): string => `sidekick-${id}`;
export const sidekickSkillRef = (id: string): string => `platform:${sidekickSkillName(id)}`;
export function sidekickHarnessSkill(source: SidekickSkillSource): HarnessSkill {
  return { name: sidekickSkillName(source.id), description: `${source.name}: ${source.description}`,
    whenToUse: source.whenToUse, body: source.instructions };
}

/** Resolve authority on every attempt, including attempts restoring pinned content. */
export async function resolveSidekickSkills(env: Env, input: WorkstreamWorkflowInput, pinnedIds?: readonly string[]): Promise<SidekickSkillSource[]> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const ids = pinnedIds ?? await workspace.sidekickSkillCandidates({ workspaceId });
  const identityPort = createIdentityObjectPort(env, input.workspaceId, input.parentId, undefined, input.substreamId ?? "0");
  const [identity, participants] = await Promise.all([identityPort.identity(), identityPort.participants()]);
  if (!identity || identity.archived_at !== null) return [];
  const sources = await Promise.all(ids.map(async (id) => {
    const automationId = asAutomationId(id);
    const sidekick = await durableObjectStubForWorkspace(env, env.AUTOMATION_DOS, workspaceId, automationDOName(env.AVALON_REGION, workspaceId, automationId));
    return sidekick.readSkillSource({ workspaceId, automationId,
      principalUserId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
      conversationParentId: input.parentId,
      existingExecution: pinnedIds !== undefined,
      audienceScope: identity.scope === "workspace" ? "workspace" : "personal",
      audienceUserIds: participants.map((person) => asUserId(person.user_id)),
    });
  }));
  return sources.filter((source) => source !== null);
}
