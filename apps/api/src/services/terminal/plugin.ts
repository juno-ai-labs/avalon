import {
  HarnessPluginActivationError,
  type HarnessPlugin,
  type HarnessPluginActivationContext,
  type HarnessToolContext,
} from "@avalon/agent-harness";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { newId } from "@avalon/db";

import type { Env } from "../../env";
import { logStructuredEvent } from "../../observability/logger";
import { recordTerminalPlatformObservation } from "../../observability/terminal-platform-observability";
import {
  createTerminalPlugin,
  parseTerminalRegionConfiguration,
  TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
  TERMINAL_PLUGIN_SYSTEM_MESSAGE,
  TERMINAL_TOOL_NAMES,
  type TerminalToolExecutors,
} from "./contract";
import { TerminalSandboxCoordinator } from "./coordinator";
import {
  createDaytonaTerminalProvider,
  type TerminalSandboxProvider,
} from "./daytona-provider";
import {
  admitTerminalPublicationGrant,
  bootstrapTerminalRepository,
  createGitHubRestPublicationGateway,
  createGitHubRestReadGateway,
  createTerminalRepositoryPublisher as createRepositoryPublisher,
  type TerminalGitHubReadGateway,
} from "./repository";
import { createTerminalResourceBridge } from "./resource-bridge";
import { createDaytonaTerminalRuntime } from "./runtime";
import { createTerminalRepositorySelector } from "./repository-selection";
import { createGitHubTerminalCatalogGateway } from "./workstream-state";
import { createTerminalToolExecutors, TerminalToolError } from "./tools";
import { refreshWorkspaceSchedulerAlarm } from "../workstream-wakeup-service";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";

export async function createAvalonTerminalPlugin(
  env: Env,
  input: WorkstreamWorkflowInput,
  options: {
    provider?: TerminalSandboxProvider;
    readGateway?: TerminalGitHubReadGateway;
  } = {},
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

  const provider = options.provider ?? createDaytonaTerminalProvider(configuration, undefined, {
    observe: (measurement) => recordTerminalPlatformObservation(env, measurement),
  });
  const coordinator = new TerminalSandboxCoordinator(
    env.DB,
    provider,
    undefined,
    (workspaceId) => refreshWorkspaceSchedulerAlarm(env, workspaceId),
    configuration.emergencyDisabled,
    async (context, observation) => emitProductUsageTelemetry(env, {
      workspaceId: context.workspaceId,
      ...(context.executionPrincipal.type === "user" ? { userId: context.executionPrincipal.userId } : {}),
      name: "terminal_workspace_terminal",
      properties: {
        workstreamId: context.workstreamId,
        action: observation.action,
        result: "success",
        duration: telemetryJourneyDuration(observation.durationMs),
        repositorySelected: observation.repositorySelected,
        connectorType: observation.repositorySelected ? "github" : "none",
        localFilesRetained: observation.localFilesRetained,
      },
      operationId: context.harnessRunId,
      eventId: newId(),
    }),
  );
  const readGateway = options.readGateway ?? createGitHubRestReadGateway(env);
  const prepareRepository = async (
    context: HarnessToolContext,
    sandbox: Parameters<typeof bootstrapTerminalRepository>[2],
    sandboxProvider: TerminalSandboxProvider,
  ): Promise<void> => {
    try {
      await bootstrapTerminalRepository(env, context, sandbox, sandboxProvider, readGateway);
    } catch (error) {
      if (error instanceof TerminalToolError && error.code === "repository_not_configured") return;
      throw error;
    }
  };
  const repositoryPreparationDeferredCodes = new Set([
    "connection_revoked",
    "github_unavailable",
    "repository_access_revoked",
    "repository_base_changed",
    "repository_bootstrap_failed",
    "repository_not_authorized",
    "repository_not_configured",
  ]);
  const prepareRepositoryForActivation = async (
    context: HarnessToolContext,
    sandbox: Parameters<typeof bootstrapTerminalRepository>[2],
  ): Promise<string | null> => {
    try {
      await bootstrapTerminalRepository(env, context, sandbox, provider, readGateway);
      return null;
    } catch (error) {
      // Repository selection and bootstrap failures are repaired through the
      // Terminal tool surface itself. The sandbox is already usable, so hiding
      // checkout_repository here would remove the only in-product repair path.
      if (error instanceof TerminalToolError && repositoryPreparationDeferredCodes.has(error.code)) {
        return error.code;
      }
      throw error;
    }
  };
  const runtime = createDaytonaTerminalRuntime(
    env.DB,
    coordinator,
    provider,
    createTerminalResourceBridge(env),
    createRepositoryPublisher(env, createGitHubRestPublicationGateway(env)),
    createTerminalRepositorySelector(
      env,
      provider,
      createGitHubTerminalCatalogGateway(env),
      coordinator,
    ),
    prepareRepository,
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
  const plugin = createTerminalPlugin(
    observedExecutors,
    `${TERMINAL_PLUGIN_SYSTEM_MESSAGE}${egressGuidance}`,
  );
  return {
    ...plugin,
    activationTimeoutMs: TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
    onActivate: async (context: HarnessPluginActivationContext) => {
      const startedAt = Date.now();
      const terminalContext: HarnessToolContext = {
        ...context,
        toolCallId: `${context.harnessRunId}:plugin:terminal:activation`,
      };
      try {
        const sandbox = await coordinator.acquire(terminalContext);
        const repositoryPreparationCode = await prepareRepositoryForActivation(terminalContext, sandbox);
        logStructuredEvent(env, "info", "terminal_plugin_activation_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          state: "completed",
          repository_state: repositoryPreparationCode ? "deferred" : "prepared",
          ...(repositoryPreparationCode ? { repository_code: repositoryPreparationCode } : {}),
          duration_ms: Date.now() - startedAt,
        });
      } catch (error) {
        logStructuredEvent(env, "warn", "terminal_plugin_activation_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          state: "failed",
          code: error instanceof TerminalToolError ? error.code : "terminal_activation_failed",
          duration_ms: Date.now() - startedAt,
        });
        if (!(error instanceof TerminalToolError)) throw error;
        const retryAfterMs = typeof error.details?.retryAfterMs === "number"
          ? error.details.retryAfterMs
          : undefined;
        const retryable = error.code === "sandbox_busy"
          || (error.code === "sandbox_unavailable" && !configuration.emergencyDisabled);
        const reason = typeof error.details?.reason === "string" ? error.details.reason : error.message;
        throw new HarnessPluginActivationError(reason, {
          retryable,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          cause: error,
        });
      }
    },
  };
}
