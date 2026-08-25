import { CreateWorkstreamRequestSchema, asWorkstreamId } from "@rally/contracts";
import type {
  ExecutionPrincipal,
  Scope,
  SlackOriginContext,
  SlackSearchAuthorization,
  Workstream,
} from "@rally/contracts";
import { newId } from "@rally/db";
import type { z } from "zod";

import { workspaceDOName, workstreamDOName, substreamAgentName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import { noFlowSpan, type FlowSpan } from "../observability/tracing";
import { provisionalWorkstreamDescription } from "./workstream-description-service";
import { nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import {
  withWorkstreamRuntimeDatabase,
  writeRegionalWorkstreamAnchorBatch,
} from "./workstream-runtime-database";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

type CreateInput = z.infer<typeof CreateWorkstreamRequestSchema> & {
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
   * The caller's open `workstream_create` span. Creation is the slowest thing
   * a person waits on in Avalon, and every step below is an awaited round trip
   * to D1, a Durable Object, or the email router — so the span names here are
   * the whole diagnosis. See `docs/performance-tracing.md`.
   */
  span?: FlowSpan;
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
    messageId: string;
    harnessRunId: string;
  }> {
    const span = options.span ?? noFlowSpan;
    const body = CreateWorkstreamRequestSchema.parse(input);
    // Named for the second read it is: `POST /workstreams` already resolved the
    // authority control row before choosing this service, and a span of its own
    // is where that duplicated round trip becomes visible instead of hiding
    // inside one aggregate number.
    const control = await span.step("workstream.create.authority.read_recheck", () =>
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
    const scope = input.scope ?? "personal";
    const requestHash = workstreamImportHash({
      ...body,
      descriptionSource: input.descriptionSource ?? "derived",
      scope,
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
      "avalon.workstream.id": receipt.workstream_id,
      "avalon.create.receipt_state": receipt.state,
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
    if (receipt.state === "completed" && receipt.message_id && receipt.harness_run_id) {
      // A replayed create is a different latency question from a first one, so
      // it is labelled rather than folded into the same distribution.
      span.setAttributes({ "avalon.create.path": "replayed_receipt" });
      const workstream = await span.step("workstream.create.replayed_detail.read", () => client.get());
      return {
        workstream,
        messageId: receipt.message_id,
        harnessRunId: receipt.harness_run_id,
      };
    }
    span.setAttributes({ "avalon.create.path": "fresh" });

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

    const created = await span.step("workstream.create.object.initialize", () => client.initialize({
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
      openingStructuredContent: options.openingStructuredContent ?? null,
      clientMessageId: body.clientMessageId,
      participantUserIds: body.participantUserIds,
      attachmentIds: body.attachmentIds,
      scope,
      originResourceIds: options.originResourceIds ?? [],
      modelOverride: body.modelOverride ?? null,
      originType: "ad_hoc",
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
    span.setAttributes({ "avalon.harness_run.id": created.harnessRunId });
    const substream = await durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      this.auth.workspaceId,
      substreamAgentName(
        this.env.AVALON_REGION,
        this.auth.workspaceId,
        asWorkstreamId(receipt.workstream_id),
      ),
    );
    await span.step("workstream.create.substream.flush_effects", () => substream.flushEffectsToWorkstreamDO());
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
    await span.step("workstream.create.workstream.flush_directory", () => workstream.flushWorkspaceDirectoryEffects());
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    if (!await span.step("workstream.create.workspace.directory_probe", () => workspace.hasWorkstreamDirectory({
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
    }))) throw new Error("workspace_directory_creation_snapshot_missing");
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
      created.messageId,
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
    // the sidebar. The routed environment matters: `advanceTitle` writes
    // `workstreams`, which post-cutover lives behind the runtime router.
    if (body.title == null) {
      const naming = nameWorkstream(
        withWorkstreamRuntimeDatabase(this.env, this.auth.workspaceId, receipt.workstream_id),
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
      span.setAttributes({ "avalon.create.first_naming": this.defer ? "deferred" : "awaited" });
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
