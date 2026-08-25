import { asUserId, type ExecutionPrincipal, type WorkspaceId } from '@avalon/contracts';
import type { Env, IdentityAuthContext } from '../env';
import { withWorkspaceRuntimeDatabase } from '../services/workspace-runtime-database';
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
    workspaceId: WorkspaceId;
    workstreamId: string;
    harnessRunId: string;
    invocationId: string;
    replayed?: boolean;
  },
): Promise<void> {
  // Pointed at the real `tool_effects` rather than the compatibility view, so
  // this statement stops being a reason that view has to exist. It is not
  // converted to the typed port: its primary table is `harness_runs` and its
  // shape is run-and-workstream, not receipt — a `terminalTelemetryRow` on the
  // receipt storage class would be the wrong owner. The harness-runs slice
  // converts the whole statement; this only stops it blocking the receipt one.
  //
  // The workspace and workstream predicates are gone with the view that
  // supplied those columns. They are not lost: every receipt in this object
  // belongs to this work stream, and the routed statement reaches the object
  // only after its identity has been checked.
  const row = await env.DB.prepare(
    `SELECT ti.effect_intent_id AS id, ti.run_id AS harness_run_id,
            ti.status, ti.started_at, ti.settled_at, ti.error_json,
            ti.execution_plan_json, hr.origin, hr.parent_tool_call_id,
            hr.execution_principal_json
       FROM tool_effects ti
       JOIN harness_runs hr ON hr.id = ti.run_id
      WHERE ti.effect_intent_id = ? AND ti.run_id = ?`,
  ).bind(
    input.invocationId,
    input.harnessRunId,
  ).first<ToolTerminalRow>();
  if (!row || !['completed', 'failed', 'ambiguous'].includes(row.status)) return;
  // The work stream's automation run was a third table in the join, and the
  // only column this needed from it. It is the identity authority's row, asked
  // for after the status gate rather than fetched for every receipt.
  row.automation_run_id = (await createIdentityObjectPort(env, input.workspaceId, input.workstreamId)
    .identity())?.automation_run_id ?? null;
  // The automation lookup is workspace authority (the WorkspaceDO); the rows
  // above are work-stream authority, and no database holds both sides of the
  // old JOIN — which the swallowed telemetry errors hid.
  row.automation_id = row.automation_run_id && ["automation", "automation_run"].includes(row.origin)
    ? (await withWorkspaceRuntimeDatabase(env, input.workspaceId).DB.prepare(
      `SELECT automation_subscription_id FROM automation_runs WHERE id = ? AND workspace_id = ?`,
    ).bind(row.automation_run_id, input.workspaceId)
      .first<{ automation_subscription_id: string | null }>())?.automation_subscription_id ?? null
    : null;

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
