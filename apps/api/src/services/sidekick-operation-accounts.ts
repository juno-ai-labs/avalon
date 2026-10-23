import { z } from "zod";
import {
  IdSchema, SidekickExecutionDelegationSchema, AutomationRunDefinitionV1Schema, asUserId, type SidekickExecutionDelegation, type AutomationRunDefinitionV1,
  type ToolDefinition, type ToolExecutionAccount, type WorkstreamWorkflowInput, type SidekickAccountReference,
} from "@rally/contracts";
import { ConnectorError, isConnectorResourceAccessRefusal, type ConnectorOperationIdentity, type ConnectorToolResult } from "@rally/connectors";
import type { HarnessToolContext } from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { ToolReceiptFence } from "../durable-objects/workstream-tool-receipt-storage";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";

const AccountSelectionSchema = z.strictObject({ userId: IdSchema.nullish(), connectionId: IdSchema.nullish() })
  .refine((value) => Boolean(value.userId || value.connectionId), { message: "Specify userId or connectionId for the required account" });
export interface SidekickAccountSelection { userId?: string; connectionId?: string }
const ACCOUNT_SELECTION_JSON = { ...z.toJSONSchema(AccountSelectionSchema), anyOf: [
  { type: "object", required: ["userId"], properties: { userId: z.toJSONSchema(IdSchema) } },
  { type: "object", required: ["connectionId"], properties: { connectionId: z.toJSONSchema(IdSchema) } },
] };

export function splitSidekickAccount(input: unknown): { input: unknown; selection?: SidekickAccountSelection } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input };
  const { rallyAccount, ...providerInput } = input as Record<string, unknown>;
  if (rallyAccount == null) return { input: providerInput };
  const selected = z.object({ rallyAccount: AccountSelectionSchema }).parse({ rallyAccount }).rallyAccount;
  return { input: providerInput, selection: {
    ...(selected.userId ? { userId: selected.userId } : {}),
    ...(selected.connectionId ? { connectionId: selected.connectionId } : {}),
  } };
}

/** Host-owned selector; the provider receives only its original arguments. */
export function sidekickAccountToolDefinition(definition: ToolDefinition): ToolDefinition {
  const properties = definition.inputSchema.properties as Record<string, unknown> | undefined;
  if (properties?.rallyAccount) throw new Error("sidekick_operation_account_argument_conflict");
  return { ...definition, inputSchema: { ...definition.inputSchema, properties: { ...properties,
    rallyAccount: { anyOf: [ACCOUNT_SELECTION_JSON, { type: "null" }],
      description: "Optional required serving account. Use a named delegate's userId or the exact connectionId from this plugin's account guidance. It restricts execution; it never grants access. Preserve it for replies and account-relative work. Omit for the Sidekick's configured task account or normal known-resource fallback.",
    },
  } } };
}

export async function readSidekickOperationDelegation(env: Env, input: WorkstreamWorkflowInput): Promise<SidekickExecutionDelegation | null> {
  if (input.parentKind !== "automation") return null;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId));
  return SidekickExecutionDelegationSchema.parse(await workspace.sidekickReadExecutionDelegation({
    workspaceId: input.workspaceId, automationId: input.parentId,
  }));
}

/** A background child inherits origin references, not its root's instructions or tools. */
export async function readSidekickOperationSource(env: Env, input: WorkstreamWorkflowInput): Promise<NonNullable<AutomationRunDefinitionV1["opening"]>["sourceAccount"]> {
  if (input.parentKind !== "automation" || !input.automationDelegation || input.automationRun) return undefined;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId));
  const definition = AutomationRunDefinitionV1Schema.parse(await workspace.sidekickReadRunDefinition({
    workspaceId: input.workspaceId, automationId: input.parentId, runId: input.automationDelegation.runId,
  }));
  return definition.opening?.sourceAccount;
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

/** No provider preflight. Receipt selection precedes dispatch, even on safe reads. */
export async function executeSidekickAccountOperation<C extends SidekickAccountConnection>(options: {
  authority: SidekickExecutionDelegation;
  workspaceId: WorkstreamWorkflowInput["workspaceId"];
  coordinatorUserId: string | null;
  requested: C; candidates: readonly C[]; sourceConnectionIds: readonly string[];
  sourceAccount?: NonNullable<AutomationRunDefinitionV1["opening"]>["sourceAccount"];
  identity: ConnectorOperationIdentity;
  accountReferences?: readonly SidekickAccountReference[];
  /** An occurrence's later executions reuse completed references in its conversation. */
  includeConversationAccounts?: boolean;
  selection?: SidekickAccountSelection;
  mode: "read" | "write";
  canFallback: boolean;
  context: HarnessToolContext;
  receipts: ToolReceiptObjectPort;
  fence: ToolReceiptFence;
  execute: (connection: C) => Promise<ConnectorToolResult>;
  resultKeys?: (result: ConnectorToolResult) => string[];
}): Promise<ConnectorToolResult & { executionAccount: ToolExecutionAccount }> {
  const { authority, context, identity, selection, receipts } = options;
  if (!context.effectIntentId) throw unavailable("This Sidekick operation has no durable receipt. Resume the run before using a delegated account.");
  const effectIntentId = context.effectIntentId;
  const address = { runId: context.harnessRunId, effectIntentId };
  const [prior, receiptsForResource] = await Promise.all([
    receipts.executionAccount(address),
    identity.resourceKeys.length > 0
      ? receipts.resourceExecutionAccounts({ runId: options.includeConversationAccounts ? null : context.harnessRunId, resourceKeys: identity.resourceKeys })
      : Promise.resolve([]),
  ]);
  const grants = new Map(authority.delegates.map((grant) => [grant.userId, grant]));
  const sourceOrder = new Map(options.sourceConnectionIds.map((id, index) => [id, index]));
  const grantOrder = new Map(authority.delegates.map((grant, index) => [grant.userId, index]));
  const seen = new Set<string>();
  const connections = [options.requested, ...options.candidates].filter((connection) => {
    if (seen.has(connection.connectionId)) return false;
    seen.add(connection.connectionId);
    return true;
  });
  const bindings = [
    ...receiptsForResource.map((binding) => binding.account),
    ...(options.accountReferences ?? []).filter((reference) => reference.sidekickId === authority.sidekickId
      && reference.resourceKeys.some((key) => identity.resourceKeys.includes(key)))
      .map((reference) => ({ connectionId: reference.connectionId,
        delegatedUserId: connections.find((connection) => connection.connectionId === reference.connectionId)?.ownerUserId })),
  ];
  // A provider-created ID, a planned write, or a previously dispatched effect
  // cannot move to a different account. A definite refusal opens only that one
  // effect's selection; unrelated identities remain bound.
  const bindingConnections = [...new Set(bindings.map((binding) => binding.connectionId))];
  const continuation = context.executionAccount;
  const source = options.sourceAccount?.resourceKeys.some((key) => identity.resourceKeys.includes(key)) ? options.sourceAccount : undefined;
  const relevantBindings = selection || continuation ? bindings.filter((binding) =>
    (!selection?.connectionId || binding.connectionId === selection.connectionId)
    && (!selection?.userId || binding.delegatedUserId === selection.userId)
    && (!continuation || binding.connectionId === continuation.connectionId)) : bindings;
  if (identity.kind === "account" && bindingConnections.length > 1 && !selection && !continuation) {
    throw unavailable("This provider reference was used through more than one account. Specify rallyAccount for its originating account; do not retry it as another person.");
  }
  const bound = relevantBindings[0];
  if (continuation && continuation.sidekickId !== authority.sidekickId) throw unavailable("This continuation belongs to another Sidekick.");
  if (selection && bindings.length > 0 && relevantBindings.length === 0
    && (identity.kind === "account" || options.mode === "write")) {
    throw unavailable("This operation depends on another account's result. Use its originating account, or read the resource through the required account before planning a new write.");
  }
  const origin = bound?.connectionId ?? source?.connectionId;
  const pin = prior && prior.phase !== "refused" ? prior.account.connectionId : continuation?.connectionId
    ? continuation.connectionId
    : origin && (identity.kind === "account" || options.mode === "write") ? origin : null;
  const requiredUser = selection?.userId ?? (identity.kind === "account" && !origin && !selection?.connectionId && !continuation ? authority.accountUserId : null);
  if (requiredUser && !grants.has(asUserId(requiredUser))) {
    throw unavailable("The required account is not an eligible Sidekick delegate. Restore that person's delegation and access; this operation will not use another person's account.");
  }
  const eligible = connections.filter((connection) => {
    if (pin && connection.connectionId !== pin) return false;
    if (selection?.connectionId && connection.connectionId !== selection.connectionId) return false;
    if (connection.scope === "personal") {
      return connection.ownerUserId !== null && grants.has(asUserId(connection.ownerUserId))
        && (!requiredUser || connection.ownerUserId === requiredUser);
    }
    // A named person is not a workspace bot. Selecting an Organization
    // connection explicitly retains its workspace principal.
    return grants.size > 0 && !requiredUser;
  });
  const preferredAccountConnection = requiredUser && options.requested.ownerUserId === requiredUser
    ? options.requested.connectionId : null;
  const rank = (connection: C): number[] => [
    connection.connectionId === preferredAccountConnection ? 0 : 1,
    connection.connectionId === bound?.connectionId ? 0 : 1,
    connection.connectionId === source?.connectionId ? 0 : 1,
    sourceOrder.get(connection.connectionId) ?? Number.POSITIVE_INFINITY,
    connection.ownerUserId === authority.creatorUserId ? 0 : 1,
    connection.ownerUserId ? grantOrder.get(asUserId(connection.ownerUserId)) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY,
  ];
  eligible.sort((left, right) => {
    const a = rank(left), b = rank(right);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    return connections.indexOf(left) - connections.indexOf(right);
  });
  // Account-relative work is a single selected connection, including empty
  // searches and senders. A resource may try the remaining eligible accounts.
  const ordered = identity.kind === "account" ? eligible.slice(0, 1) : eligible;
  if (ordered.length === 0) throw unavailable("The required or originating Sidekick account is unavailable. Restore its delegation, connection and access; no account switch was performed.");
  let refusal: ConnectorError | undefined;
  for (const connection of ordered) {
    context.signal.throwIfAborted();
    const delegate = connection.scope === "personal" ? connection.ownerUserId
      : selection?.userId ?? (options.coordinatorUserId && grants.has(asUserId(options.coordinatorUserId))
        ? options.coordinatorUserId : authority.delegates[0]!.userId);
    const grant = grants.get(asUserId(delegate!))!;
    const account: ToolExecutionAccount = {
      sidekickId: authority.sidekickId, connectionId: connection.connectionId,
      delegatedUserId: grant.userId, grantGeneration: grant.generation,
      principal: connection.scope === "workspace" ? { type: "workspace", workspaceId: options.workspaceId }
        : { type: "user", userId: grant.userId },
    };
    await receipts.recordExecutionAccount({ effectIntentId, fence: options.fence, now: Date.now(),
      phase: "selected", account, resourceKeys: identity.resourceKeys });
    let result: ConnectorToolResult;
    try {
      result = await options.execute(connection);
    } catch (error) {
      if (!options.canFallback || pin || selection?.connectionId || identity.kind !== "resource" || !isConnectorResourceAccessRefusal(error)) throw error;
      await receipts.recordExecutionAccount({ effectIntentId, fence: options.fence, now: Date.now(),
        phase: "refused", account, resourceKeys: identity.resourceKeys });
      const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
      const priorDetails = refusal?.details as Record<string, unknown> | undefined;
      if (!refusal || (!priorDetails?.resourceAuthorization && details.resourceAuthorization)) {
        refusal = new ConnectorError(error.code, error.message, { ...details, resourceAuthorizationConnectionId: connection.connectionId });
      }
      continue;
    }
    await receipts.recordExecutionAccount({ effectIntentId, fence: options.fence, now: Date.now(),
      phase: "served", account, resourceKeys: options.resultKeys?.(result) ?? identity.resourceKeys });
    const output = result.output;
    const data = output && typeof output === "object" && !Array.isArray(output) ? output : { result: output };
    return { ...result, executionAccount: account,
      output: { ...data, servedThrough: {
        plugin: connection.modelPluginId, scope: connection.scope, userId: account.principal.type === "user" ? account.principal.userId : null,
        connectionId: connection.connectionId,
        ...(connection.connectionId === options.requested.connectionId ? {} : { requestedPlugin: options.requested.modelPluginId }),
      } },
      summary: `${result.summary} (through ${connection.modelPluginId})`,
    };
  }
  throw refusal ?? unavailable("No eligible delegated account could access this resource. Restore source access or opt in with an account that can open it.");
}
