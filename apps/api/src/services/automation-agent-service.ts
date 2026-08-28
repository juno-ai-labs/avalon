import {
  AutomationDraftTurnAdmissionRequestSchema,
  AutomationDraftSchema,
  CreateAutomationRequestSchema,
  IdSchema,
  asAutomationId,
  type AutomationAgentSnapshot,
  type AutomationDetail,
  type AutomationDraftTurnAdmissionResult,
} from "@rally/contracts";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { automationAgentName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { issueAutomationSocketTicket } from "./socket-service";
import { AutomationService } from "./automation-service";
import { withAutomationErrors } from "./automation-agent-errors";

export const AutomationDraftTurnRequestSchema = z.object({
  clientCreationKey: IdSchema.optional(),
  clientMessageId: IdSchema,
  content: z.string().min(1),
  attachmentIds: z.array(IdSchema).default([]),
  inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]).default("typed"),
}).strict();

export type AutomationDraftTurnRequest = z.infer<typeof AutomationDraftTurnRequestSchema>;

export class AutomationAgentService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
  ) {}

  async admitFirstTurn(rawInput: AutomationDraftTurnRequest): Promise<AutomationDraftTurnAdmissionResult> {
    const input = AutomationDraftTurnRequestSchema.extend({
      clientCreationKey: IdSchema,
    }).parse(rawInput);
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    const claim = await withAutomationErrors(() => workspace.claimAutomationDraft({
      schemaVersion: 1,
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      region: this.env.AVALON_REGION,
      clientCreationKey: input.clientCreationKey,
    }));
    const result = await this.admit(claim.automationId, input);
    const payloadHash = `draft:${claim.automationId}:1:${result.transcriptSequence}`;
    await workspace.applyAutomationProjection({
      schemaVersion: 1,
      automationId: claim.automationId,
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      authorityGeneration: 1,
      projectionVersion: result.projectionVersion ?? result.transcriptSequence,
      payloadHash,
      lifecycle: "draft",
      scope: "personal",
      title: "New automation",
      description: "",
      nextRunAt: null,
      attentionCode: null,
    });
    return result;
  }

  async admitTurn(
    automationId: string,
    rawInput: AutomationDraftTurnRequest,
  ): Promise<AutomationDraftTurnAdmissionResult> {
    const input = AutomationDraftTurnRequestSchema.parse(rawInput);
    return this.admit(asAutomationId(automationId), input);
  }

  async snapshot(automationId: string): Promise<AutomationAgentSnapshot> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    return withAutomationErrors(() => agent.readSnapshot({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
  }

  async cancel(automationId: string, runId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    await withAutomationErrors(() => agent.cancelCompilerRun({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      runId: IdSchema.parse(runId),
    }));
  }

  async retry(automationId: string, runId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    await withAutomationErrors(() => agent.retryCompilerRun({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      runId: IdSchema.parse(runId),
    }));
  }

  async socketTicket(automationId: string): Promise<{ url: string; ticket: string }> {
    const id = asAutomationId(automationId);
    await this.snapshot(id);
    const ticket = await issueAutomationSocketTicket(this.env, this.auth, id);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/automations/${id}`;
    url.search = "";
    return { url: url.toString(), ticket };
  }

  async accept(rawInput: unknown): Promise<AutomationDetail> {
    const input = CreateAutomationRequestSchema.parse(rawInput);
    if (!input.draftId) throw new Error("automation_draft_id_required");
    const automationId = asAutomationId(input.draftId);
    const agent = await this.agent(automationId);
    const snapshot: AutomationAgentSnapshot = await withAutomationErrors(() => agent.readSnapshot({
      automationId,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
    const canonicalDraft = AutomationDraftSchema.parse(snapshot.definition);
    if (JSON.stringify(canonicalDraft) !== JSON.stringify(input.draft)) {
      throw new Error("automation_definition_revision_stale");
    }
    return withAutomationErrors(() => agent.acceptDraft({
      schemaVersion: 1,
      automationId,
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      definitionRevision: snapshot.definitionRevision,
      scope: input.scope,
      defaultPluginIds: input.defaultPluginIds,
      activitySourcePluginIds: input.activitySourcePluginIds,
      deliveryTargets: input.deliveryTargets,
      modelOverride: input.modelOverride ?? null,
      actorRole: this.auth.role,
    }));
  }

  async detail(automationId: string): Promise<AutomationDetail> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    return withAutomationErrors(() => agent.readDetail({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
  }

  async pause(automationId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    await withAutomationErrors(() => agent.pause({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
    }));
  }

  async resume(automationId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    await withAutomationErrors(() => agent.resume({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
    }));
  }

  async updateDeliveryTargets(automationId: string, deliveryTargets: unknown): Promise<AutomationDetail> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    return withAutomationErrors(() => agent.updateDeliveryTargets({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      deliveryTargets,
    }));
  }

  async delete(automationId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    await withAutomationErrors(() => agent.deleteAutomation({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
    }));
  }

  async runNow(automationId: string, idempotencyKey: string) {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    return withAutomationErrors(() => agent.runNow({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      idempotencyKey,
    }));
  }

  async runs(automationId: string): Promise<{ items: unknown[] }> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    return withAutomationErrors(() => agent.listRuns({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
  }

  async list(): Promise<{ items: unknown[] }> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    return workspace.listAutomationDirectory({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    });
  }

  async share(automationId: string): Promise<{ templateId: string }> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    const source = await withAutomationErrors(() => agent.exportAcceptedDraft({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
    const draft = AutomationDraftSchema.parse(JSON.parse(source.draftJson));
    const created = await new AutomationService(this.env, this.auth).publishTemplate({
      name: draft.name,
      description: draft.description,
      draft,
    });
    return { templateId: created.id };
  }

  private async admit(
    automationId: ReturnType<typeof asAutomationId>,
    input: AutomationDraftTurnRequest,
  ): Promise<AutomationDraftTurnAdmissionResult> {
    const agent = await this.agent(automationId);
    return withAutomationErrors(() => agent.admitDraftTurn(AutomationDraftTurnAdmissionRequestSchema.parse({
      schemaVersion: 1,
      automationId,
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      region: this.env.AVALON_REGION,
      clientMessageId: input.clientMessageId,
      content: input.content,
      attachmentIds: input.attachmentIds,
      inputMode: input.inputMode,
    })));
  }

  /**
   * The automation's object, unwrapped.
   *
   * Every call above puts its own RPC inside `withAutomationErrors`, which is
   * verbose next to a `Proxy` that could have wrapped the stub once — and the
   * `Proxy` is what this used to be. It does not survive contact with workerd:
   * a `get` trap hands the stub's own method the proxy as its receiver, which a
   * stub that brand-checks `this` rejects with a `TypeError`, and an RPC call
   * returns a pipelining thenable rather than a native `Promise`, so the
   * `instanceof Promise` branch that was supposed to attach the mapping never
   * ran. Both failures are invisible until a request reaches a real object.
   * Explicit wrapping at each call site is longer and is actually true.
   */
  private async agent(automationId: ReturnType<typeof asAutomationId>) {
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.AUTOMATION_AGENTS,
      this.auth.workspaceId,
      automationAgentName(this.env.AVALON_REGION, this.auth.workspaceId, automationId),
    );
    return stub;
  }
}
