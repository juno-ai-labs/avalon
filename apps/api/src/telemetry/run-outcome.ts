import type { Env, IdentityAuthContext } from '../env';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from './api-emitter';

interface CorrelatedRunInput {
  workspaceId: string;
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

/** Durable, idempotent authoritative counterpart to a renderer run intent. */
export async function emitCorrelatedRunOutcome(
  env: Env,
  input: CorrelatedRunInput,
): Promise<void> {
  if (!input.telemetryOperationId || !input.telemetrySubjectUserId) return;
  const run = await env.DB.prepare(
    `SELECT status, started_at, completed_at, created_at
     FROM harness_runs
     WHERE id = ? AND workspace_id = ? AND workstream_id = ?
       AND parent_tool_call_id IS NULL`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<RunRow>();
  if (!run || !run.completed_at || !['completed', 'needs_input', 'failed', 'stopped'].includes(run.status)) return;
  const started = Date.parse(run.started_at ?? run.created_at);
  const completed = Date.parse(run.completed_at);
  const auth: IdentityAuthContext = {
    sessionId: `telemetry:${input.harnessRunId}`,
    userId: input.telemetrySubjectUserId,
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
    input.telemetryOperationId,
    'workspace-user',
    env.AVALON_REGION,
    input.telemetryOperationId,
  );
  await emitAuthenticatedApiTelemetry(env, auth, event);
}
