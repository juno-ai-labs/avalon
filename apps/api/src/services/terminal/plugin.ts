import type { HarnessPlugin } from "@rally/agent-harness";
import { asWorkspaceId, type WorkstreamWorkflowInput } from "@rally/contracts";
import { newId } from "@rally/db";

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
import { createResourcePortFactory } from "../../runtime/resource-port";
import { createDaytonaTerminalProvider } from "./daytona-provider";
import {
  admitTerminalPublicationGrant,
  bootstrapTerminalRepository,
  createGitHubRestPublicationGateway,
  createGitHubRestReadGateway,
  createTerminalRepositoryPublisher as createRepositoryPublisher,
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

export async function createAvalonTerminalPlugin(
  env: Env,
  input: WorkstreamWorkflowInput,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
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

  const provider = createDaytonaTerminalProvider(configuration, undefined, {
    observe: (measurement) => recordTerminalPlatformObservation(env, measurement),
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
  const readGateway = createGitHubRestReadGateway(env);
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
    async (context, sandbox, sandboxProvider) => {
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
          // `tool_invocation_id` names the receipt row everywhere else it is
          // logged, and until the identity arrived on the context this had no
          // way to get it. A read tool has no receipt, hence the null.
          tool_invocation_id: context.effectIntentId ?? null,
          tool_call_id: context.toolCallId,
          tool_name: name,
          state: "completed",
          duration_ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        const code = error instanceof TerminalToolError
          ? error.code
          : error instanceof TerminalObjectPortError
            ? error.code
            : "terminal_tool_failed";
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
