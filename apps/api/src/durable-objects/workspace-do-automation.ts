import {
  AutomationAttentionReasonSchema,
  AutomationDraftCreationClaimRequestSchema,
  AutomationDraftCreationClaimResultSchema,
  ExternalEventRegistrationProjectionV1Schema,
  WorkspaceExternalEventDeliveryClaimRequestSchema,
  WorkspaceExternalEventDeliverySettleRequestSchema,
  AutomationIdSchema,
  IdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type AutomationSummary,
  type WorkstreamAutomationSummary,
  type AutomationDraftCreationClaimRequest,
  type AutomationDraftCreationClaimResult,
} from "@rally/contracts";
import { z } from "zod";

import { WorkspaceDoSockets } from "./workspace-do-sockets";
import { uuidV7 } from "../lib/uuid-v7";
import {
  applyWorkspaceExternalEventRegistrations,
  claimWorkspaceExternalEventDelivery,
  hasActiveWorkspaceExternalEventRegistration,
  matchWorkspaceExternalEventDestinations,
  settleWorkspaceExternalEventDelivery,
} from "./workspace-external-event-storage";
import {
  automationAttention,
} from "./workspace-automation-directory-storage";
import { compareProjectionCoordinate } from "./workspace-projection";
import {
  automationCutoverWitness as readAutomationCutoverWitness,
  cutoverWorkspaceAutomations,
} from "./automation-cutover";
import {
  WorkspaceAutomationOriginLabelRequestSchema,
  WorkspaceAutomationOriginLabelSchema,
  type WorkspaceAutomationOriginLabel,
  type WorkspaceAutomationOriginLabelRequest,
} from "./workspace-directory-protocol";
import {
  addWorkspaceAutomationTemplateVersion,
  listWorkspaceAutomationTemplates,
  publishWorkspaceAutomationTemplate,
  workspaceAutomationTemplateOwnership,
} from "./workspace-automation-template-storage";
import {
  WorkspaceAutomationTemplateOwnershipRequestSchema,
  WorkspaceAutomationTemplatePublishRequestSchema,
  WorkspaceAutomationTemplateVersionRequestSchema,
  type WorkspaceAutomationTemplateList,
  type WorkspaceAutomationTemplateOwnership,
  type WorkspaceAutomationTemplateOwnershipRequest,
  type WorkspaceAutomationTemplatePublishRequest,
  type WorkspaceAutomationTemplateVersionRequest,
  type WorkspaceAutomationTemplateVersionResult,
} from "./workspace-automation-template-protocol";

/**
 * `WorkspaceDO`'s automation surface: draft claims, the cutover, the content-free
 * automation directory, the shared template gallery, and external-event
 * registration and delivery.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoAutomation extends WorkspaceDoSockets {

  /** Resolve an uncertain first wizard send to exactly one server identity. */
  async claimAutomationDraft(
    input: AutomationDraftCreationClaimRequest,
  ): Promise<AutomationDraftCreationClaimResult> {
    await this.initialized;
    const request = AutomationDraftCreationClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (request.region !== this.env.AVALON_REGION) throw new Error("automation_region_mismatch");
    if (!await this.activeWorkspaceMember(request.workspaceId, request.authorUserId)) {
      throw new Error("automation_author_access_denied");
    }
    const cutover = this.state.storage.sql.exec<{ state: string }>(
      `SELECT state FROM automation_cutover_campaign WHERE id = 1`,
    ).toArray()[0];
    if (cutover?.state !== "completed") throw new Error("automation_cutover_in_progress");
    return this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{ automation_id: string }>(
        `SELECT automation_id FROM automation_creation_claims
          WHERE workspace_id = ? AND author_user_id = ? AND client_creation_key = ?`,
        request.workspaceId,
        request.authorUserId,
        request.clientCreationKey,
      ).toArray()[0];
      if (existing) {
        return AutomationDraftCreationClaimResultSchema.parse({
          automationId: existing.automation_id,
          created: false,
        });
      }
      const automationId = uuidV7();
      this.state.storage.sql.exec(
        `INSERT INTO automation_creation_claims
           (workspace_id, author_user_id, client_creation_key, automation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        request.workspaceId,
        request.authorUserId,
        request.clientCreationKey,
        automationId,
        Date.now(),
      );
      return AutomationDraftCreationClaimResultSchema.parse({ automationId, created: true });
    });
  }

  async finalizeAutomationCutover(input: unknown): Promise<{
    state: "completed";
    imported: number;
    discardedDrafts: number;
    sourceHash: string;
  }> {
    await this.initialized;
    const workspaceId = z.looseObject({ workspaceId: WorkspaceIdSchema }).parse(input).workspaceId;
    this.assertWorkspace(workspaceId);
    const result = await cutoverWorkspaceAutomations({
      env: this.env,
      storage: this.state.storage,
      request: input,
      applyProjection: (projection) => this.applyAutomationProjection(projection),
    });
    await this.refreshSchedule(workspaceId);
    return result;
  }

  async automationCutoverWitness(input: { workspaceId: string }): Promise<{ draftIds: string[] }> {
    await this.migrationsReady();
    this.assertWorkspace(input.workspaceId);
    return readAutomationCutoverWitness(this.state.storage, input.workspaceId);
  }

  /** Content-free list projection; the AutomationAgent remains canonical. */
  async applyAutomationProjection(input: unknown): Promise<{ applied: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: IdSchema,
      workspaceId: WorkspaceIdSchema,
      authorUserId: UserIdSchema,
      authorityGeneration: z.number().int().positive(),
      projectionVersion: z.number().int().positive(),
      payloadHash: z.string().min(1),
      lifecycle: z.enum(["draft", "activating", "active", "paused", "deleted"]),
      scope: z.enum(["personal", "workspace", "workstream"]),
      /**
       * The room that owns a `workstream`-scoped automation, and nothing at all
       * for the other two. The rail reads the directory by it and the sidebar
       * excludes rows that have one, so a projection that omitted it would put
       * a room's automation in everybody's sidebar.
       */
      owningWorkstreamId: IdSchema.nullable().default(null),
      title: z.string(),
      description: z.string(),
      nextRunAt: z.number().int().nonnegative().nullable(),
      // The contract's reasons rather than free text: the directory row is what
      // the sidebar reads, and a code nothing on the client can render is a
      // marker with no sentence behind it.
      attentionCode: AutomationAttentionReasonSchema.nullable(),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{
        authority_generation: number;
        projection_version: number;
        payload_hash: string;
      }>(`SELECT authority_generation, projection_version, payload_hash
            FROM automation_directory WHERE automation_id = ?`, request.automationId).toArray()[0];
      if (existing) {
        const coordinate = compareProjectionCoordinate(
          request.authorityGeneration,
          request.projectionVersion,
          existing.authority_generation,
          existing.projection_version,
        );
        if (coordinate < 0) return { applied: false };
        if (coordinate === 0) {
          if (existing.payload_hash !== request.payloadHash) {
            throw new Error("automation_projection_hash_conflict");
          }
          return { applied: false };
        }
      }
      this.state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, authority_generation,
            projection_version, payload_hash, lifecycle, scope, owning_workstream_id,
            title, description, next_run_at, attention_code, projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           author_user_id = excluded.author_user_id,
           authority_generation = excluded.authority_generation,
           projection_version = excluded.projection_version,
           payload_hash = excluded.payload_hash,
           lifecycle = excluded.lifecycle,
           scope = excluded.scope,
           owning_workstream_id = excluded.owning_workstream_id,
           title = excluded.title,
           description = excluded.description,
           next_run_at = excluded.next_run_at,
           attention_code = excluded.attention_code,
           projected_at = excluded.projected_at`,
        request.automationId,
        request.workspaceId,
        request.authorUserId,
        request.authorityGeneration,
        request.projectionVersion,
        request.payloadHash,
        request.lifecycle,
        request.scope,
        request.owningWorkstreamId,
        request.title,
        request.description,
        request.nextRunAt,
        request.attentionCode,
        Date.now(),
      );
      this.state.storage.sql.exec(
        `UPDATE workspace_sidebar_list_state
            SET waterline = waterline + 1
          WHERE list = 'automations'`,
      );
      return { applied: true };
    });
    if (result.applied) this.publishSidebarList("automations");
    return result;
  }

  /**
   * Content-free automation sidebar projection; AutomationAgent remains authority.
   *
   * Drafts are excluded, and that follows from the builder's retirement rather
   * than being a taste: a draft is a conversation in progress and now lives
   * where that conversation is — a room's rail, or nowhere at all if it was
   * written on the screen that no longer exists. Listing one here would offer a
   * row whose only destination is an automation that has not been created yet.
   */
  async listAutomationDirectory(input: unknown): Promise<{ items: AutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, userId: UserIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      throw new Error("automation_directory_access_denied");
    }
    const rows = this.state.storage.sql.exec<{
      automation_id: string;
      lifecycle: "activating" | "active" | "paused";
      scope: "personal" | "workspace";
      title: string;
      description: string;
      next_run_at: number | null;
      attention_code: string | null;
      projected_at: number;
    }>(`SELECT automation_id, lifecycle, scope, title, description, next_run_at,
              attention_code, projected_at
          FROM automation_directory
         WHERE workspace_id = ? AND lifecycle NOT IN ('deleted', 'draft')
           -- A room's automation is listed in that room's rail and nowhere
           -- else. In a personal list it would be an object somebody sees
           -- without the context that explains it, in a list where pausing it
           -- affects people who are not looking at that list.
           AND owning_workstream_id IS NULL
           AND (scope = 'workspace' OR author_user_id = ?)
         ORDER BY projected_at DESC, automation_id
         LIMIT 250`, request.workspaceId, request.userId).toArray();
    return {
      items: rows.map((row) => ({
        id: row.automation_id,
        name: row.title || "New automation",
        description: row.description,
        emailAddress: null,
        scope: row.scope,
        // The sidebar excludes drafts, so this cannot be one. A draft row
        // here led to the overview's "not created yet" error state.
        status: row.lifecycle === "paused"
          ? "paused"
          : row.attention_code ? "error" : "active",
        // Carried beside the status rather than folded into it. Both codes the
        // cutover writes arrive on an automation it also paused, so the status
        // alone says "paused" and nothing says why.
        attention: automationAttention(row.attention_code),
        nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
        lastRunAt: null,
        updatedAt: new Date(row.projected_at).toISOString(),
        updateAvailable: false,
      })),
    };
  }

  /**
   * The automations one work stream owns, for that work stream's rail.
   *
   * The counterpart to the sidebar's list, which excludes exactly these rows.
   * A room's automation is managed by the room's participants, so the gate is
   * participation rather than authorship: the person who created it may be
   * gone, and the automation is still theirs to pause.
   */
  async listWorkstreamAutomations(input: unknown): Promise<{ items: WorkstreamAutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: IdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      throw new Error("automation_directory_access_denied");
    }
    // Participation, not listability. A workspace-scoped room is listable to
    // every member of the workspace, so gating on that would hand the names,
    // descriptions and schedules of its automations to people who are not in
    // it — while `authorizeAutomationViewer` goes on refusing them the details.
    // The wider half of that pair is the one that leaks.
    if (!this.isWorkstreamParticipant(request.workstreamId, request.userId)) {
      throw new Error("automation_directory_access_denied");
    }
    const rows = this.state.storage.sql.exec<{
      automation_id: string;
      lifecycle: "activating" | "active" | "paused";
      title: string;
      description: string;
      next_run_at: number | null;
      attention_code: string | null;
      projected_at: number;
    }>(`SELECT automation_id, lifecycle, title, description, next_run_at,
              attention_code, projected_at
          FROM automation_directory
         WHERE owning_workstream_id = ? AND lifecycle NOT IN ('deleted', 'draft')
         ORDER BY projected_at DESC, automation_id
         LIMIT 250`, request.workstreamId).toArray();
    return {
      items: rows.map((row) => ({
        id: row.automation_id,
        name: row.title || "New automation",
        description: row.description,
        emailAddress: null,
        // No draft arm: the query excludes them. A draft is decided on its
        // proposal card in the feed, and a row here led to the overview's
        // "this automation has not been created yet" — the same dead end the
        // sidebar removed and this list reintroduced.
        status: row.lifecycle === "paused"
          ? "paused"
          : row.attention_code ? "error" : "active",
        attention: automationAttention(row.attention_code),
        nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
        lastRunAt: null,
        updatedAt: new Date(row.projected_at).toISOString(),
        updateAvailable: false,
      })),
    };
  }

  /**
   * Which of these bindings the named principal can no longer reach.
   *
   * Answered here because `connector_connections` lives here: migration 0090
   * dropped it from regional D1, so a caller reading it on `env.DB` gets
   * `no such table` — the failure the workspace-table routing guard exists to
   * catch, and did.
   *
   * Workspace-scoped bindings are never reported: they belong to the workspace
   * rather than to whoever authorized them, so they did not break when their
   * authorizer left.
   */
  async unreachablePersonalBindings(input: unknown): Promise<{ providers: string[] }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      principalUserId: UserIdSchema,
      connectionIds: z.array(z.string().min(1)).max(100),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (request.connectionIds.length === 0) return { providers: [] };
    const rows = this.state.storage.sql.exec<{
      id: string;
      connector_type: string;
      scope: string;
      owner_user_id: string | null;
      status: string;
    }>(
      `SELECT id, connector_type, scope, owner_user_id, status
         FROM connector_connections
        WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(request.connectionIds),
    ).toArray();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const providers = new Set<string>();
    for (const connectionId of request.connectionIds) {
      const row = byId.get(connectionId);
      // A binding whose row is gone is unreachable and cannot name its
      // provider; the ones that remain say which they were.
      if (!row) { providers.add("a disconnected account"); continue; }
      if (row.scope !== "personal") continue;
      if (row.status === "disabled" || (row.owner_user_id ?? "") !== request.principalUserId) {
        providers.add(row.connector_type);
      }
    }
    return { providers: [...providers].sort() };
  }

  /**
   * Whether this person is an active participant of this work stream.
   *
   * The one predicate every "does the room let you" decision here is built on,
   * so the answer cannot drift between the list, the details, and acceptance.
   */
  private isWorkstreamParticipant(workstreamId: string, userId: string): boolean {
    return this.state.storage.sql.exec<{ is_participant: number }>(
      `SELECT viewer.is_participant
         FROM workspace_workstream_viewers viewer
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = viewer.workstream_id
          AND directory.authority_generation = viewer.authority_generation
        WHERE viewer.workstream_id = ? AND viewer.user_id = ?
          AND directory.archived_at IS NULL`,
      workstreamId,
      userId,
    ).toArray()[0]?.is_participant === 1;
  }

  /**
   * Whether somebody may still act on a work stream, asked directly.
   *
   * `authorizeAutomationViewer` answers the same question through the
   * automation directory, which a draft being accepted is not yet in. This one
   * names the room, so it works before the automation exists.
   */
  async workstreamParticipation(input: unknown): Promise<{ participant: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: IdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { participant: this.isWorkstreamParticipant(request.workstreamId, request.userId) };
  }

  /** Current membership plus projected scope gates direct AutomationAgent reads. */
  async authorizeAutomationViewer(input: unknown): Promise<{ authorized: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      automationId: AutomationIdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { authorized: false };
    }
    const row = this.state.storage.sql.exec<{
      scope: "personal" | "workspace" | "workstream";
      author_user_id: string;
      owning_workstream_id: string | null;
    }>(`SELECT scope, author_user_id, owning_workstream_id FROM automation_directory
          WHERE workspace_id = ? AND automation_id = ? AND lifecycle <> 'deleted'`,
    request.workspaceId, request.automationId).toArray()[0];
    if (!row) return { authorized: false };
    // A room's automation is the room's: every active participant may read it,
    // and participation lives in the work stream's own object rather than
    // here. The viewer overlay this object *does* keep is the same fact the
    // sidebar is filtered by, so it answers without a second round trip.
    if (row.scope === "workstream" && row.owning_workstream_id) {
      const participant = this.state.storage.sql.exec<{ is_participant: number }>(
        `SELECT is_participant FROM workspace_workstream_viewers
          WHERE workstream_id = ? AND user_id = ?`,
        row.owning_workstream_id,
        request.userId,
      ).toArray()[0];
      return { authorized: participant?.is_participant === 1 };
    }
    return {
      authorized: row.scope === "workspace" || row.author_user_id === request.userId,
    };
  }

  /** Complete-replace one automation or watched-link evaluator generation. */
  async applyExternalEventRegistrations(input: unknown): Promise<{
    applied: boolean;
    effectiveAfterEventSequence: number;
  }> {
    await this.initialized;
    const request = ExternalEventRegistrationProjectionV1Schema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return applyWorkspaceExternalEventRegistrations(this.state.storage, request);
  }

  /** Cheap connector-ingress admission check; matching still happens after normalization. */
  async hasActiveExternalEventRegistration(input: unknown): Promise<{ active: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      connectionId: IdSchema,
      eventType: z.string().min(1).max(200),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return hasActiveWorkspaceExternalEventRegistration(this.state.storage, request);
  }

  /** Deterministically create ID-only destination receipts for one accepted event. */
  async matchExternalEventDestinations(input: unknown) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, eventId: IdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return matchWorkspaceExternalEventDestinations(this.env, this.state.storage, request);
  }

  async claimExternalEventDelivery(input: unknown) {
    await this.initialized;
    const request = WorkspaceExternalEventDeliveryClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceExternalEventDelivery(this.state.storage, request);
  }

  async settleExternalEventDelivery(input: unknown): Promise<void> {
    await this.initialized;
    const request = WorkspaceExternalEventDeliverySettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    settleWorkspaceExternalEventDelivery(this.state.storage, request);
  }

  /**
   * The title to show as a generated work stream's origin label.
   *
   * WorkstreamDO renders the summary and does not hold the automation's
   * directory row. It used to read it as SQL through the workspace runtime
   * facade, which routes by table name and sends an unrecognised one to the
   * regional database — which is how this read came to answer
   * `no such table: automation_directory` on every attempt to open an
   * automation's run work stream.
   *
   * A deleted automation answers `null` rather than its last title: the work
   * stream outlives the automation that made it, and the label should go quiet
   * rather than name something the workspace no longer has.
   */
  /**
   * Admit one realtime dictation socket: sweep, spend the ticket, take a slot.
   *
   * The service used to send these as separate statements through the
   * workspace runtime facade — three round trips, and three critical sections
   * rather than one. Here it is a single decision, and the concurrency caps
   * live beside the insert that enforces them rather than travelling from a
   * caller that could pass a larger number.
   *
   * A refusal comes back as an outcome rather than a throw: a replayed ticket
   * and a workspace at its cap are ordinary answers, and the sentence the
   * person reads is the service's to choose.
   */
  /** The workspace-shared template gallery, at each template's latest version. */
  async listAutomationTemplates(
    input: { workspaceId: string },
  ): Promise<WorkspaceAutomationTemplateList> {
    await this.initialized;
    const workspaceId = IdSchema.parse(input.workspaceId);
    this.assertWorkspace(workspaceId);
    return listWorkspaceAutomationTemplates(this.state.storage, workspaceId);
  }

  /**
   * Whether this person owns an active template with this id.
   *
   * A preflight, so the service can answer 404 before it validates a draft's
   * connectors. Without it, adding a version to somebody else's template
   * answers with a connector error — which both changes the endpoint's
   * contract and tells a caller about connector state they have no claim on.
   * The write still fences on ownership; this only decides what is said.
   */
  async automationTemplateOwnership(
    input: WorkspaceAutomationTemplateOwnershipRequest,
  ): Promise<WorkspaceAutomationTemplateOwnership> {
    await this.initialized;
    const request = WorkspaceAutomationTemplateOwnershipRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceAutomationTemplateOwnership(this.state.storage, request);
  }

  /** Publish a template and its first version, or neither. */
  async publishAutomationTemplate(
    input: WorkspaceAutomationTemplatePublishRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceAutomationTemplatePublishRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    publishWorkspaceAutomationTemplate(this.state.storage, request);
  }

  /**
   * Add the next version of a template the caller owns.
   *
   * The version number is read and bumped in one critical section, which two
   * separate statements through the runtime facade could not do: both readers
   * saw the same number and the unique constraint refused the second write.
   */
  async addAutomationTemplateVersion(
    input: WorkspaceAutomationTemplateVersionRequest,
  ): Promise<WorkspaceAutomationTemplateVersionResult> {
    await this.initialized;
    const request = WorkspaceAutomationTemplateVersionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return addWorkspaceAutomationTemplateVersion(this.state.storage, request);
  }

  /**
   * The title to show as a generated work stream's origin label.
   *
   * WorkstreamDO renders the summary and does not hold the automation's
   * directory row. It used to read it as SQL through the workspace runtime
   * facade, which routes by table name and sends an unrecognised one to the
   * regional database — which is how this read came to answer
   * `no such table: automation_directory` on every attempt to open an
   * automation's run work stream.
   *
   * A deleted automation answers `null` rather than its last title: the work
   * stream outlives the automation that made it, and the label should go quiet
   * rather than name something the workspace no longer has.
   */
  async automationOriginLabel(
    input: WorkspaceAutomationOriginLabelRequest,
  ): Promise<WorkspaceAutomationOriginLabel> {
    await this.initialized;
    const request = WorkspaceAutomationOriginLabelRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ title: string }>(
      `SELECT title FROM automation_directory
        WHERE automation_id = ? AND workspace_id = ? AND lifecycle <> 'deleted'`,
      request.automationId,
      request.workspaceId,
    ).toArray()[0];
    return WorkspaceAutomationOriginLabelSchema.parse({ title: row?.title ?? null });
  }
}
