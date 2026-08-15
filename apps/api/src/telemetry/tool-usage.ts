import type { ExecutionPrincipal } from '@avalon/contracts';
import type { Env, IdentityAuthContext } from '../env';
import {
  apiTelemetryEnvelope,
  emitAuthenticatedApiTelemetry,
  emitWorkspaceApiTelemetry,
} from './api-emitter';
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryJourneyDuration,
} from './product-usage';

export interface AgentToolStartedTelemetryInput {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  invocationId: string;
  automationId?: string;
  executionPrincipal: ExecutionPrincipal;
  toolName: string;
  pluginId: string;
  capability: string;
  mode: 'read' | 'write';
  runKind: 'workstream' | 'automation' | 'hypersight' | 'subagent' | 'system';
}

/**
 * Emits only the canonical, allowlisted identity of an admitted tool call.
 * Tool arguments, results, summaries, and provider payloads never cross this
 * boundary.
 */
export async function emitAgentToolStartedTelemetry(
  env: Env,
  input: AgentToolStartedTelemetryInput,
): Promise<void> {
  const userOwned = input.executionPrincipal.type === 'user';
  const event = apiTelemetryEnvelope(
    env,
    'agent_tool_started',
    {
      workstreamId: input.workstreamId,
      harnessRunId: input.harnessRunId,
      ...(input.automationId ? { automationId: input.automationId } : {}),
      toolName: input.toolName,
      pluginId: input.pluginId,
      capability: input.capability,
      mode: input.mode,
      runKind: input.runKind,
      executionScope: userOwned ? 'user' : 'workspace',
    },
    input.harnessRunId,
    userOwned ? 'workspace-user' : 'workspace',
    env.AVALON_REGION,
    input.invocationId,
  );

  if (input.executionPrincipal.type === 'workspace') {
    await emitWorkspaceApiTelemetry(env, input.workspaceId, event);
    return;
  }

  const auth: IdentityAuthContext = {
    sessionId: `telemetry:${input.harnessRunId}`,
    userId: input.executionPrincipal.userId,
    workspaceId: input.workspaceId,
    region: env.AVALON_REGION,
    role: null,
  };
  await emitAuthenticatedApiTelemetry(env, auth, event);
}

interface ToolTerminalRow {
  id: string;
  workspace_id: string;
  workstream_id: string;
  harness_run_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error_json: string | null;
  execution_plan_json: string | null;
  origin: string;
  parent_tool_call_id: string | null;
  execution_principal_json: string;
  automation_id: string | null;
}

function objectJson(value: string | null): Record<string, unknown> {
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

function terminalResult(row: ToolTerminalRow):
  'success' | 'validation_error' | 'authorization_denied' | 'provider_error' | 'ambiguous' | 'cancelled' {
  if (row.status === 'completed') return 'success';
  if (row.status === 'ambiguous') return 'ambiguous';
  const error = objectJson(row.error_json);
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (code.includes('cancel') || code.includes('abort') || code.includes('stopped')) return 'cancelled';
  if (code.includes('unauthor') || code.includes('forbidden') || code.includes('denied')) return 'authorization_denied';
  if (code.includes('valid') || code.includes('input') || code.includes('schema')) return 'validation_error';
  return 'provider_error';
}

function terminalRunKind(row: ToolTerminalRow): AgentToolStartedTelemetryInput['runKind'] {
  if (row.parent_tool_call_id) return 'subagent';
  if (row.origin === 'hypersight_block') return 'hypersight';
  if (row.automation_id) return 'automation';
  if (row.origin === 'scheduled_digest') return 'system';
  return 'workstream';
}

/**
 * Emits the authoritative terminal counterpart from the durable invocation
 * receipt. Content-bearing inputs, summaries, errors, and outputs are never
 * copied into telemetry.
 */
export async function emitAgentToolTerminalTelemetry(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    harnessRunId: string;
    invocationId: string;
    replayed?: boolean;
  },
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT ti.id, ti.workspace_id, ti.workstream_id, ti.harness_run_id,
            ti.status, ti.started_at, ti.completed_at, ti.error_json,
            ti.execution_plan_json, hr.origin, hr.parent_tool_call_id,
            hr.execution_principal_json,
            ar.automation_subscription_id AS automation_id
       FROM tool_invocations ti
       JOIN harness_runs hr ON hr.id = ti.harness_run_id
       JOIN workstreams w
         ON w.id = hr.workstream_id AND w.workspace_id = hr.workspace_id
       LEFT JOIN automation_runs ar
         ON ar.id = w.automation_run_id
        AND ar.workspace_id = hr.workspace_id
        AND hr.origin IN ('automation', 'automation_run')
      WHERE ti.id = ? AND ti.workspace_id = ? AND ti.workstream_id = ?
        AND ti.harness_run_id = ?`,
  ).bind(
    input.invocationId,
    input.workspaceId,
    input.workstreamId,
    input.harnessRunId,
  ).first<ToolTerminalRow>();
  if (!row || !['completed', 'failed', 'ambiguous'].includes(row.status)) return;

  const plan = objectJson(row.execution_plan_json);
  const toolName = typeof plan.canonicalToolName === 'string' ? plan.canonicalToolName : '';
  const pluginId = typeof plan.pluginId === 'string' ? plan.pluginId : '';
  const capability = typeof plan.capability === 'string' ? plan.capability : '';
  const mode = plan.mode === 'write' ? 'write' : plan.mode === 'read' ? 'read' : null;
  if (!toolName || !pluginId || !capability || !mode) return;

  const principal = objectJson(row.execution_principal_json);
  const userId = principal.type === 'user' && typeof principal.userId === 'string'
    ? principal.userId
    : undefined;
  const started = row.started_at ? Date.parse(row.started_at) : Number.NaN;
  const completed = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
  await emitProductUsageTelemetry(env, {
    workspaceId: input.workspaceId,
    ...(userId ? { userId } : {}),
    name: 'agent_tool_terminal',
    properties: {
      workstreamId: input.workstreamId,
      harnessRunId: input.harnessRunId,
      ...(row.automation_id ? { automationId: row.automation_id } : {}),
      toolName,
      pluginId,
      capability,
      mode,
      runKind: terminalRunKind(row),
      executionScope: userId ? 'user' : 'workspace',
      result: terminalResult(row),
      duration: Number.isFinite(started) && Number.isFinite(completed)
        ? telemetryJourneyDuration(Math.max(0, completed - started))
        : 'unknown',
      replayed: input.replayed ?? false,
    },
    operationId: input.harnessRunId,
    eventId: resourceTelemetryEventId(input.invocationId, 1),
  });
}
