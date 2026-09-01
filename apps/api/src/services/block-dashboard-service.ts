import {
  BlockDashboardBlockRunSchema,
  BlockDashboardPreferenceSchema,
  BlockDashboardSchema,
  asWorkstreamId,
  type WorkspaceId,
  type BlockDashboard,
  type BlockDashboardBlockRun,
  type BlockDashboardPreference,
  type UpdateBlockDashboardPreferenceRequest,
  type UpdateBlockDashboardRequest,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod/v3";

import { BlockDashboardControlRequestSchema } from "../durable-objects/block-dashboard-protocol";
import type { BlockDashboardContextFence } from "../durable-objects/block-dashboard-protocol";
import { workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
} from "../telemetry/product-usage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { rpcResultBody } from "../durable-objects/rpc-result";
import { WorkstreamDirectoryService } from "./workstream-directory-service";

const BlockDashboardResponseSchema = z.object({ blockDashboard: BlockDashboardSchema }).passthrough();
const BlockDashboardPreferenceResponseSchema = z.object({
  preference: BlockDashboardPreferenceSchema,
}).strict();
const BlockDashboardRunsResponseSchema = z.object({
  runs: z.array(BlockDashboardBlockRunSchema),
}).strict();

async function blockDashboardControl(
  env: Env,
  workspaceId: WorkspaceId,
  workstreamId: string,
  body: z.input<typeof BlockDashboardControlRequestSchema>,
): Promise<unknown> {
  const stub = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    workspaceId,
    workstreamDOName(env.AVALON_REGION, workspaceId, asWorkstreamId(workstreamId)),
  );
  const response = await stub.controlBlockDashboard(BlockDashboardControlRequestSchema.parse(body));
  const payload = rpcResultBody(response) as { error?: unknown } | null;
  if (response.status < 200 || response.status >= 300) {
    const code = typeof payload?.error === "string" ? payload.error : "block_dashboard_control_unavailable";
    if (response.status === 409 && code === "block_dashboard_version_conflict") {
      throw new ApiError(409, code, "HyperSight changed in another session. Reload and try again.");
    }
    const status = [400, 401, 403, 404, 409, 422, 429, 503].includes(response.status)
      ? response.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503
      : 503;
    throw new ApiError(status, code, "HyperSight is temporarily unavailable");
  }
  return payload;
}

export async function loadBlockDashboard(
  env: Env,
  workspaceId: WorkspaceId,
  workstreamId: string,
): Promise<BlockDashboard> {
  const payload = await blockDashboardControl(env, workspaceId, workstreamId, {
    operation: "get",
    workspaceId,
    workstreamId,
  });
  return BlockDashboardResponseSchema.parse(payload).blockDashboard;
}

/** Apply the same visibility rule as the work-stream product routes. */
async function requireVisibleWorkstream(env: Env, auth: AuthContext, workstreamId: string): Promise<void> {
  const visible = await new WorkstreamDirectoryService(env, auth).visible(workstreamId);
  if (!visible) throw new ApiError(404, "workstream_not_found", "Work stream not found");
}

export class BlockDashboardService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async get(workstreamId: string): Promise<BlockDashboard> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    return loadBlockDashboard(this.env, this.auth.workspaceId, workstreamId);
  }

  async updatePreference(
    workstreamId: string,
    input: UpdateBlockDashboardPreferenceRequest,
  ): Promise<BlockDashboardPreference> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const payload = await blockDashboardControl(this.env, this.auth.workspaceId, workstreamId, {
      operation: "update_preference",
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
      visible: input.visible,
      updatedAt: nowIso(),
    });
    return BlockDashboardPreferenceResponseSchema.parse(payload).preference;
  }

  async update(workstreamId: string, input: UpdateBlockDashboardRequest): Promise<BlockDashboard> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const current = await loadBlockDashboard(this.env, this.auth.workspaceId, workstreamId);
    const configurationVersionId = newId();
    const payload = await blockDashboardControl(this.env, this.auth.workspaceId, workstreamId, {
      operation: "update_configuration",
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
      input,
      configurationVersionId,
      createdAt: nowIso(),
    });
    const blockDashboard = BlockDashboardResponseSchema.parse(payload).blockDashboard;
    const previousBlocks = current.blocks;
    const previousIds = previousBlocks.map((block) => block.id);
    const nextIds = input.blocks.map((block) => block.id);
    const action = nextIds.length > previousIds.length
      ? "add" as const
      : nextIds.length < previousIds.length
        ? "delete" as const
        : previousIds.some((id, index) => id !== nextIds[index])
          ? "reorder" as const
          : "edit" as const;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: "hypersight_configuration_changed",
      properties: {
        workstreamId,
        action,
        blockCount: telemetryCountBucket(input.blocks.length),
        result: "success",
      },
      operationId: configurationVersionId,
      eventId: configurationVersionId,
    }).catch(() => undefined);
    return blockDashboard;
  }
}

export async function launchBlockDashboardRefresh(
  env: Env,
  workspaceId: WorkspaceId,
  workstreamId: string,
  triggerSequence: number,
  contextFence: BlockDashboardContextFence,
): Promise<BlockDashboardBlockRun[]> {
  const payload = await blockDashboardControl(env, workspaceId, workstreamId, {
    operation: "schedule_refresh",
    workspaceId,
    workstreamId,
    triggerSequence,
    contextFence,
  });
  return BlockDashboardRunsResponseSchema.parse(payload).runs;
}
