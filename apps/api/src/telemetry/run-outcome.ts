import { asUserId, type AutomationRunReferenceV1, type UserId, type WorkspaceId } from '@rally/contracts';
import type { Env, IdentityAuthContext } from '../env';
import { runtimeDeferral, type WorkDeferral } from '../lib/defer';
import { diagnosticErrorCode, logStructuredEvent } from '../observability/logger';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from './api-emitter';
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryCountBucket,
  telemetryJourneyDuration,
  type TelemetryJourneyDuration,
} from './product-usage';
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";

interface CorrelatedRunInput {
  workspaceId: WorkspaceId;
  /** The conversation parent's id, of either kind. */
  parentId: string;
  harnessRunId: string;
  /** Set on an automation run's child loop; the run's provenance rides on the input. */
  automationRun?: AutomationRunReferenceV1 | undefined;
  telemetryOperationId?: string | undefined;
  telemetrySubjectUserId?: string | undefined;
}

interface RunRow {
  status: string;
  started_at: number;
  completed_at: number | null;
  created_at: number;
  origin: string;
  execution_principal_json: string;
  model: string | null;
  usage_json: string | null;
  automation_id: string | null;
  automation_run_id: string | null;
  automation_trigger_type: string | null;
  first_inference_started_at: number | null;
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

function runKind(row: RunRow): 'workstream' | 'automation' | 'system' {
  if (row.automation_id) return 'automation';
  if (row.origin === 'scheduled_digest') return 'system';
  return 'workstream';
}

function triggerType(row: RunRow): 'composer' | 'retry' | 'manual' | 'scheduled' | 'activity' | 'inbound_email' | 'digest' | 'system' {
  if (row.origin === 'human_message') return 'composer';
  if (row.origin === 'manual_retry') return 'retry';
  if (row.origin === 'scheduled_digest') return 'digest';
  // The run reference's own trigger vocabulary, translated into the one the
  // dashboards already read. They are not the same words: a reference says
  // `external_event` and `schedule` where this event has always said
  // `activity` and `scheduled`, and reading the reference's words as if they
  // were these reported every scheduled and every event-triggered run as
  // `manual`, through the fallthrough below.
  if (row.automation_trigger_type === 'external_event') return 'activity';
  if (row.automation_trigger_type === 'inbound_email') return 'inbound_email';
  if (row.automation_trigger_type === 'schedule') return 'scheduled';
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
    Math.max(0, row.first_inference_started_at - startedMs) + row.first_ttft_ms,
  );
}

/** Durable, idempotent authoritative counterpart to a renderer run intent. */
async function acceptCorrelatedRunOutcome(
  env: Env,
  input: CorrelatedRunInput,
  defer: WorkDeferral,
): Promise<void> {
  const stored = await createHarnessRunObjectPort(env, input.workspaceId, input.parentId)
    .runOutcomeTelemetry({ runId: input.harnessRunId });
  if (!stored || stored.completed_at === null
    || !['completed', 'needs_input', 'failed', 'stopped'].includes(stored.status)) return;
  // An automation run's provenance is on the loop input that started it, so no
  // object is asked a second question after the terminal gate.
  const run: RunRow = {
    ...stored,
    automation_id: input.automationRun?.automationId ?? null,
    automation_run_id: input.automationRun?.runId ?? null,
    automation_trigger_type: input.automationRun?.trigger.kind ?? null,
  };
  const started = run.started_at;
  const completed = stored.completed_at;
  const operationId = input.telemetryOperationId ?? input.harnessRunId;
  const subjectUserId = userIdForRun(run, input.telemetrySubjectUserId);

  emitProductUsageTelemetry(env, {
    workspaceId: input.workspaceId,
    ...(subjectUserId ? { userId: subjectUserId } : {}),
    name: 'run_terminal',
    properties: {
      workstreamId: input.parentId,
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
  }, defer);

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

export function emitCorrelatedRunOutcome(
  env: Env,
  input: CorrelatedRunInput,
  defer: WorkDeferral = runtimeDeferral,
): void {
  defer(acceptCorrelatedRunOutcome(env, input, defer).catch((error: unknown) => {
    logStructuredEvent(env, 'warn', 'run_outcome_telemetry_failed', {
      workspace_id: input.workspaceId,
      parent_id: input.parentId,
      harness_run_id: input.harnessRunId,
      error_code: diagnosticErrorCode(error, 'run_outcome_telemetry_failed'),
    });
  }));
}
