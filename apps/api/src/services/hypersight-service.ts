import {
  HyperSightPreferenceSchema,
  HyperSightSchema,
  type HyperSight,
  type HyperSightBlockRun,
  type HyperSightPreference,
  type UpdateHyperSightPreferenceRequest,
  type UpdateHyperSightRequest,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { resolveAgentModelRouting } from "./agent-model-flags";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
} from "../telemetry/product-usage";
import {
  publishPersonalWorkstreamEvent,
  publishWorkstreamEvent,
  startWorkstreamWorkflow,
} from "./integrations";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { workstreamExecutionEnvironment } from "./workstream-runtime-database";

interface ConfigurationRow {
  id: string;
  version_number: number;
  blocks_json: string;
  created_at: string;
}

interface BlockSnapshot {
  id: string;
  prompt: string;
}

export interface HyperSightBlockRunRow {
  id: string;
  block_id: string;
  configuration_version_id: string;
  trigger_sequence: number;
  status: HyperSightBlockRun["status"];
  markdown: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function parseBlocks(value: string): BlockSnapshot[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const id = (entry as { id?: unknown }).id;
      const prompt = (entry as { prompt?: unknown }).prompt;
      return typeof id === "string" && typeof prompt === "string" ? [{ id, prompt }] : [];
    });
  } catch {
    return [];
  }
}

function parseRunError(value: string | null): { code: string; message: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown };
    return typeof parsed.code === "string" && typeof parsed.message === "string"
      ? { code: parsed.code, message: parsed.message }
      : null;
  } catch {
    return null;
  }
}

export function hyperSightBlockRunFromRow(row: HyperSightBlockRunRow): HyperSightBlockRun {
  return {
    id: row.id,
    blockId: row.block_id,
    configurationVersionId: row.configuration_version_id,
    triggerSequence: Number(row.trigger_sequence),
    status: row.status,
    markdown: row.markdown,
    error: parseRunError(row.error_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function latestConfiguration(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<ConfigurationRow | null> {
  return (await workstreamExecutionEnvironment(env, workspaceId, workstreamId)).DB.prepare(
    `SELECT id, version_number, blocks_json, created_at
       FROM hypersight_configuration_versions
      WHERE workspace_id = ? AND workstream_id = ?
      ORDER BY version_number DESC
      LIMIT 1`,
  ).bind(workspaceId, workstreamId).first<ConfigurationRow>();
}

async function latestRunForBlock(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  block: BlockSnapshot,
): Promise<HyperSightBlockRun | null> {
  const row = await (await workstreamExecutionEnvironment(env, workspaceId, workstreamId)).DB.prepare(
    `SELECT id, block_id, configuration_version_id, trigger_sequence, status, markdown, error_json, created_at, started_at, completed_at
      FROM hypersight_block_runs
      WHERE workspace_id = ? AND workstream_id = ? AND block_id = ? AND prompt = ?
      ORDER BY trigger_sequence DESC, created_at DESC
      LIMIT 1`,
  ).bind(workspaceId, workstreamId, block.id, block.prompt).first<HyperSightBlockRunRow>();
  return row ? hyperSightBlockRunFromRow(row) : null;
}

export async function loadHyperSight(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<HyperSight> {
  const configuration = await latestConfiguration(env, workspaceId, workstreamId);
  if (!configuration) {
    return { versionId: null, versionNumber: 0, blocks: [], updatedAt: null };
  }
  const snapshots = parseBlocks(configuration.blocks_json);
  const runs = await Promise.all(snapshots.map((block) =>
    latestRunForBlock(env, workspaceId, workstreamId, block)));
  return HyperSightSchema.parse({
    versionId: configuration.id,
    versionNumber: configuration.version_number,
    blocks: snapshots.map((block, index) => ({ ...block, latestRun: runs[index] ?? null })),
    updatedAt: configuration.created_at,
  });
}

/**
 * HyperSight is a public GET/PUT keyed only by work-stream id, so it authorizes
 * for itself rather than going through `WorkstreamService`. It therefore has to
 * apply the *same* rule, not a similar one — a block installed on a work stream
 * someone cannot read would be executed by the next run in that work stream and
 * hand its output back to them.
 */
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
  if (!visible) {
    throw new ApiError(404, "workstream_not_found", "Work stream not found");
  }
}

export class HyperSightService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async get(workstreamId: string): Promise<HyperSight> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    return loadHyperSight(this.env, this.auth.workspaceId, workstreamId);
  }

  async getPreference(workstreamId: string): Promise<HyperSightPreference> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const row = await (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB.prepare(
      `SELECT visible, updated_at
         FROM hypersight_user_preferences
        WHERE workspace_id = ? AND workstream_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, workstreamId, this.auth.userId).first<{
      visible: number;
      updated_at: string;
    }>();
    return HyperSightPreferenceSchema.parse({
      visible: row?.visible === 1,
      updatedAt: row?.updated_at ?? null,
    });
  }

  async updatePreference(
    workstreamId: string,
    input: UpdateHyperSightPreferenceRequest,
  ): Promise<HyperSightPreference> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const updatedAt = nowIso();
    await (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB.prepare(
      `INSERT INTO hypersight_user_preferences
       (workspace_id, workstream_id, user_id, visible, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         visible = excluded.visible,
         updated_at = excluded.updated_at`,
    ).bind(
      this.auth.workspaceId,
      workstreamId,
      this.auth.userId,
      input.visible ? 1 : 0,
      updatedAt,
    ).run();
    const preference = HyperSightPreferenceSchema.parse({ visible: input.visible, updatedAt });
    await publishPersonalWorkstreamEvent(this.env, this.auth.workspaceId, workstreamId, this.auth.userId, {
      type: "hypersight_preference_updated",
      preference,
    });
    return preference;
  }

  async update(workstreamId: string, input: UpdateHyperSightRequest): Promise<HyperSight> {
    await requireVisibleWorkstream(this.env, this.auth, workstreamId);
    const current = await latestConfiguration(this.env, this.auth.workspaceId, workstreamId);
    const currentVersion = current?.version_number ?? 0;
    if (input.expectedVersionNumber !== currentVersion) {
      throw new ApiError(409, "hypersight_version_conflict", "HyperSight changed in another session. Reload and try again.");
    }
    const id = newId();
    const createdAt = nowIso();
    try {
      await (await workstreamExecutionEnvironment(
        this.env,
        this.auth.workspaceId,
        workstreamId,
      )).DB.prepare(
        `INSERT INTO hypersight_configuration_versions
         (id, workspace_id, workstream_id, version_number, blocks_json, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        this.auth.workspaceId,
        workstreamId,
        currentVersion + 1,
        JSON.stringify(input.blocks),
        this.auth.userId,
        createdAt,
      ).run();
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/iu.test(error.message)) {
        throw new ApiError(409, "hypersight_version_conflict", "HyperSight changed in another session. Reload and try again.");
      }
      throw error;
    }
    const hypersight = await loadHyperSight(this.env, this.auth.workspaceId, workstreamId);
    await publishWorkstreamEvent(this.env, this.auth.workspaceId, workstreamId, {
      type: "hypersight_configuration_updated",
      hypersight,
    });
    const previousBlocks = current ? parseBlocks(current.blocks_json) : [];
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
      operationId: id,
      eventId: id,
    }).catch(() => undefined);
    return hypersight;
  }
}

export async function launchHyperSightRefresh(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  triggerSequence: number,
): Promise<HyperSightBlockRun[]> {
  const executionEnv = await workstreamExecutionEnvironment(env, workspaceId, workstreamId);
  const configuration = await latestConfiguration(executionEnv, workspaceId, workstreamId);
  if (!configuration) return [];
  const blocks = parseBlocks(configuration.blocks_json).filter((block) => block.prompt.trim().length > 0);
  if (blocks.length === 0) return [];
  const launched: HyperSightBlockRun[] = [];
  // Only the primary is wanted here: this records the model each scheduled run
  // is expected to use on its `harness_runs` row. The route plan's fallbacks
  // are resolved again and passed to `runHarness` on the execution path in
  // `integrations.ts`, which is the only place they mean anything.
  const { model } = await resolveAgentModelRouting(executionEnv, "hypersight", { workspaceId, workstreamId });
  for (const block of blocks) {
    const harnessRunId = newId();
    const blockRunId = newId();
    const createdAt = nowIso();
    try {
      const writes = await executionEnv.DB.batch([
        executionEnv.DB.prepare(
          `INSERT INTO harness_runs
           (id, workspace_id, workstream_id, origin, execution_principal_json,
            status, model, created_at)
           VALUES (?, ?, ?, 'hypersight_block', ?, 'scheduled', ?, ?)`,
        ).bind(
          harnessRunId,
          workspaceId,
          workstreamId,
          JSON.stringify({ type: "workspace", workspaceId }),
          model,
          createdAt,
        ),
        executionEnv.DB.prepare(
          `INSERT INTO hypersight_block_runs
           (id, workspace_id, workstream_id, configuration_version_id, block_id, prompt,
            trigger_sequence, harness_run_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        ).bind(
          blockRunId,
          workspaceId,
          workstreamId,
          configuration.id,
          block.id,
          block.prompt,
          triggerSequence,
          harnessRunId,
          createdAt,
        ),
      ]);
      if (Number(writes[1]?.meta.changes ?? 0) !== 1) continue;
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/iu.test(error.message)) continue;
      throw error;
    }
    const workflowInput: WorkstreamWorkflowInput = {
      region: env.AVALON_REGION,
      workspaceId,
      workstreamId,
      harnessRunId,
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "workspace", workspaceId },
      reason: "hypersight_block",
    };
    try {
      await startWorkstreamWorkflow(executionEnv, workflowInput);
      launched.push({
        id: blockRunId,
        blockId: block.id,
        configurationVersionId: configuration.id,
        triggerSequence,
        status: "queued",
        markdown: null,
        error: null,
        createdAt,
        startedAt: null,
        completedAt: null,
      });
    } catch {
      const completedAt = nowIso();
      const failure = {
        code: "workflow_unavailable",
        message: "HyperSight could not start this refresh",
      };
      await executionEnv.DB.batch([
        executionEnv.DB.prepare(
          `UPDATE harness_runs
              SET status = 'failed', completed_at = ?, terminalized_at = ?, error_json = ?
            WHERE id = ? AND status IN ('scheduled', 'running')`,
        ).bind(completedAt, completedAt, JSON.stringify(failure), harnessRunId),
        executionEnv.DB.prepare(
          `UPDATE hypersight_block_runs
              SET status = 'failed', error_json = ?, completed_at = ?
            WHERE id = ? AND status = 'queued'`,
        ).bind(JSON.stringify(failure), completedAt, blockRunId),
      ]);
      launched.push({
        id: blockRunId,
        blockId: block.id,
        configurationVersionId: configuration.id,
        triggerSequence,
        status: "failed",
        markdown: null,
        error: failure,
        createdAt,
        startedAt: null,
        completedAt,
      });
    }
  }
  return launched;
}

export async function publishHyperSightRun(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  run: HyperSightBlockRun,
): Promise<void> {
  await publishWorkstreamEvent(env, workspaceId, workstreamId, {
    type: "hypersight_block_run_updated",
    run,
  });
}
