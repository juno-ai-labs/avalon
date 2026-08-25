import { asUserId, type UserId, type WorkspaceId } from '@avalon/contracts';
import type { Env, IdentityAuthContext } from '../env';
import { withWorkspaceRuntimeDatabase } from '../services/workspace-runtime-database';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from './api-emitter';
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryCountBucket,
  telemetryJourneyDuration,
  type TelemetryJourneyDuration,
} from './product-usage';
import { createIdentityObjectPort } from "../runtime/identity-port";

interface CorrelatedRunInput {
  workspaceId: WorkspaceId;
  workstreamId: string;
  harnessRunId: string;
  telemetryOperationId?: string | undefined;
  telemetrySubjectUserId?: string | undefined;
}

interface RunRow {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  origin: string;
  execution_principal_json: string;
  model: string | null;
  usage_json: string | null;
  automation_id: string | null;
  automation_run_id: string | null;
  automation_trigger_type: string | null;
  first_inference_started_at: string | null;
  first_ttft_ms: number | null;
  turn_count: number;
  tool_call_count: number;
  write_tool_call_count: number;
  fallback_used: number;
}

type Duration = 'lt_100ms' | '100ms_1s' | '1s_5s' | '5s_30s' | 'gte_30s';
type Result = 'success' | 'validation_error' | 'conflict' | 'denied' | 'unavailable' | 'failed';

function durationBucket(milliseconds: number): Duration {
  if (milliseconds < 100) return 'lt_100ms';
  if (milliseconds < 1_000) return '100ms_1s';
  if (milliseconds < 5_000) return '1s_5s';
  if (milliseconds < 30_000) return '5s_30s';
  return 'gte_30s';
}

function resultClass(status: string): Result {
  if (status === 'completed') return 'success';
  if (status === 'needs_input') return 'unavailable';
  if (status === 'stopped') return 'denied';
  return 'failed';
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function runKind(row: RunRow): 'workstream' | 'automation' | 'hypersight' | 'system' {
  if (row.origin === 'hypersight_block') return 'hypersight';
  if (row.automation_id) return 'automation';
  if (row.origin === 'scheduled_digest') return 'system';
  return 'workstream';
}

function triggerType(row: RunRow): 'composer' | 'retry' | 'manual' | 'scheduled' | 'activity' | 'inbound_email' | 'digest' | 'system' {
  if (row.origin === 'human_message') return 'composer';
  if (row.origin === 'manual_retry') return 'retry';
  if (row.origin === 'scheduled_digest') return 'digest';
  if (row.origin === 'hypersight_block') return 'system';
  if (row.automation_trigger_type === 'activity') return 'activity';
  if (row.automation_trigger_type === 'inbound_email') return 'inbound_email';
  if (row.automation_trigger_type === 'scheduled') return 'scheduled';
  if (row.automation_id) return 'manual';
  return 'system';
}

function userIdForRun(row: RunRow, explicitUserId?: string): UserId | undefined {
  if (explicitUserId) return asUserId(explicitUserId);
  const principal = parseJson(row.execution_principal_json);
  return principal.type === 'user' && typeof principal.userId === 'string'
    ? asUserId(principal.userId)
    : undefined;
}

function usageTurnCount(row: RunRow): number {
  const usage = parseJson(row.usage_json);
  const stats = usage.run_stats;
  if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
    const turns = (stats as Record<string, unknown>).turns;
    if (typeof turns === 'number' && Number.isFinite(turns)) return turns;
  }
  return row.turn_count;
}

function timeToFirstOutput(row: RunRow, startedMs: number): TelemetryJourneyDuration {
  if (!row.first_inference_started_at || row.first_ttft_ms == null) return 'unknown';
  return telemetryJourneyDuration(
    Math.max(0, Date.parse(row.first_inference_started_at) - startedMs) + row.first_ttft_ms,
  );
}

/** Durable, idempotent authoritative counterpart to a renderer run intent. */
export async function emitCorrelatedRunOutcome(
  env: Env,
  input: CorrelatedRunInput,
): Promise<void> {
  const run = await env.DB.prepare(
    `SELECT hr.status, hr.started_at, hr.completed_at, hr.created_at, hr.origin,
            hr.execution_principal_json, hr.model, hr.usage_json,
            (SELECT ia.started_at FROM inference_attempts ia
              WHERE ia.harness_run_id = hr.id AND ia.ttft_ms IS NOT NULL
              ORDER BY ia.started_at, ia.id LIMIT 1) AS first_inference_started_at,
            (SELECT ia.ttft_ms FROM inference_attempts ia
              WHERE ia.harness_run_id = hr.id AND ia.ttft_ms IS NOT NULL
              ORDER BY ia.started_at, ia.id LIMIT 1) AS first_ttft_ms,
            (SELECT COUNT(DISTINCT ia.turn_id) FROM inference_attempts ia
              WHERE ia.harness_run_id = hr.id AND ia.outcome = 'success') AS turn_count,
            (SELECT COUNT(*) FROM tool_effects ti
              WHERE ti.run_id = hr.id) AS tool_call_count,
            (SELECT COUNT(*) FROM tool_effects ti
              WHERE ti.run_id = hr.id
                AND json_extract(ti.execution_plan_json, '$.mode') = 'write') AS write_tool_call_count,
            EXISTS(SELECT 1 FROM inference_attempts ia
              WHERE ia.harness_run_id = hr.id AND ia.fallback_attempt > 0) AS fallback_used
       FROM harness_runs hr
      WHERE hr.id = ? AND hr.workspace_id = ? AND hr.workstream_id = ?
        AND hr.parent_tool_call_id IS NULL`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<RunRow>();
  if (!run || !run.completed_at || !['completed', 'needs_input', 'failed', 'stopped'].includes(run.status)) return;
  // The work stream's automation run was a second table in the join, and the
  // only column this needed from it. It is the identity authority's row, asked
  // for after the terminal gate rather than fetched for every run.
  run.automation_run_id = (await createIdentityObjectPort(env, input.workspaceId, input.workstreamId)
    .identity())?.automation_run_id ?? null;
  // The automation lookup is workspace authority (the WorkspaceDO — the D1
  // copy was scrubbed at cutover); the run rows above are work-stream
  // authority, and no database holds both sides of the old JOIN. Both callers
  // swallow telemetry errors, so the joined form did not fail — it silently
  // killed run_terminal telemetry in production.
  const automation = run.automation_run_id && ["automation", "automation_run"].includes(run.origin)
    ? await withWorkspaceRuntimeDatabase(env, input.workspaceId).DB.prepare(
      `SELECT automation_subscription_id, trigger_type FROM automation_runs
        WHERE id = ? AND workspace_id = ?`,
    ).bind(run.automation_run_id, input.workspaceId)
      .first<{ automation_subscription_id: string | null; trigger_type: string | null }>()
    : null;
  run.automation_id = automation?.automation_subscription_id ?? null;
  run.automation_trigger_type = automation?.trigger_type ?? null;
  const started = Date.parse(run.started_at ?? run.created_at);
  const completed = Date.parse(run.completed_at);
  const operationId = input.telemetryOperationId ?? input.harnessRunId;
  const subjectUserId = userIdForRun(run, input.telemetrySubjectUserId);

  await emitProductUsageTelemetry(env, {
    workspaceId: input.workspaceId,
    ...(subjectUserId ? { userId: subjectUserId } : {}),
    name: 'run_terminal',
    properties: {
      workstreamId: input.workstreamId,
      harnessRunId: input.harnessRunId,
      ...(run.automation_id ? { automationId: run.automation_id } : {}),
      runKind: runKind(run),
      triggerType: triggerType(run),
      terminalState: run.status as 'completed' | 'needs_input' | 'failed' | 'stopped',
      duration: telemetryJourneyDuration(Math.max(0, completed - started)),
      timeToFirstOutput: timeToFirstOutput(run, started),
      turnCount: telemetryCountBucket(usageTurnCount(run)),
      toolCallCount: telemetryCountBucket(run.tool_call_count),
      writeToolCallCount: telemetryCountBucket(run.write_tool_call_count),
      ...(run.model && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(run.model)
        ? { modelRoute: run.model }
        : {}),
      fallbackUsed: Boolean(run.fallback_used),
    },
    operationId,
    eventId: resourceTelemetryEventId(input.harnessRunId, 2),
  });

  // Keep the established coarse outcome for existing dashboards while the
  // richer terminal event becomes the canonical lifecycle measurement.
  if (!input.telemetryOperationId || !subjectUserId) return;
  const auth: IdentityAuthContext = {
    sessionId: `telemetry:${input.harnessRunId}`,
    userId: subjectUserId,
    workspaceId: input.workspaceId,
    region: env.AVALON_REGION,
    role: null,
  };
  const event = apiTelemetryEnvelope(
    env,
    'run_completed',
    {
      result: resultClass(run.status),
      duration: durationBucket(Math.max(0, completed - started)),
    },
    operationId,
    'workspace-user',
    env.AVALON_REGION,
    input.harnessRunId,
  );
  await emitAuthenticatedApiTelemetry(env, auth, event);
}
