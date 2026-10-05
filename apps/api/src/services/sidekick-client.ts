import { asWorkspaceId } from "@rally/contracts";

import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * A Sidekick, addressed where it lives: its Organization's `WorkspaceDO`.
 *
 * The methods keep the names `SidekickDO` answered, so a caller that used to
 * hold that object's stub changes only how it gets one. Every call is one RPC
 * to the Organization object, which imports a Sidekick still in its legacy
 * object before answering. See docs/hosted-conversation-parents.md.
 */
export async function sidekickClient(env: Env, workspaceId: string) {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  return sidekickClientFor(workspace);
}

/** The same client over an Organization stub the caller already holds. */
export function sidekickClientFor(target: DurableObjectStub<WorkspaceDO>) {
  return {
    create: (input: Parameters<WorkspaceDO["sidekickCreate"]>[0]) => target.sidekickCreate(input),
    saveDefinition: (input: Parameters<WorkspaceDO["sidekickSaveDefinition"]>[0]) => target.sidekickSaveDefinition(input),
    submitDefinition: (input: Parameters<WorkspaceDO["sidekickSubmitDefinition"]>[0]) => target.sidekickSubmitDefinition(input),
    apply: (input: Parameters<WorkspaceDO["sidekickApply"]>[0]) => target.sidekickApply(input),
    reconcileLoadable: (input: Parameters<WorkspaceDO["sidekickReconcileLoadable"]>[0]) => target.sidekickReconcileLoadable(input),
    readDetail: (input: Parameters<WorkspaceDO["sidekickReadDetail"]>[0]) => target.sidekickReadDetail(input),
    setAppearance: (input: Parameters<WorkspaceDO["sidekickSetAppearance"]>[0]) => target.sidekickSetAppearance(input),
    pause: (input: Parameters<WorkspaceDO["sidekickPause"]>[0]) => target.sidekickPause(input),
    resume: (input: Parameters<WorkspaceDO["sidekickResume"]>[0]) => target.sidekickResume(input),
    remove: (input: Parameters<WorkspaceDO["sidekickRemove"]>[0]) => target.sidekickRemove(input),
    runNow: (input: Parameters<WorkspaceDO["sidekickRunNow"]>[0]) => target.sidekickRunNow(input),
    runSeeded: (input: Parameters<WorkspaceDO["sidekickRunSeeded"]>[0]) => target.sidekickRunSeeded(input),
    listRuns: (input: Parameters<WorkspaceDO["sidekickListRuns"]>[0]) => target.sidekickListRuns(input),
    claimExecutionPrincipal: (input: Parameters<WorkspaceDO["sidekickClaimExecutionPrincipal"]>[0]) =>
      target.sidekickClaimExecutionPrincipal(input),
    externalEventAdmissionPlan: (input: Parameters<WorkspaceDO["sidekickExternalEventAdmissionPlan"]>[0]) =>
      target.sidekickExternalEventAdmissionPlan(input),
    admitExternalEvent: (input: Parameters<WorkspaceDO["sidekickAdmitExternalEvent"]>[0]) => target.sidekickAdmitExternalEvent(input),
    admitInboundEmail: (input: Parameters<WorkspaceDO["sidekickAdmitInboundEmail"]>[0]) => target.sidekickAdmitInboundEmail(input),
    readSkillSource: (input: Parameters<WorkspaceDO["sidekickReadSkillSource"]>[0]) => target.sidekickReadSkillSource(input),
    readSkillSummary: (input: Parameters<WorkspaceDO["sidekickReadSkillSummary"]>[0]) => target.sidekickReadSkillSummary(input),
    readRunDefinition: (input: Parameters<WorkspaceDO["sidekickReadRunDefinition"]>[0]) => target.sidekickReadRunDefinition(input),
    readRunState: (input: Parameters<WorkspaceDO["sidekickReadRunState"]>[0]) => target.sidekickReadRunState(input),
    continueRun: (input: Parameters<WorkspaceDO["sidekickContinueRun"]>[0]) => target.sidekickContinueRun(input),
    readAuthorizationFacts: (input: Parameters<WorkspaceDO["sidekickReadAuthorizationFacts"]>[0]) =>
      target.sidekickReadAuthorizationFacts(input),
    authorizationDiscoveryChildren: (input: Parameters<WorkspaceDO["authorizationDiscoveryChildren"]>[0]) =>
      target.authorizationDiscoveryChildren(input),
  };
}

export type SidekickClient = ReturnType<typeof sidekickClientFor>;
