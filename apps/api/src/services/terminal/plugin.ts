import type { HarnessPlugin } from "@avalon/agent-harness";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";

import type { Env } from "../../env";
import { logStructuredEvent } from "../../observability/logger";
import { recordTerminalPlatformObservation } from "../../observability/terminal-platform-observability";
import {
  createTerminalPlugin,
  parseTerminalRegionConfiguration,
  TERMINAL_PLUGIN_SYSTEM_MESSAGE,
  TERMINAL_TOOL_NAMES,
  type TerminalToolExecutors,
} from "./contract";
import { TerminalSandboxCoordinator } from "./coordinator";
import { createDaytonaTerminalProvider } from "./daytona-provider";
import {
  admitTerminalPublicationGrant,
  bootstrapTerminalRepository,
  createGitHubRestPublicationGateway,
  createGitHubRestReadGateway,
  createTerminalRepositoryPublisher as createRepositoryPublisher,
} from "./repository";
import { createTerminalResourceBridge } from "./resource-bridge";
import { createDaytonaTerminalRuntime } from "./runtime";
import { createTerminalRepositorySelector } from "./repository-selection";
import { createGitHubTerminalCatalogGateway } from "./workstream-state";
import { createTerminalToolExecutors, TerminalToolError } from "./tools";
import { refreshWorkspaceSchedulerAlarm } from "../workstream-wakeup-service";

export async function createAvalonTerminalPlugin(
  env: Env,
  input: WorkstreamWorkflowInput,
): Promise<HarnessPlugin | null> {
  const configuration = parseTerminalRegionConfiguration(env);
  if (configuration.capability === "unsupported") return null;

  await admitTerminalPublicationGrant(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: input.harnessRunId,
    triggerMessageId: input.triggerMessageId,
    executionPrincipal: input.executionPrincipal,
  });

  const provider = createDaytonaTerminalProvider(configuration, undefined, {
    observe: (measurement) => recordTerminalPlatformObservation(env, measurement),
  });
  const coordinator = new TerminalSandboxCoordinator(
    env.DB,
    provider,
    undefined,
    (workspaceId) => refreshWorkspaceSchedulerAlarm(env, workspaceId),
    configuration.emergencyDisabled,
  );
  const readGateway = createGitHubRestReadGateway(env);
  const runtime = createDaytonaTerminalRuntime(
    env.DB,
    coordinator,
    provider,
    createTerminalResourceBridge(env),
    createRepositoryPublisher(env, createGitHubRestPublicationGateway(env)),
    createTerminalRepositorySelector(env, provider, createGitHubTerminalCatalogGateway(env)),
    async (context, sandbox, sandboxProvider) => {
      try {
        await bootstrapTerminalRepository(env, context, sandbox, sandboxProvider, readGateway);
      } catch (error) {
        if (error instanceof TerminalToolError && error.code === "repository_not_configured") return;
        throw error;
      }
    },
  );
  const executors = createTerminalToolExecutors(runtime);
  const observedExecutors = Object.fromEntries(TERMINAL_TOOL_NAMES.map((name) => [
    name,
    async (toolInput: unknown, context: Parameters<TerminalToolExecutors[typeof name]>[1]) => {
      const startedAt = Date.now();
      try {
        const result = await executors[name](toolInput, context);
        logStructuredEvent(env, "info", "terminal_tool_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          tool_invocation_id: context.toolCallId,
          tool_name: name,
          state: "completed",
          duration_ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        logStructuredEvent(env, "warn", "terminal_tool_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          tool_invocation_id: context.toolCallId,
          tool_name: name,
          state: "failed",
          code: error instanceof TerminalToolError ? error.code : "terminal_tool_failed",
          duration_ms: Date.now() - startedAt,
        });
        throw error;
      }
    },
  ])) as TerminalToolExecutors;
  const policy = await env.DB.prepare(
    "SELECT mode FROM workspace_sandbox_network_policies WHERE workspace_id = ?",
  ).bind(input.workspaceId).first<{ mode: "trusted_only" | "full_internet" }>();
  const egressGuidance = policy?.mode === "full_internet"
    ? " Current workspace egress is Full internet."
    : " Current workspace egress is Trusted only; a network failure may mean the destination is not approved, so ask a workspace owner to review Terminal network targets instead of trying to bypass it.";
  return createTerminalPlugin(observedExecutors, `${TERMINAL_PLUGIN_SYSTEM_MESSAGE}${egressGuidance}`);
}
