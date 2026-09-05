import { CreateWorkstreamRequestSchema, asSubstreamId, asWorkstreamId } from "@rally/contracts";
import type {
  ExecutionPrincipal,
  ProjectSummary,
  Scope,
  SlackOriginContext,
  SlackSearchAuthorization,
  Workstream,
} from "@rally/contracts";
import { newId } from "@rally/db";
import type { z } from "zod";

import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import {
  WorkspaceProjectMutationResultSchema,
} from "../durable-objects/workspace-project-protocol";
import type {
  WorkspaceProjectMembershipPlanResult,
  WorkspaceProjectMembershipSettleRequestSchema,
} from "../durable-objects/workspace-project-protocol";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import { noFlowSpan, type FlowSpan } from "../observability/tracing";
import { provisionalWorkstreamDescription } from "./workstream-description-service";
import { nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import {
  writeRegionalWorkstreamAnchorBatch,
} from "./workstream-runtime-database";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { readWorkstreamAuthorityControl, type WorkstreamAuthorityControl } from "./workstream-authority";

type ParsedCreateInput = z.infer<typeof CreateWorkstreamRequestSchema>;
type CreateInput = Omit<ParsedCreateInput, "mentions"> & {
  /** Optional at this internal boundary because the schema fills the empty case. */
  mentions?: ParsedCreateInput["mentions"];
  descriptionSource?: "authored" | "derived";
  /**
   * Who may read the work stream from birth, for the callers that know. Omitted
   * means `personal`, which is what a work stream somebody starts in Avalon is:
   * the creator and anyone they named, and nobody else until one of them opens
   * it. Not part of `CreateWorkstreamRequestSchema` and deliberately so — a
   * request on the wire cannot claim an audience, because an audience is
   * something an ingress *knows* (the public Slack channel the mention was read
   * out of), never something a caller asserts about itself.
   */
  scope?: Scope;
};

interface ReceiptRow {
  workstream_id: string;
  generation: number;
  request_hash: string;
  state: "reserved" | "initialized" | "completed" | "failed";
  message_id: string | null;
  harness_run_id: string | null;
}

interface CreateOptions {
  /** Authority snapshot already resolved by the owning HTTP route in this request. */
  authorityControl?: WorkstreamAuthorityControl;
  openingStructuredContent?: unknown;
  opportunitySnapshot?: {
    opportunityId: string;
    version: number;
    displayPromptHash: string;
    executionPromptHash: string;
  };
  originResourceIds?: string[];
  executionPrincipal?: ExecutionPrincipal;
  slackOrigin?: SlackOriginContext;
  slackSearchAuthorization?: SlackSearchAuthorization;
  reason?: string;
  telemetryOperationId?: string;
  /**
   * Whether the people in `participantUserIds` are told they were added.
   *
   * The caller's to state, never the object's to infer, for the reason `scope`
   * is also an argument: this service is reached both by a person picking names
   * in "Add people" and by a connector ingress handing over a conversation's
   * resolved roster, and only the caller can tell those apart. Omitted means
   * quiet.
   */
  notifyParticipants?: boolean;
  /**
   * The caller's open `workstream_create` span. Creation is the slowest thing
   * a person waits on in Avalon, and every step below is an awaited round trip
   * to D1, a Durable Object, or the email router — so the span names here are
   * the whole diagnosis. See `docs/performance-tracing.md`.
   */
  span?: FlowSpan;
}

/** Derive a project-start audience without allowing the launcher to widen a personal project. */
export function resolveProjectWorkstreamAudience(
  project: ProjectSummary,
  requestedParticipantUserIds: readonly string[],
): { scope: Scope; participantUserIds: string[] } {
  if (project.scope === "workspace") {
    return { scope: "workspace", participantUserIds: [...new Set(requestedParticipantUserIds)] };
  }
  const projectParticipantUserIds = project.participants
    .filter((participant) => participant.state === "active")
    .map((participant) => participant.userId);
  const allowed = new Set(projectParticipantUserIds);
  if (requestedParticipantUserIds.some((userId) => !allowed.has(userId))) {
    throw new ApiError(
      409,
      "project_workstream_audience_mismatch",
      "Add that person to the project before starting this work stream",
    );
  }
  return { scope: "personal", participantUserIds: projectParticipantUserIds };
}

/** Audience plus current defaults, for the initialize payload. */
export function resolveProjectWorkstreamStart(
  project: ProjectSummary,
  requestedParticipantUserIds: readonly string[],
  existingOriginResourceIds: readonly string[] = [],
): { scope: Scope; participantUserIds: string[]; originResourceIds: string[] } {
  const audience = resolveProjectWorkstreamAudience(project, requestedParticipantUserIds);
  return {
    ...audience,
    // Caller resources precede project defaults; both are deduplicated.
    originResourceIds: [...new Set([...existingOriginResourceIds, ...project.defaultResourceIds])],
  };
}

interface ReplayProjectWorkspace {
  prepareProjectMembership(input: {
    workspaceId: AuthContext["workspaceId"];
    userId: AuthContext["userId"];
    projectId: ProjectSummary["id"];
    workstreamId: ReturnType<typeof asWorkstreamId>;
  }): Promise<WorkspaceProjectMembershipPlanResult>;
  finalizeProjectMembership(
    input: z.infer<typeof WorkspaceProjectMembershipSettleRequestSchema>,
  ): Promise<unknown>;
  cancelProjectMembership(
    input: z.infer<typeof WorkspaceProjectMembershipSettleRequestSchema>,
  ): Promise<unknown>;
}

/** Reconcile the project side effect that is outside the D1 create receipt. */
export async function reconcileReplayedProjectMembership(input: {
  workspace: ReplayProjectWorkspace;
  client: Pick<WorkstreamObjectClient, "update" | "addParticipant" | "attachResource">;
  auth: AuthContext;
  projectId: ProjectSummary["id"];
  workstreamId: ReturnType<typeof asWorkstreamId>;
  workstream: {
    scope: Scope;
    participants: Array<{ user: { id: string } }>;
  };
}): Promise<void> {
  const plan = await input.workspace.prepareProjectMembership({
    workspaceId: input.auth.workspaceId,
    userId: input.auth.userId,
    projectId: input.projectId,
    workstreamId: input.workstreamId,
  });
  if (!plan.ok) throw new ApiError(404, plan.code, "The project is unavailable");
  const settle = {
    workspaceId: input.auth.workspaceId,
    userId: input.auth.userId,
    projectId: input.projectId,
    workstreamId: input.workstreamId,
    membershipGeneration: plan.membershipGeneration,
    sourceProjectId: plan.sourceProjectId,
    sourceDetached: plan.sourceDetached,
  };
  try {
    const currentParticipantIds = input.workstream.participants.map((participant) => participant.user.id);
    resolveProjectWorkstreamAudience(plan.project, currentParticipantIds);
    if (plan.project.scope === "workspace" && input.workstream.scope !== "workspace") {
      await input.client.update({ scope: "workspace" });
    }
    for (const participant of plan.project.participants) {
      if (participant.state === "active" && !currentParticipantIds.includes(participant.userId)) {
        await input.client.addParticipant(participant.userId);
      }
    }
    for (const resourceId of plan.project.defaultResourceIds) await input.client.attachResource(resourceId);
    const membership = WorkspaceProjectMutationResultSchema.parse(
      await input.workspace.finalizeProjectMembership(settle),
    );
    if (!membership.ok) {
      throw new ApiError(409, membership.code, "The project changed while the work stream was being prepared");
    }
  } catch (error) {
    await input.workspace.cancelProjectMembership(settle).catch(() => undefined);
    throw error;
  }
}

/** Regional creation coordinator; the new WorkstreamDO owns product state. */
export class WorkstreamObjectCreationService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    /**
     * HTTP callers hand in `waitUntil`-backed deferral so naming happens after
     * the response, exactly as the legacy service documents; callers with no
     * way to defer get the call awaited rather than dropped.
     */
    private readonly defer?: (task: Promise<unknown>) => void,
  ) {}

  async create(input: CreateInput, options: CreateOptions = {}): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string;
  }> {
    const span = options.span ?? noFlowSpan;
    const body = CreateWorkstreamRequestSchema.parse(input);
    // Named for the second read it is: `POST /workstreams` already resolved the
    // authority control row before choosing this service, and a span of its own
    // is where that duplicated round trip becomes visible instead of hiding
    // inside one aggregate number.
    const control = options.authorityControl ?? await span.step("workstream.create.authority.read_recheck", () =>
      readWorkstreamAuthorityControl(this.env));
    if (control.phase !== "durable_object_open") {
      throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
    }
    // Resolved once, and part of the request rather than a property of it: two
    // creates under one `clientMessageId` that resolved different audiences are
    // different requests, and the receipt has to say so. A Slack event id is a
    // stable create key across the redeliveries Slack makes on an ack timeout,
    // while `resolveSlackChannelType` is re-run per delivery and answers
    // `unknown` — which fails closed to `personal` — whenever `conversations.info`
    // times out or the token has lost the scope for it. Left out of the hash, a
    // redelivery that resolved `private` would match the receipt of an attempt
    // that resolved `public`, replay it, and hand the caller back the
    // workspace-readable work stream the first attempt had already committed.
    // In the hash, that mismatch is the 409 the receipt exists to raise.
    const requestedScope = input.scope ?? "personal";
    const { mentions: requestMentions, ...hashBody } = body;
    const requestHash = workstreamImportHash({
      ...hashBody,
      // Keep empty mentions compatible with receipts reserved by the previous
      // Worker during a rolling deploy. Non-empty spans change the durable
      // message and therefore remain part of the idempotency identity.
      ...(requestMentions.length > 0 ? { mentions: requestMentions } : {}),
      descriptionSource: input.descriptionSource ?? "derived",
      scope: requestedScope,
    });
    const at = new Date().toISOString();
    const proposedId = newId();
    await span.step("workstream.create.receipt.reserve", () => this.env.DB.prepare(
      `INSERT OR IGNORE INTO workstream_create_receipts
         (workspace_id, creator_user_id, client_message_id, workstream_id,
          generation, request_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    ).bind(
      this.auth.workspaceId,
      this.auth.userId,
      body.clientMessageId,
      proposedId,
      control.generation,
      requestHash,
      at,
      at,
    ).run());
    const receipt = await span.step("workstream.create.receipt.read", () => this.receipt(body.clientMessageId));
    if (!receipt || receipt.request_hash !== requestHash) {
      throw new ApiError(409, "workstream_create_idempotency_conflict", "This create key was already used");
    }
    if (receipt.generation !== control.generation) {
      throw new ApiError(409, "workstream_create_generation_stale", "Retry the create against the current authority generation");
    }
    span.setAttributes({
      "rally.workstream.id": receipt.workstream_id,
      "rally.create.receipt_state": receipt.state,
    });
    // The object's own spans nest under this one automatically: a Durable
    // Object call is a traced binding call, and everything it runs happens in
    // this span's async context.
    const client = new WorkstreamObjectClient(
      this.env,
      this.auth,
      receipt.workstream_id,
      "0",
      options.span !== undefined,
    );
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    if (receipt.state === "completed" && receipt.message_id && receipt.harness_run_id) {
      // A replayed create is a different latency question from a first one, so
      // it is labelled rather than folded into the same distribution.
      span.setAttributes({ "rally.create.path": "replayed_receipt" });
      const workstream = await span.step("workstream.create.replayed_detail.read", () => client.get());
      if (body.projectId) {
        await reconcileReplayedProjectMembership({
          workspace,
          client,
          auth: this.auth,
          projectId: body.projectId,
          workstreamId: asWorkstreamId(receipt.workstream_id),
          workstream,
        });
      }
      return {
        workstream,
        turnId: receipt.message_id,
        harnessRunId: receipt.harness_run_id,
      };
    }
    span.setAttributes({ "rally.create.path": "fresh" });

    let scope = requestedScope;
    let participantUserIds = body.participantUserIds;
    let originResourceIds = options.originResourceIds ?? [];
    let projectSettle: z.infer<typeof WorkspaceProjectMembershipSettleRequestSchema> | null = null;
    if (body.projectId) {
      const plan = await workspace.prepareProjectMembership({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId: body.projectId,
        workstreamId: asWorkstreamId(receipt.workstream_id),
      });
      if (!plan.ok) {
        throw new ApiError(404, plan.code, "The project is unavailable");
      }
      const projectStart = resolveProjectWorkstreamStart(
        plan.project,
        body.participantUserIds,
        originResourceIds,
      );
      scope = projectStart.scope;
      participantUserIds = projectStart.participantUserIds;
      originResourceIds = projectStart.originResourceIds;
      projectSettle = {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId: body.projectId,
        workstreamId: asWorkstreamId(receipt.workstream_id),
        membershipGeneration: plan.membershipGeneration,
        sourceProjectId: null,
        sourceDetached: false,
      };
    }

    const objective = body.objective
      ?? provisionalWorkstreamDescription(body.openingMessage, "Review the attached files");
    const title = body.title ?? provisionalWorkstreamTitle(objective, "New work stream");
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
    } as const;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const email = await span.step("workstream.create.email_address.reserve", () => emailRouting.reserve(routeInput));

    await span.step("workstream.create.d1_rows.write", () => writeRegionalWorkstreamAnchorBatch(
      this.env,
      { workspaceId: this.auth.workspaceId, workstreamId: receipt.workstream_id, at },
      () => [
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO workstream_authority_routes
             (workspace_id, workstream_id, generation, object_name, state, stage_index,
              source_cursor, source_fence_sequence, source_hash, target_hash,
              row_counts_json, imported_at, verified_at, activated_at, updated_at)
           VALUES (?, ?, ?, ?, 'verified', 0, 0, 0, 'created_in_do', 'created_in_do',
                   '{}', ?, ?, NULL, ?)`,
        ).bind(
          this.auth.workspaceId,
          receipt.workstream_id,
          control.generation,
          `${this.env.AVALON_REGION}:${this.auth.workspaceId}:${receipt.workstream_id}`,
          at,
          at,
          at,
        ),
      ],
    ));

    // The parent first. Reserving the main conversation creates the parent's
    // row and puts a provisional row in the workspace directory synchronously,
    // so the person about to open this work stream finds it listed before the
    // child has said anything. Idempotent: a retried create finds the child
    // already registered and enqueues nothing twice.
    const workstream = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      this.auth.workspaceId,
      workstreamDOName(
        this.env.AVALON_REGION,
        this.auth.workspaceId,
        asWorkstreamId(receipt.workstream_id),
      ),
    );
    await span.step("workstream.create.parent.reserve", () => workstream.reserveChild({
      workspaceId: this.auth.workspaceId,
      parentId: receipt.workstream_id,
      substreamId: asSubstreamId("0"),
      kind: "main",
      createdByUserId: this.auth.userId,
      authorityGeneration: control.generation,
      directory: {
        title,
        description: objective,
        scope,
        systemKind: null,
        emailAddress: email.emailAddress,
        titleStatus: body.title == null ? "naming" : "settled",
        createdAt: at,
      },
    }));

    let created: Awaited<ReturnType<WorkstreamObjectClient["initialize"]>>;
    try {
      created = await span.step("workstream.create.object.initialize", () => client.initialize({
      workspaceId: this.auth.workspaceId,
      workstreamId: asWorkstreamId(receipt.workstream_id),
      generation: control.generation,
      title,
      objective,
      descriptionSource: input.descriptionSource ?? "derived",
      titleStatus: body.title == null ? "naming" : "settled",
      emailAddress: email.emailAddress,
      creatorUserId: this.auth.userId,
      openingMessage: body.openingMessage,
      mentions: body.mentions,
      openingStructuredContent: options.openingStructuredContent ?? null,
      clientMessageId: body.clientMessageId,
      participantUserIds,
      notifyParticipants: options.notifyParticipants ?? false,
      attachmentIds: body.attachmentIds,
      scope,
      originResourceIds,
      modelOverride: body.modelOverride ?? null,
      systemKind: null,
      createdFromOpportunityId: options.opportunitySnapshot?.opportunityId ?? null,
      opportunityVersion: options.opportunitySnapshot?.version ?? null,
      opportunityDisplayPromptHash: options.opportunitySnapshot?.displayPromptHash ?? null,
      opportunityExecutionPromptHash: options.opportunitySnapshot?.executionPromptHash ?? null,
      executionPrincipal: options.executionPrincipal ?? { type: "user", userId: this.auth.userId },
      ...(options.slackOrigin ? { slackOrigin: options.slackOrigin } : {}),
      ...(options.slackSearchAuthorization ? {
        slackSearchAuthorization: options.slackSearchAuthorization,
      } : {}),
      ...(options.telemetryOperationId ? {
        telemetryOperationId: options.telemetryOperationId,
        telemetrySubjectUserId: this.auth.userId,
      } : {}),
      reason: options.reason ?? "opening_message",
      }));
      if (projectSettle) {
        const membership = WorkspaceProjectMutationResultSchema.parse(
          await workspace.finalizeProjectMembership(projectSettle),
        );
        if (!membership.ok) throw new ApiError(409, membership.code, "The project changed while the work stream was being prepared");
      }
    } catch (error) {
      if (projectSettle) await workspace.cancelProjectMembership(projectSettle).catch(() => undefined);
      throw error;
    }
    span.setAttributes({ "rally.harness_run.id": created.harnessRunId });
    const activatedAt = new Date().toISOString();
    const activated = await span.step("workstream.create.route.activate", () => this.env.DB.prepare(
      `UPDATE workstream_authority_routes
          SET state = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?
          AND state IN ('verified', 'active')`,
    ).bind(
      activatedAt,
      activatedAt,
      this.auth.workspaceId,
      receipt.workstream_id,
      control.generation,
    ).run());
    if (Number(activated.meta.changes ?? 0) !== 1) {
      throw new Error("workstream_create_route_activation_failed");
    }
    await span.step("workstream.create.receipt.complete", () => this.env.DB.prepare(
      `UPDATE workstream_create_receipts
          SET state = 'completed', message_id = ?, harness_run_id = ?,
              error_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?
          AND request_hash = ?`,
    ).bind(
      created.turnId,
      created.harnessRunId,
      new Date().toISOString(),
      this.auth.workspaceId,
      this.auth.userId,
      body.clientMessageId,
      requestHash,
    ).run());

    // The first naming pass. The legacy creation path schedules this and the
    // object path never did, so every post-cutover work stream kept its
    // provisional title in `naming` forever — a permanent skeleton shimmer in
    // the sidebar. Naming reaches transcript and identity through their typed
    // object ports; it does not need a database-shaped work-stream proxy.
    if (body.title == null) {
      const naming = nameWorkstream(
        this.env,
        {
          workspaceId: this.auth.workspaceId,
          workstreamId: receipt.workstream_id,
          userId: this.auth.userId,
          objective,
          openingMessage: body.openingMessage,
          provisionalTitle: title,
        },
      ).catch((error: unknown) => {
        logWarn(this.env, "workstream_first_naming_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: receipt.workstream_id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
      // Deferred naming is off the caller's clock by design, so the trace
      // records which of the two happened rather than a duration that would
      // mean opposite things in the two cases.
      span.setAttributes({ "rally.create.first_naming": this.defer ? "deferred" : "awaited" });
      if (this.defer) this.defer(naming); else await span.step("workstream.create.naming.first_pass", () => naming);
    }
    return created;
  }

  private receipt(clientMessageId: string): Promise<ReceiptRow | null> {
    return this.env.DB.prepare(
      `SELECT workstream_id, generation, request_hash, state, message_id, harness_run_id
         FROM workstream_create_receipts
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId, clientMessageId).first<ReceiptRow>();
  }
}
