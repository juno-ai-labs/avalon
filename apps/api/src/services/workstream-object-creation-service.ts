import { CreateWorkstreamRequestSchema } from "@avalon/contracts";
import type {
  ExecutionPrincipal,
  SlackOriginContext,
  SlackSearchAuthorization,
  Workstream,
} from "@avalon/contracts";
import { newId } from "@avalon/db";
import type { z } from "zod";

import { workspaceDOName, workstreamDOName, substreamAgentName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { provisionalWorkstreamTitle } from "./workstream-naming-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

type CreateInput = z.infer<typeof CreateWorkstreamRequestSchema> & {
  descriptionSource?: "authored" | "derived";
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
}

/** Regional creation coordinator; the new WorkstreamDO owns product state. */
export class WorkstreamObjectCreationService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async create(input: CreateInput, options: CreateOptions = {}): Promise<{
    workstream: Workstream;
    messageId: string;
    harnessRunId: string;
  }> {
    const body = CreateWorkstreamRequestSchema.parse(input);
    const control = await readWorkstreamAuthorityControl(this.env);
    if (control.phase !== "durable_object_open") {
      throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
    }
    const requestHash = workstreamImportHash({
      ...body,
      descriptionSource: input.descriptionSource ?? "derived",
    });
    const at = new Date().toISOString();
    const proposedId = newId();
    await this.env.DB.prepare(
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
    ).run();
    const receipt = await this.receipt(body.clientMessageId);
    if (!receipt || receipt.request_hash !== requestHash) {
      throw new ApiError(409, "workstream_create_idempotency_conflict", "This create key was already used");
    }
    if (receipt.generation !== control.generation) {
      throw new ApiError(409, "workstream_create_generation_stale", "Retry the create against the current authority generation");
    }
    const client = new WorkstreamObjectClient(this.env, this.auth, receipt.workstream_id);
    if (receipt.state === "completed" && receipt.message_id && receipt.harness_run_id) {
      return {
        workstream: await client.get(),
        messageId: receipt.message_id,
        harnessRunId: receipt.harness_run_id,
      };
    }

    const objective = body.objective ?? (body.openingMessage.trim() || "Review the attached files");
    const title = body.title ?? provisionalWorkstreamTitle(objective, "New work stream");
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
    } as const;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const email = await emailRouting.reserve(routeInput);

    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO workstreams
           (id, workspace_id, title, objective, origin_type, created_by_user_id,
            planned_for, harness_status, next_sequence_number, last_activity_at,
            created_at, updated_at, email_address, email_route_status,
            latest_attention_sequence_number, unread_tracking_start_sequence_number,
            scope, title_status, description_source, model_override, do_identity_anchor)
         VALUES (?, ?, ?, '', 'ad_hoc', ?, NULL, 'idle', 1, ?, ?, ?, ?, 'active',
                 0, 0, 'workspace', ?, ?, ?, 1)`,
      ).bind(
        receipt.workstream_id,
        this.auth.workspaceId,
        `[WorkstreamDO] ${receipt.workstream_id}`,
        this.auth.userId,
        at,
        at,
        at,
        email.emailAddress,
        body.title == null ? "naming" : "settled",
        input.descriptionSource ?? "derived",
        body.modelOverride ?? null,
      ),
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
    ]);

    const created = await client.initialize({
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
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
    });
    const substream = await durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      this.auth.workspaceId,
      substreamAgentName(
        this.env.AVALON_REGION,
        this.auth.workspaceId,
        receipt.workstream_id,
      ),
    );
    await substream.flushEffectsToWorkstreamDO();
    const workstream = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      this.auth.workspaceId,
      workstreamDOName(
        this.env.AVALON_REGION,
        this.auth.workspaceId,
        receipt.workstream_id,
      ),
    );
    await workstream.flushWorkspaceDirectoryEffects();
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    if (!await workspace.hasWorkstreamDirectory({
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
    })) throw new Error("workspace_directory_creation_snapshot_missing");
    const activatedAt = new Date().toISOString();
    const activated = await this.env.DB.prepare(
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
    ).run();
    if (Number(activated.meta.changes ?? 0) !== 1) {
      throw new Error("workstream_create_route_activation_failed");
    }
    await emailRouting.setStatus({ ...routeInput, status: "active" });
    await this.env.DB.prepare(
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
    ).run();
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
