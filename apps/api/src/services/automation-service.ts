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
  type WorkstreamAutomationSummary,
} from "@rally/contracts";

import type { AutomationDO } from "../durable-objects/automation-do";
import type { AutomationActor } from "../durable-objects/automation-do-protocol";
import { automationDOName, workspaceDOName } from "../durable-objects/names";
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
  owningWorkstreamId: string | null;
  automationId?: string;
}): Promise<{ automationId: string; created: boolean }> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const automationId = asAutomationId(input.automationId ?? uuidV7());
  const authority = await readWorkstreamAuthorityControl(env);
  const automation = await durableObjectStubForWorkspace(
    env,
    env.AUTOMATION_DOS,
    workspaceId,
    automationDOName(env.AVALON_REGION, workspaceId, automationId),
  );
  const { created } = await automation.create({
    workspaceId,
    automationId,
    authorUserId: asUserId(input.authorUserId),
    scope: input.scope,
    owningWorkstreamId: input.owningWorkstreamId,
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
      owningWorkstreamId: null,
    });
    return { automationId };
  }

  async listSidekicks(): Promise<{ items: AutomationSummary[] }> {
    return (await this.workspace()).listSidekickDirectory({ workspaceId: this.auth.workspaceId, userId: this.auth.userId });
  }

  async list(): Promise<{ items: AutomationSummary[] }> {
    const workspace = await this.workspace();
    return workspace.listAutomationDirectory({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    });
  }

  /** What one work stream owns, for its rail. The sidebar list excludes these. */
  async listForWorkstream(workstreamId: string): Promise<{ items: WorkstreamAutomationSummary[] }> {
    const workspace = await this.workspace();
    return workspace.listWorkstreamAutomations({
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
    });
  }

  async detail(automationId: string): Promise<AutomationDetail> {
    const automation = await this.automation(automationId);
    return automation.readDetail(await this.actorRequest(automationId));
  }

  async apply(automationId: string): Promise<AutomationDetail> {
    const automation = await this.automation(automationId);
    return automation.apply(await this.actorRequest(automationId));
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
    const automation = await this.automation(automationId);
    const { actor } = await this.actorRequest(automationId);
    return automation.saveDefinition({
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
   * `SidekickDO.runSeeded`.
   */
  async runSeeded(automationId: string, seed: DemoSeed): Promise<{ runId: string; reused: boolean }> {
    const automation = await this.automation(automationId);
    const { actor } = await this.actorRequest(automationId);
    return automation.runSeeded({
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
    const automation = await this.automation(automationId);
    return automation.setAppearance({ ...await this.actorRequest(automationId), appearance });
  }

  async pause(automationId: string): Promise<void> {
    const automation = await this.automation(automationId);
    await automation.pause(await this.actorRequest(automationId));
  }

  async resume(automationId: string): Promise<void> {
    const automation = await this.automation(automationId);
    await automation.resume(await this.actorRequest(automationId));
  }

  async delete(automationId: string): Promise<void> {
    const automation = await this.automation(automationId);
    await automation.remove(await this.actorRequest(automationId));
  }

  async runNow(automationId: string, idempotencyKey: string): Promise<{ runId: string; reused: boolean }> {
    const automation = await this.automation(automationId);
    return automation.runNow({ ...await this.actorRequest(automationId), idempotencyKey });
  }

  async runs(automationId: string): Promise<{ items: AutomationRun[] }> {
    const automation = await this.automation(automationId);
    return automation.listRuns(await this.actorRequest(automationId));
  }

  async claimExecutionPrincipal(automationId: string): Promise<AutomationExecutionPrincipalClaim> {
    const automation = await this.automation(automationId);
    return automation.claimExecutionPrincipal(await this.actorRequest(automationId));
  }

  /**
   * Who is asking, with the one fact the automation object cannot see for
   * itself: whether they are in the room that owns it. Resolved from the
   * workspace directory, and false when it cannot answer, which only ever
   * withholds the room's standing rather than granting anything.
   */
  async actorRequest(automationId: string): Promise<{
    workspaceId: ReturnType<typeof asWorkspaceId>;
    automationId: string;
    actor: AutomationActor;
  }> {
    let participantOfOwningWorkstream = false;
    try {
      const workspace = await this.workspace();
      const owned = await workspace.automationOwner({
        workspaceId: this.auth.workspaceId,
        automationId,
      });
      if (owned.owningWorkstreamId) {
        // Archived included: the room's people still manage its automation
        // after the archive, and the object itself answers what the archive
        // forbids (`sidekick_room_archived` on resume) rather than a blanket
        // refusal that hides it.
        participantOfOwningWorkstream = (await workspace.workstreamParticipant({
          workspaceId: this.auth.workspaceId,
          workstreamId: owned.owningWorkstreamId,
          userId: this.auth.userId,
          includeArchived: true,
        })).participant;
      }
    } catch {
      participantOfOwningWorkstream = false;
    }
    return {
      workspaceId: this.auth.workspaceId,
      automationId,
      actor: {
        userId: this.auth.userId,
        ...(this.auth.role ? { actorRole: this.auth.role } : {}),
        participantOfOwningWorkstream,
      },
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

  private automation(automationId: string): Promise<DurableObjectStub<AutomationDO>> {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.AUTOMATION_DOS,
      this.auth.workspaceId,
      automationDOName(this.env.AVALON_REGION, this.auth.workspaceId, asAutomationId(automationId)),
    );
  }
}
