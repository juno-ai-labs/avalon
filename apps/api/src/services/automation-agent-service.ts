import {
  AutomationDraftSchema,
  CreateAutomationRequestSchema,
  IdSchema,
  asAutomationId,
  type AutomationAgentSnapshot,
  type AutomationDetail,
} from "@rally/contracts";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { automationAgentName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { AutomationService } from "./automation-service";
import { automationRefusal, withAutomationErrors } from "./automation-agent-errors";
import { logWarn } from "../observability/logger";

export const AutomationDraftTurnRequestSchema = z.strictObject({
  clientCreationKey: IdSchema.optional(),
  clientMessageId: IdSchema,
  content: z.string().min(1),
  attachmentIds: z.array(IdSchema).default([]),
  inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]).default("typed"),
});

export type AutomationDraftTurnRequest = z.infer<typeof AutomationDraftTurnRequestSchema>;

/**
 * The top-level draft fields whose serialized values disagree.
 *
 * Names only, and only the ones `AutomationDraftSchema` declares — a draft's
 * values are the member's own prose. A field the caller omitted entirely shows
 * up here too, which is the shape a client built against an older copy of the
 * contract produces.
 */
function differingDraftFields(canonical: unknown, submitted: unknown): string[] {
  if (canonical === null || typeof canonical !== "object") return ["(root)"];
  const submittedRecord = submitted !== null && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  return Object.keys(canonical as Record<string, unknown>).filter((key) => (
    JSON.stringify((canonical as Record<string, unknown>)[key]) !== JSON.stringify(submittedRecord[key])
  ));
}

export class AutomationAgentService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
  ) {}

  /**
   * Accept the draft an agent proposed in a work stream, by its id alone.
   *
   * The other entry point takes the draft in the request because the standalone
   * screen holds it client-side and echoes it back as a staleness check. A feed
   * card holds nothing: the draft lives on the object, the card carries only
   * what it displays, and re-sending a copy the client never had would be
   * inventing a check rather than making one.
   *
   * Same authority underneath — one `acceptDraft`, two ways in.
   */
  async acceptAuthoredDraft(automationId: string): Promise<AutomationDetail> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    // One read, in `accept`. This used to read here as a participant and then
    // delegate to an `accept` that read again as the author — so the card still
    // refused everyone but its author, and the participation check below it
    // never ran. The card is the room's to press, so the room's read is the
    // only one.
    const participantOfAuthoringWorkstream = await this.participantOfAuthoringRoom(agent);
    const snapshot: AutomationAgentSnapshot = await withAutomationErrors(
      () => agent.readAuthoredSnapshot({
        automationId: id,
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        participantOfAuthoringWorkstream,
      }),
    );
    if (snapshot.definition === null) automationRefusal("automation_definition_not_ready");
    const draft = AutomationDraftSchema.parse(snapshot.definition);
    if (!draft.ready) automationRefusal("automation_definition_not_ready");
    return this.accept({
      draftId: id,
      draft,
      scope: draft.suggestedScope,
      // Whatever the drafting conversation recommended, and nothing more: a
      // plugin nobody chose is a connection nobody agreed to bind.
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
      modelOverride: null,
    });
  }

  async accept(rawInput: unknown): Promise<AutomationDetail> {
    const input = CreateAutomationRequestSchema.parse(rawInput);
    if (!input.draftId) automationRefusal("automation_draft_id_required");
    const automationId = asAutomationId(input.draftId);
    const agent = await this.agent(automationId);
    // Read as a participant, not as the author. A proposal card is the room's
    // to decide, so the person pressing it is usually not whoever typed the
    // request — and an author-only read here is what made the card refuse
    // everyone else while the participation check further down never ran.
    const participantOfAuthoringWorkstream = await this.participantOfAuthoringRoom(agent);
    const snapshot: AutomationAgentSnapshot = await withAutomationErrors(() =>
      agent.readAuthoredSnapshot({
        automationId,
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        participantOfAuthoringWorkstream,
      }));
    // A draft whose compiler run never settled has no definition row at all, so
    // this is reachable, and parsing `null` here threw the exact
    // `ZodError`-to-500 this branch exists to remove, one line above the fix.
    // A definition that is present but fails the schema is left to fault: the
    // server wrote something it can no longer read, which is not a refusal.
    if (snapshot.definition === null) automationRefusal("automation_definition_not_ready");
    const canonicalDraft = AutomationDraftSchema.parse(snapshot.definition);
    if (JSON.stringify(canonicalDraft) !== JSON.stringify(input.draft)) {
      // Which fields disagree, before refusing. The refusal is written for one
      // cause — a compiler turn settling while somebody reviewed the summary —
      // and reads as transient. It fires for a second cause that is neither
      // transient nor the caller's fault: a desktop build whose bundled
      // `AutomationDraftSchema` differs from this one strips or defaults a
      // field on its way back, so every attempt from that build refuses
      // forever. The two are indistinguishable in the response and were
      // indistinguishable in the log; the field names separate them, and they
      // are schema shape rather than member content, so they are safe to
      // record where the values would not be.
      logWarn(this.env, "automation_definition_revision_stale", {
        automation_id: automationId,
        definition_revision: snapshot.definitionRevision,
        differing_fields: differingDraftFields(canonicalDraft, input.draft),
      });
      automationRefusal("automation_definition_revision_stale");
    }
    // The room comes from where the draft was written, never from the request:
    // a body naming one would let a caller give any room an automation, and no
    // other room is reachable from an authoring loop anyway.
    const owningWorkstreamId = input.scope === "workstream"
      ? await withAutomationErrors(() => agent.authoredInWorkstreamId())
      : null;
    if (input.scope === "workstream" && !owningWorkstreamId) {
      automationRefusal("automation_workstream_scope_requires_authoring_room");
    }
    // Asked once, here, and used for both the refusal and the authority the
    // object checks. Re-asked at acceptance rather than inherited from the
    // draft: writing the proposal card proved participation at that moment, and
    // somebody who has left the room in between would otherwise activate a
    // standing automation in it — and bind their own credentials to it — after
    // losing access. Authorship does not expire, so it cannot stand in for this.
    const participantOfOwningWorkstream = owningWorkstreamId !== null
      && await this.participantOfWorkstream(owningWorkstreamId);
    if (owningWorkstreamId && !participantOfOwningWorkstream) {
      automationRefusal("automation_workstream_participation_required");
    }
    return withAutomationErrors(() => agent.acceptDraft({
      schemaVersion: 1,
      automationId,
      workspaceId: this.auth.workspaceId,
      authorUserId: this.auth.userId,
      definitionRevision: snapshot.definitionRevision,
      scope: input.scope,
      owningWorkstreamId,
      participantOfOwningWorkstream,
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
    // A room's automation is managed by the room's participants. Resolved here
    // because participation lives in WorkspaceDO, which the automation object
    // cannot read for itself.
    const participant = await this.participantOfOwningWorkstream(id);
    await withAutomationErrors(() => agent.pause({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
    }));
  }

  async resume(automationId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    // A room's automation is managed by the room's participants. Resolved here
    // because participation lives in WorkspaceDO, which the automation object
    // cannot read for itself.
    const participant = await this.participantOfOwningWorkstream(id);
    await withAutomationErrors(() => agent.resume({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
    }));
  }

  async updateDeliveryTargets(automationId: string, deliveryTargets: unknown): Promise<AutomationDetail> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    const participant = await this.participantOfOwningWorkstream(id);
    return withAutomationErrors(() => agent.updateDeliveryTargets({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
      deliveryTargets,
    }));
  }

  async delete(automationId: string): Promise<void> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    const participant = await this.participantOfOwningWorkstream(id);
    await withAutomationErrors(() => agent.deleteAutomation({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
    }));
  }

  async runNow(automationId: string, idempotencyKey: string) {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    const participant = await this.participantOfOwningWorkstream(id);
    return withAutomationErrors(() => agent.runNow({
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
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
    return withAutomationErrors(() => workspace.listAutomationDirectory({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
  }

  /** What one work stream owns, for its rail. The sidebar list excludes these. */
  async listForWorkstream(workstreamId: string): Promise<{ items: unknown[] }> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    return withAutomationErrors(() => workspace.listWorkstreamAutomations({
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
    }));
  }

  /** Take over who an automation runs as. The claimant is always the caller. */
  async claimExecutionPrincipal(automationId: string): Promise<{
    principalUserId: string;
    reboundPluginIds: string[];
    unboundProviders: string[];
    changed: boolean;
  }> {
    const id = asAutomationId(automationId);
    const agent = await this.agent(id);
    const participant = await this.participantOfOwningWorkstream(id);
    return withAutomationErrors(() => agent.claimExecutionPrincipal({
      schemaVersion: 1,
      automationId: id,
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      actorRole: this.auth.role,
      participantOfOwningWorkstream: participant,
    }));
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
  /**
   * Whether this caller is an active participant of the room that owns this
   * automation — the fact that lets a room's automation be managed by the room
   * rather than by whoever typed it.
   *
   * Answered by WorkspaceDO, which keeps the same viewer overlay the sidebar is
   * filtered by. False for every other scope, where it means nothing: the
   * automation object's own author and admin checks decide those.
   */
  /**
   * Whether the caller is a participant of the room this draft was written in.
   *
   * False for a draft written outside a work stream, which is not a refusal —
   * `readAuthoredSnapshot` falls back to authorship for those, which is the
   * only standing anybody has on a draft that belongs to no room.
   */
  private async participantOfAuthoringRoom(
    agent: Awaited<ReturnType<AutomationAgentService["agent"]>>,
  ): Promise<boolean> {
    const authoringRoom = await withAutomationErrors(() => agent.authoredInWorkstreamId());
    return authoringRoom !== null && await this.participantOfWorkstream(authoringRoom);
  }

  /** Whether the caller is still in this room, asked of the room itself. */
  private async participantOfWorkstream(workstreamId: string): Promise<boolean> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    // False when the directory cannot answer, which is the fail-closed
    // direction both ways this is used: it only ever *grants* a non-author the
    // read, and the one place it refuses — a `workstream` acceptance — refuses
    // on false. So an unreachable workspace object withholds the room's
    // standing rather than turning an author's own acceptance into a 500.
    try {
      const { participant } = await workspace.workstreamParticipation({
        workspaceId: this.auth.workspaceId,
        workstreamId,
        userId: this.auth.userId,
      });
      return participant;
    } catch {
      return false;
    }
  }

  private async participantOfOwningWorkstream(
    automationId: ReturnType<typeof asAutomationId>,
  ): Promise<boolean> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    // A grant, never a denial: `assertManager` refuses on its own when no arm
    // matches, so a false here only withholds the room's elevation. That makes
    // failing soft the safe direction — a workspace whose directory cannot be
    // reached must not stop an author managing their own personal automation,
    // and must not hand anybody the room's rights either.
    try {
      const { authorized } = await workspace.authorizeAutomationViewer({
        workspaceId: this.auth.workspaceId,
        automationId,
        userId: this.auth.userId,
      });
      return authorized;
    } catch {
      return false;
    }
  }

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
