import {
  asAutomationId,
  asUserId,
  asWorkspaceId,
  type AutomationDetail,
  type AutomationDraft,
  type AutomationExecutionPrincipalClaim,
  type AutomationRun,
  type AutomationScope,
  type AutomationSetEvaluatorRulesInputV1,
  type AutomationSummary,
  type DemoSeed,
  type WorkstreamAppearancePatch,
  type SidekickAudienceUpdate,
} from "@rally/contracts";

import type { AutomationActor } from "../durable-objects/automation-do-protocol";
import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";

/**
 * Bring an automation into existence with its conversation open.
 *
 * Both entry points use this: "New automation" in the sidebar, and a room's
 * agent submitting its first draft. The object is created first so the
 * conversation's parent exists before the conversation does, then the main
 * conversation is bootstrapped and provisioned the way a work stream's is, with
 * the author as its one participant.
 */
export async function createAutomation(env: Env, input: {
  workspaceId: string;
  authorUserId: string;
  scope: AutomationScope;
  automationId?: string;
}): Promise<{ automationId: string; created: boolean }> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const automationId = asAutomationId(input.automationId ?? uuidV7());
  const authority = await readWorkstreamAuthorityControl(env);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const { created } = await workspace.sidekickCreate({
    workspaceId,
    automationId,
    authorUserId: asUserId(input.authorUserId),
    scope: input.scope,
    authorityGeneration: authority.generation,
  });
  // Both steps run on a replay too. The object's row commits first, and a
  // first call that died after it answered `created: false` forever after,
  // skipping the runtime environment and the conversation the automation
  // needed to be opened at all. Both are idempotent: the D1 anchors are
  // insert-or-ignore, and the object answers `already_provisioned`.
  await bootstrapWorkstreamRuntimeEnvironment(env, workspaceId, automationId, "automation");
  await provisionWorkstreamObject(env, {
    workspaceId,
    workstreamId: automationId,
    title: "New Sidekick",
    objective: "What would you like to delegate? Teach this Sidekick what it should know or do and who it is for.",
    scope: "personal",
    createdByUserId: input.authorUserId,
    participantUserIds: [input.authorUserId],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
  return { automationId, created };
}

/** Worker-side access to one automation on behalf of an authenticated member. */
export class AutomationService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
  ) {}

  async create(): Promise<{ automationId: string }> {
    const { automationId } = await createAutomation(this.env, {
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      scope: "personal",
    });
    return { automationId };
  }

  /**
   * The Sidekick library for this member. Every caller holds an `AuthContext`
   * whose membership was already proved this request (session authentication
   * joins the active member row; the others resolve it before constructing
   * one), so the object is asked for the authorized-member listing rather than
   * repeating that D1 read from inside the object. The object still decides
   * which rows this member may see.
   */
  async listSidekicks(): Promise<{ items: AutomationSummary[] }> {
    return (await this.workspace()).listSidekickDirectoryForAuthorizedMember({
      workspaceId: this.auth.workspaceId, userId: this.auth.userId,
      // What this request's authentication read, so the object does not read it again.
      ...(this.auth.accessClass ? { accessClass: this.auth.accessClass, role: this.auth.role } : {}),
    });
  }

  async list(): Promise<{ items: AutomationSummary[] }> {
    const workspace = await this.workspace();
    return workspace.listAutomationDirectory({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    });
  }

  async detail(automationId: string): Promise<AutomationDetail> {
    const workspace = await this.workspace();
    return workspace.sidekickReadDetail(await this.actorRequest(automationId));
  }

  async apply(automationId: string): Promise<AutomationDetail> {
    const workspace = await this.workspace();
    return workspace.sidekickApply(await this.actorRequest(automationId));
  }

  /**
   * Record a definition and, when it is ready, publish it — the same call the
   * drafting conversation makes when a person accepts what it wrote.
   *
   * The caller supplies the definition rather than a model writing it, which is
   * how a demo gets a published Sidekick without depending on a live drafting
   * run. Management authority is the object's to check, as it is for every
   * other method here.
   */
  async saveDefinition(automationId: string, input: {
    draft: AutomationDraft;
    evaluatorRules: AutomationSetEvaluatorRulesInputV1 | null;
    submittedByRunId: string | null;
  }): Promise<{ definitionRevision: number; ready: boolean }> {
    const workspace = await this.workspace();
    const { actor } = await this.actorRequest(automationId);
    return workspace.sidekickSaveDefinition({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      automationId: asAutomationId(automationId),
      draft: input.draft,
      evaluatorRules: input.evaluatorRules,
      submittedByRunId: input.submittedByRunId,
      actor,
    });
  }

  /**
   * Start one run whose model bytes come from a demo's pack instead of a
   * provider. Only the demo seeder calls this; `POST /sidekicks/:id/run` goes
   * to `runNow`, whose request shape cannot carry a seed. See
   * `HostedSidekick.runSeeded`.
   */
  async runSeeded(automationId: string, seed: DemoSeed): Promise<{ runId: string; reused: boolean }> {
    const workspace = await this.workspace();
    const { actor } = await this.actorRequest(automationId);
    return workspace.sidekickRunSeeded({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      automationId: asAutomationId(automationId),
      actor,
      seed,
    });
  }

  /**
   * Choose the Sidekick's icon or colour, and return the Sidekick that results.
   *
   * The detail comes back rather than a 204 so the person who picked sees the
   * committed value immediately; everyone else sees it when WorkspaceDO pushes
   * the row this write enqueues.
   */
  async setAppearance(
    automationId: string,
    appearance: WorkstreamAppearancePatch,
  ): Promise<AutomationDetail> {
    const workspace = await this.workspace();
    return workspace.sidekickSetAppearance({ ...await this.actorRequest(automationId), appearance });
  }

  /** Choose who the Sidekick is shared with, and return the Sidekick that results. */
  async setAudience(automationId: string, update: SidekickAudienceUpdate): Promise<AutomationDetail> {
    const workspace = await this.workspace();
    return workspace.sidekickSetAudience({ ...await this.actorRequest(automationId), update });
  }

  async pause(automationId: string): Promise<void> {
    const workspace = await this.workspace();
    await workspace.sidekickPause(await this.actorRequest(automationId));
  }

  async resume(automationId: string): Promise<void> {
    const workspace = await this.workspace();
    await workspace.sidekickResume(await this.actorRequest(automationId));
  }

  async delete(automationId: string): Promise<void> {
    await this.archive(automationId);
  }

  async archive(automationId: string): Promise<void> {
    const workspace = await this.workspace();
    await workspace.sidekickRemove(await this.actorRequest(automationId));
  }

  async runNow(automationId: string, idempotencyKey: string): Promise<{ runId: string; reused: boolean }> {
    const workspace = await this.workspace();
    return workspace.sidekickRunNow({ ...await this.actorRequest(automationId), idempotencyKey });
  }

  async runs(automationId: string): Promise<{ items: AutomationRun[] }> {
    const workspace = await this.workspace();
    return workspace.sidekickListRuns(await this.actorRequest(automationId));
  }

  async claimExecutionPrincipal(automationId: string): Promise<AutomationExecutionPrincipalClaim> {
    const workspace = await this.workspace();
    return workspace.sidekickClaimExecutionPrincipal(await this.actorRequest(automationId));
  }

  /**
   * Who is asking. Whether they can manage a Sidekick homed in a Channel or
   * Breakout is decided where the Sidekick lives, from the Organization's own
   * tables, so nothing is resolved here first.
   */
  async actorRequest(automationId: string): Promise<{
    workspaceId: ReturnType<typeof asWorkspaceId>;
    automationId: string;
    actor: AutomationActor;
  }> {
    return {
      workspaceId: this.auth.workspaceId,
      automationId,
      actor: { userId: this.auth.userId, actorRole: this.auth.role, participantOfOwningWorkstream: false },
    };
  }

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }
}
