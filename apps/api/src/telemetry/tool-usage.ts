import { asUserId, type ExecutionPrincipal, type WorkspaceId } from '@rally/contracts';
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
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";

export interface AgentToolStartedTelemetryInput {
  workspaceId: WorkspaceId;
  workstreamId: string;
  harnessRunId: string;
  invocationId: string;
  automationId?: string;
  executionPrincipal: ExecutionPrincipal;
  toolName: string;
  pluginId: string;
  capability: string;
  mode: 'read' | 'write';
  runKind: 'workstream' | 'automation' | 'subagent' | 'system';
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
  harness_run_id: string;
  /** The object's own spelling: `admitted`/`executing`, never `pending`/`started`. */
  status: string;
  /** Unix milliseconds, which is what the object stores; the view reformatted. */
  started_at: number | null;
  settled_at: number | null;
  error_json: string | null;
  execution_plan_json: string | null;
  origin: string;
  parent_tool_call_id: string | null;
  execution_principal_json: string;
  automation_id: string | null;
  automation_run_id: string | null;
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
    workspaceId: WorkspaceId;
    workstreamId: string;
    harnessRunId: string;
    invocationId: string;
    replayed?: boolean;
  },
): Promise<void> {
  const stored = await createHarnessRunObjectPort(env, input.workspaceId, input.workstreamId)
    .toolTerminalTelemetry({
      runId: input.harnessRunId,
      effectIntentId: input.invocationId,
    });
  if (!stored || !['completed', 'failed', 'ambiguous'].includes(stored.status)) return;
  const row: ToolTerminalRow = {
    id: stored.effect_intent_id,
    harness_run_id: stored.run_id,
    status: stored.status,
    started_at: stored.started_at,
    settled_at: stored.settled_at,
    error_json: stored.error_json,
    execution_plan_json: stored.execution_plan_json,
    origin: stored.origin,
    parent_tool_call_id: stored.parent_tool_call_id,
    execution_principal_json: stored.execution_principal_json,
    automation_id: null,
    automation_run_id: null,
  };
  // The work stream's automation run was a third table in the join, and the
  // only column this needed from it. It is the identity authority's row, asked
  // for after the status gate rather than fetched for every receipt.
  const workstreamIdentity = await createIdentityObjectPort(
    env,
    input.workspaceId,
    input.workstreamId,
  ).identity();
  row.automation_run_id = workstreamIdentity?.automation_run_id ?? null;
  // The generated work stream owns its immutable back-link. Reading both IDs
  // from that authority avoids reconstructing a cross-object JOIN in telemetry.
  row.automation_id = workstreamIdentity?.automation_subscription_id ?? null;

  const plan = objectJson(row.execution_plan_json);
  const toolName = typeof plan.canonicalToolName === 'string' ? plan.canonicalToolName : '';
  const pluginId = typeof plan.pluginId === 'string' ? plan.pluginId : '';
  const capability = typeof plan.capability === 'string' ? plan.capability : '';
  const mode = plan.mode === 'write' ? 'write' : plan.mode === 'read' ? 'read' : null;
  if (!toolName || !pluginId || !capability || !mode) return;

  const principal = objectJson(row.execution_principal_json);
  const userId = principal.type === 'user' && typeof principal.userId === 'string'
    ? asUserId(principal.userId)
    : undefined;
  // Already numbers. The view answered ISO-8601 and this re-parsed it.
  const started = row.started_at ?? Number.NaN;
  const completed = row.settled_at ?? Number.NaN;
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
