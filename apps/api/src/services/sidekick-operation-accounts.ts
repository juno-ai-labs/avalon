import {
  SIDEKICK_REQUESTER_ACCOUNT_UNAVAILABLE, SidekickExecutionDelegationSchema, asUserId, type SidekickExecutionDelegation,
  type ToolExecutionAccount, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { ConnectorError, isConnectorResourceAccessRefusal, type ConnectorToolResult } from "@rally/connectors";
import type { HarnessToolContext } from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { ToolReceiptFence } from "../durable-objects/workstream-tool-receipt-storage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";

export async function readSidekickOperationDelegation(env: Env, input: WorkstreamWorkflowInput): Promise<SidekickExecutionDelegation | null> {
  if (input.parentKind !== "automation" || (!input.automationRun && !input.automationDelegation)) return null;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId));
  // The run's own view: a run a non-delegate asked for answers with only them.
  const runId = input.automationRun?.runId ?? input.automationDelegation?.runId;
  return SidekickExecutionDelegationSchema.parse(await workspace.sidekickReadExecutionDelegation({
    workspaceId: input.workspaceId, automationId: input.parentId, ...(runId ? { runId } : {}),
  }));
}

export interface SidekickAccountConnection {
  connectionId: string;
  scope: "personal" | "workspace";
  ownerUserId: string | null;
  modelPluginId: string;
}

function unavailable(message: string): ConnectorError {
  return new ConnectorError("unauthorized", message);
}

/** Try eligible accounts after definite access refusals; checkpoint writes for recovery. */
export async function executeSidekickAccountOperation<C extends SidekickAccountConnection>(options: {
  authority: SidekickExecutionDelegation;
  workspaceId: WorkstreamWorkflowInput["workspaceId"];
  coordinatorUserId: string | null;
  requested: C; candidates: readonly C[]; sourceConnectionIds: readonly string[];
  canFallback: boolean;
  mode: "read" | "write";
  context: HarnessToolContext;
  receipts: ToolReceiptObjectPort;
  fence: ToolReceiptFence;
  execute: (connection: C) => Promise<ConnectorToolResult>;
}): Promise<ConnectorToolResult> {
  const { authority, context, receipts } = options;
  if (options.mode === "write" && !context.effectIntentId) throw unavailable("This Sidekick operation has no durable receipt. Resume the run before using a delegated account.");
  const effectIntentId = context.effectIntentId;
  const prior = options.mode === "write"
    ? await receipts.executionAccount({ runId: context.harnessRunId, effectIntentId: effectIntentId! }) : null;
  const grants = new Map(authority.delegates.map((grant) => [grant.userId, grant]));
  const sourceOrder = new Map(options.sourceConnectionIds.map((id, index) => [id, index]));
  const grantOrder = new Map(authority.delegates.map((grant, index) => [grant.userId, index]));
  // Only recovery of this exact effect retains its account: its provider write
  // may already have landed. Separate reads, replies and pages have no binding.
  const pinned = prior && prior.phase !== "refused" ? prior.account : null;
  if (pinned && !grants.has(pinned.delegatedUserId)) {
    throw unavailable("The originating delegate is unavailable. Restore their delegation before reconciling this operation's uncertain outcome.");
  }
  const seen = new Set<string>();
  const eligible = [options.requested, ...options.candidates].filter((connection) => {
    if (seen.has(connection.connectionId)) return false;
    seen.add(connection.connectionId);
    if (pinned && connection.connectionId !== pinned.connectionId) return false;
    return connection.scope === "personal"
      ? connection.ownerUserId !== null && grants.has(asUserId(connection.ownerUserId))
      : grants.size > 0;
  });
  const rank = (connection: C): number[] => [
    connection.connectionId === options.requested.connectionId ? 0 : 1,
    sourceOrder.get(connection.connectionId) ?? Number.POSITIVE_INFINITY,
    connection.ownerUserId === authority.creatorUserId ? 0 : 1,
    connection.ownerUserId ? grantOrder.get(asUserId(connection.ownerUserId)) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY,
  ];
  eligible.sort((left, right) => {
    const a = rank(left), b = rank(right);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    return 0;
  });
  if (eligible.length === 0 && authority.requesterUserId) {
    // A run a non-delegate asked for has only their own accounts; this one
    // needs a delegate's. Named, so the run's reply can say why.
    throw new ConnectorError("unauthorized",
      `${SIDEKICK_REQUESTER_ACCOUNT_UNAVAILABLE}: this needs an account that only someone this Sidekick acts for can use. Ask one of them to request it.`,
      { code: SIDEKICK_REQUESTER_ACCOUNT_UNAVAILABLE });
  }
  if (eligible.length === 0) throw unavailable("No eligible delegated account is available. Restore delegation, connection and access.");
  let refusal: ConnectorError | undefined;
  for (const connection of eligible) {
    context.signal.throwIfAborted();
    const delegate = connection.scope === "personal" ? connection.ownerUserId
      : pinned?.delegatedUserId ?? (options.coordinatorUserId && grants.has(asUserId(options.coordinatorUserId))
        ? options.coordinatorUserId : authority.delegates[0]!.userId);
    const grant = grants.get(asUserId(delegate!))!;
    const account: ToolExecutionAccount = {
      sidekickId: authority.sidekickId, connectionId: connection.connectionId,
      delegatedUserId: grant.userId, grantGeneration: grant.generation,
      principal: connection.scope === "workspace" ? { type: "workspace", workspaceId: options.workspaceId }
        : { type: "user", userId: grant.userId },
    };
    const record = (phase: "selected" | "refused" | "served") => receipts.recordExecutionAccount({
      effectIntentId: effectIntentId!, fence: options.fence, now: Date.now(), phase, account,
    });
    if (options.mode === "write") await record("selected");
    let result: ConnectorToolResult;
    try {
      result = await options.execute(connection);
    } catch (error) {
      if (!options.canFallback || pinned || !isConnectorResourceAccessRefusal(error)) throw error;
      if (options.mode === "write") await record("refused");
      const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
      const priorDetails = refusal?.details as Record<string, unknown> | undefined;
      if (!refusal || (!priorDetails?.resourceAuthorization && details.resourceAuthorization)) {
        refusal = new ConnectorError(error.code, error.message, { ...details, resourceAuthorizationConnectionId: connection.connectionId });
      }
      continue;
    }
    if (options.mode === "write") await record("served");
    return result;
  }
  throw refusal ?? unavailable("No eligible delegated account could access this resource. Restore access or add a delegate who can open it.");
}
