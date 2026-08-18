import {
  HyperSightBlockRunSchema,
  HyperSightPreferenceSchema,
  HyperSightSchema,
  type HyperSight,
  type HyperSightBlockRun,
  type HyperSightPreference,
  type UpdateHyperSightPreferenceRequest,
  type UpdateHyperSightRequest,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import { z } from "zod";

import { HyperSightControlRequestSchema } from "../durable-objects/hypersight-protocol";
import type { HyperSightContextFence } from "../durable-objects/hypersight-protocol";
import { workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
} from "../telemetry/product-usage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

const HyperSightResponseSchema = z.object({ hypersight: HyperSightSchema }).passthrough();
const HyperSightPreferenceResponseSchema = z.object({
  preference: HyperSightPreferenceSchema,
}).strict();
const HyperSightRunsResponseSchema = z.object({
  runs: z.array(HyperSightBlockRunSchema),
}).strict();

async function hypersightControl(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  body: z.input<typeof HyperSightControlRequestSchema>,
): Promise<unknown> {
  const stub = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    workspaceId,
    workstreamDOName(env.AVALON_REGION, workspaceId, workstreamId),
  );
  const response = await stub.fetch("https://workstream.internal/internal/hypersight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(HyperSightControlRequestSchema.parse(body)),
  });
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    const code = typeof payload?.error === "string" ? payload.error : "hypersight_control_unavailable";
    if (response.status === 409 && code === "hypersight_version_conflict") {
      throw new ApiError(409, code, "HyperSight changed in another session. Reload and try again.");
    }
    const status = [400, 401, 403, 404, 409, 422, 429, 503].includes(response.status)
      ? response.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503
      : 503;
    throw new ApiError(status, code, "HyperSight is temporarily unavailable");
  }
  return payload;
}

export async function loadHyperSight(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<HyperSight> {
  const payload = await hypersightControl(env, workspaceId, workstreamId, {
    operation: "get",
    workspaceId,
    workstreamId,
  });
  return HyperSightResponseSchema.parse(payload).hypersight;
}

/** Apply the same visibility rule as the work-stream product routes. */
async function requireVisibleWorkstream(env: Env, auth: AuthContext, workstreamId: string): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  const visible = authority.phase === "durable_object_open"
    ? await new WorkstreamDirectoryService(env, auth).visible(workstreamId)
    : Boolean(await env.DB.prepare(
      `SELECT 1 FROM workstreams workstream
        WHERE workstream.id = ? AND workstream.workspace_id = ?
          AND workstream.archived_at IS NULL
          AND (workstream.scope = 'workspace' OR workstream.created_by_user_id = ?
            OR EXISTS (SELECT 1 FROM workstream_participants participant
                WHERE participant.workstream_id = workstream.id
                  AND participant.user_id = ? AND participant.removed_at IS NULL))`,
    ).bind(workstreamId, auth.workspaceId, auth.userId, auth.userId).first());
  if (!visible) throw new ApiError(404, "workstream_not_found", "Work stream not found");
}

export class HyperSightService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async get(workstreamId: string): Promise<HyperSight> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    return loadHyperSight(this.env, this.auth.workspaceId, workstreamId);
  }

  async getPreference(workstreamId: string): Promise<HyperSightPreference> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const payload = await hypersightControl(this.env, this.auth.workspaceId, workstreamId, {
      operation: "get_preference",
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
    });
    return HyperSightPreferenceResponseSchema.parse(payload).preference;
  }

  async updatePreference(
    workstreamId: string,
    input: UpdateHyperSightPreferenceRequest,
  ): Promise<HyperSightPreference> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const payload = await hypersightControl(this.env, this.auth.workspaceId, workstreamId, {
      operation: "update_preference",
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
      visible: input.visible,
      updatedAt: nowIso(),
    });
    return HyperSightPreferenceResponseSchema.parse(payload).preference;
  }

  async update(workstreamId: string, input: UpdateHyperSightRequest): Promise<HyperSight> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const current = await loadHyperSight(this.env, this.auth.workspaceId, workstreamId);
    const configurationVersionId = newId();
    const payload = await hypersightControl(this.env, this.auth.workspaceId, workstreamId, {
      operation: "update_configuration",
      workspaceId: this.auth.workspaceId,
      workstreamId,
      userId: this.auth.userId,
      input,
      configurationVersionId,
      createdAt: nowIso(),
    });
    const hypersight = HyperSightResponseSchema.parse(payload).hypersight;
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
    return hypersight;
  }
}

export async function launchHyperSightRefresh(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  triggerSequence: number,
  contextFence: HyperSightContextFence,
): Promise<HyperSightBlockRun[]> {
  const payload = await hypersightControl(env, workspaceId, workstreamId, {
    operation: "schedule_refresh",
    workspaceId,
    workstreamId,
    triggerSequence,
    contextFence,
  });
  return HyperSightRunsResponseSchema.parse(payload).runs;
}
