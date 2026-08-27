import {
  HarnessPluginActivationError,
  type HarnessPlugin,
  type HarnessPluginActivationContext,
  type HarnessToolContext,
} from "@rally/agent-harness";
import { asWorkspaceId, type WorkstreamWorkflowInput } from "@rally/contracts";
import { newId } from "@rally/db";

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
import { createResourcePortFactory } from "../../runtime/resource-port";
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
import {
  createTerminalPortFactory,
  TerminalObjectPortError,
} from "./object-port";
import { createTerminalResourceBridge } from "./resource-bridge";
import { createDaytonaTerminalRuntime } from "./runtime";
import { createTerminalRepositorySelector } from "./repository-selection";
import { createGitHubTerminalCatalogGateway } from "./workstream-state";
import { createTerminalToolExecutors, TerminalToolError } from "./tools";
import { refreshWorkspaceSchedule } from "../workstream-wakeup-service";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import type { WorkstreamRuntimeResourceAttacher } from "../workstream-object-client";
import {
  createTerminalToolTrace,
  currentTerminalToolTrace,
  recordTerminalProviderRequest,
  withTerminalToolTrace,
} from "./tracing";

export async function createAvalonTerminalPlugin(
  env: Env,
  input: WorkstreamWorkflowInput,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
  options: {
    provider?: TerminalSandboxProvider;
    readGateway?: TerminalGitHubReadGateway;
  } = {},
): Promise<HarnessPlugin | null> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const configuration = parseTerminalRegionConfiguration(env);
  if (configuration.capability === "unsupported") return null;

  // No in-object variant to choose between: the owning object installs its
  // Terminal executor on the environment a run is handed, so this factory is
  // local inside that object and a stub anywhere else, without either caller
  // knowing which. See `runtime/local-authorities.ts`.
  const terminalPort = createTerminalPortFactory(env);

  await admitTerminalPublicationGrant(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: input.harnessRunId,
    triggerMessageId: input.triggerMessageId,
    executionPrincipal: input.executionPrincipal,
  }, new Date(), terminalPort);

  const provider = options.provider ?? createDaytonaTerminalProvider(configuration, undefined, {
    observe: (measurement) => recordTerminalPlatformObservation(env, measurement),
    observeRequest: (measurement) => {
      recordTerminalProviderRequest(measurement);
      const trace = currentTerminalToolTrace();
      logStructuredEvent(
        env,
        measurement.outcome === "completed" ? "info" : "warn",
        "terminal_provider_request_finished",
        {
          workspace_id: input.workspaceId,
          workstream_id: input.workstreamId,
          harness_run_id: input.harnessRunId,
          tool_invocation_id: trace?.toolInvocationId ?? null,
          tool_call_id: trace?.toolCallId ?? null,
          tool_name: trace?.toolName ?? null,
          operation: measurement.operation,
          operation_detail: measurement.detail,
          provider_operation_index: trace?.providerOperationCount ?? null,
          state: measurement.outcome,
          duration_ms: measurement.durationMs,
          provider_request_count: measurement.requestCount,
          provider_poll_count: measurement.pollCount,
          bytes: measurement.bytes,
        },
      );
    },
  });
  const coordinator = new TerminalSandboxCoordinator(
    env.DB,
    terminalPort,
    createResourcePortFactory(env),
    provider,
    undefined,
    (workspaceId) => refreshWorkspaceSchedule(env, workspaceId),
    configuration.emergencyDisabled,
    async (context, observation) => emitProductUsageTelemetry(env, {
      workspaceId: asWorkspaceId(context.workspaceId),
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
      await bootstrapTerminalRepository(
        env,
        context,
        sandbox,
        sandboxProvider,
        readGateway,
        terminalPort,
      );
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
      await bootstrapTerminalRepository(
        env,
        context,
        sandbox,
        provider,
        readGateway,
        terminalPort,
      );
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
    terminalPort,
    coordinator,
    provider,
    createTerminalResourceBridge(env, terminalPort, inObjectResourceAttacher),
    createRepositoryPublisher(env, createGitHubRestPublicationGateway(env), terminalPort),
    createTerminalRepositorySelector(
      env,
      provider,
      createGitHubTerminalCatalogGateway(env),
      coordinator,
      terminalPort,
      inObjectResourceAttacher,
    ),
    prepareRepository,
  );
  const executors = createTerminalToolExecutors(runtime);
  const observedExecutors = Object.fromEntries(TERMINAL_TOOL_NAMES.map((name) => [
    name,
    async (toolInput: unknown, context: Parameters<TerminalToolExecutors[typeof name]>[1]) => {
      const startedAt = Date.now();
      const trace = createTerminalToolTrace({
        toolName: name,
        toolCallId: context.toolCallId,
        toolInvocationId: context.effectIntentId ?? null,
      });
      try {
        const result = await withTerminalToolTrace(trace, () => executors[name](toolInput, context));
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, "info", "terminal_tool_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          // `tool_invocation_id` names the receipt row everywhere else it is
          // logged, and until the identity arrived on the context this had no
          // way to get it. A read tool has no receipt, hence the null.
          tool_invocation_id: context.effectIntentId ?? null,
          tool_call_id: context.toolCallId,
          tool_name: name,
          state: "completed",
          duration_ms: durationMs,
          acquisition_duration_ms: trace.acquisitionDurationMs,
          acquisition_cache_hit: trace.acquisitionCacheHit,
          provider_duration_ms: trace.providerDurationMs,
          provider_request_count: trace.providerRequestCount,
          provider_poll_count: trace.providerPollCount,
          provider_operation_count: trace.providerOperationCount,
          provider_bytes: trace.providerBytes,
          rally_duration_ms: Math.max(0, durationMs - trace.providerDurationMs),
        });
        return result;
      } catch (error) {
        const code = error instanceof TerminalToolError
          ? error.code
          : error instanceof TerminalObjectPortError
            ? error.code
            : "terminal_tool_failed";
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, "warn", "terminal_tool_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          // `tool_invocation_id` names the receipt row everywhere else it is
          // logged, and until the identity arrived on the context this had no
          // way to get it. A read tool has no receipt, hence the null.
          tool_invocation_id: context.effectIntentId ?? null,
          tool_call_id: context.toolCallId,
          tool_name: name,
          state: "failed",
          code,
          duration_ms: durationMs,
          acquisition_duration_ms: trace.acquisitionDurationMs,
          acquisition_cache_hit: trace.acquisitionCacheHit,
          provider_duration_ms: trace.providerDurationMs,
          provider_request_count: trace.providerRequestCount,
          provider_poll_count: trace.providerPollCount,
          provider_operation_count: trace.providerOperationCount,
          provider_bytes: trace.providerBytes,
          rally_duration_ms: Math.max(0, durationMs - trace.providerDurationMs),
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
      const toolCallId = `${context.harnessRunId}:plugin:terminal:activation`;
      const trace = createTerminalToolTrace({
        toolName: "terminal_plugin_activation",
        toolCallId,
        toolInvocationId: null,
      });
      const terminalContext: HarnessToolContext = { ...context, toolCallId };
      try {
        const repositoryPreparationCode = await withTerminalToolTrace(trace, async () => {
          const sandbox = await coordinator.acquire(terminalContext);
          return prepareRepositoryForActivation(terminalContext, sandbox);
        });
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, "info", "terminal_plugin_activation_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          tool_call_id: toolCallId,
          state: "completed",
          repository_state: repositoryPreparationCode ? "deferred" : "prepared",
          ...(repositoryPreparationCode ? { repository_code: repositoryPreparationCode } : {}),
          duration_ms: durationMs,
          acquisition_duration_ms: trace.acquisitionDurationMs,
          acquisition_cache_hit: trace.acquisitionCacheHit,
          provider_duration_ms: trace.providerDurationMs,
          provider_request_count: trace.providerRequestCount,
          provider_poll_count: trace.providerPollCount,
          provider_operation_count: trace.providerOperationCount,
          provider_bytes: trace.providerBytes,
          rally_duration_ms: Math.max(0, durationMs - trace.providerDurationMs),
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, "warn", "terminal_plugin_activation_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          harness_run_id: context.harnessRunId,
          tool_call_id: toolCallId,
          state: "failed",
          code: error instanceof TerminalToolError ? error.code : "terminal_activation_failed",
          duration_ms: durationMs,
          acquisition_duration_ms: trace.acquisitionDurationMs,
          acquisition_cache_hit: trace.acquisitionCacheHit,
          provider_duration_ms: trace.providerDurationMs,
          provider_request_count: trace.providerRequestCount,
          provider_poll_count: trace.providerPollCount,
          provider_operation_count: trace.providerOperationCount,
          provider_bytes: trace.providerBytes,
          rally_duration_ms: Math.max(0, durationMs - trace.providerDurationMs),
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
