import {
  asAutomationId,
  asWorkspaceId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";

/**
 * The authority's own search bound, re-exported here because this module is the
 * seam the services reach automation memory through. A caller that has to fit
 * inside the bound should not have to import the AutomationAgent's memory
 * implementation — its DDL and SQL handlers — to learn the number.
 */
export { AUTOMATION_MEMORY_SEARCH_QUERY_MAX_CHARS } from "../durable-objects/automation-agent-memory";

import { automationAgentName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

export type AutomationMemoryToolOperation =
  | "search" | "add" | "update" | "invalidate"
  | "table_search" | "table_describe" | "table_query" | "table_create"
  | "table_insert_rows" | "table_update_rows" | "table_invalidate_rows";

function coordinates(input: WorkstreamWorkflowInput) {
  const context = input.automationRunContext;
  if (!context) throw new Error("automation_memory_context_missing");
  if (context.automationId !== input.automationSubscriptionId) {
    throw new Error("automation_memory_context_mismatch");
  }
  return {
    schemaVersion: 1 as const,
    automationId: context.automationId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    harnessRunId: input.harnessRunId,
    authorityGeneration: context.memoryScope.authorityGeneration,
  };
}

async function agent(env: Env, input: WorkstreamWorkflowInput) {
  const context = input.automationRunContext;
  if (!context) throw new Error("automation_memory_context_missing");
  return durableObjectStubForWorkspace(
    env,
    env.AUTOMATION_AGENTS,
    asWorkspaceId(context.workspaceId),
    automationAgentName(
      env.AVALON_REGION,
      asWorkspaceId(context.workspaceId),
      asAutomationId(context.automationId),
    ),
  );
}

export async function executeAutomationMemoryToolForRun(
  env: Env,
  input: WorkstreamWorkflowInput,
  operation: AutomationMemoryToolOperation,
  args: unknown,
  providerIdempotencyKey?: string,
): Promise<{ output: unknown; summary: string; providerOperationId?: string }> {
  return (await agent(env, input)).executeMemoryTool({
    ...coordinates(input),
    operation,
    args,
    ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
  });
}

export async function readAutomationMemoryBootstrapForRun(
  env: Env,
  input: WorkstreamWorkflowInput,
) {
  return (await agent(env, input)).readMemoryBootstrap(coordinates(input));
}
