import {
  type HarnessPlugin,
  type HarnessPluginActivationContext,
  type HarnessToolContext,
} from "@rally/agent-harness";
import { asWorkspaceId, runRequesterUserId, type WorkstreamWorkflowInput } from "@rally/contracts";
import { newId } from "@rally/db";

import type { Env } from "../../env";
import { diagnosticErrorCode, logStructuredEvent } from "../../observability/logger";
import { recordTerminalPlatformObservation } from "../../observability/terminal-platform-observability";
import {
  createTerminalPlugin,
  parseTerminalRegionConfiguration,
  TerminalArgumentSchemas,
  TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
  TERMINAL_PLUGIN_SYSTEM_MESSAGE,
  TERMINAL_TOOL_NAMES,
  type TerminalToolExecutors,
} from "./contract";
import { resolveTerminalPublicationHome, resolveTerminalRunScope, workspaceAgentOwnerLookup, type TerminalRunScope } from "./authority";
import { TerminalSandboxCoordinator } from "./coordinator";
import { createHarnessRunPortFactory } from "../../runtime/harness-run-port";
import { createResourcePortFactory } from "../../runtime/resource-port";
import type { TerminalSandboxProvider } from "./provider-contract";
import { createTerminalProviderRpcClient } from "./provider-rpc-client";
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
import { createTerminalInstructionFiles } from "./instructions";
import { createResidentContextPortFactory } from "../../runtime/resident-context-port";
import { createTerminalRepositorySelector } from "./repository-selection";
import { createGitHubTerminalCatalogGateway } from "./workstream-state";
import { createTerminalToolExecutors, TerminalToolError } from "./tools";
import { refreshWorkspaceSchedule } from "../workstream-wakeup-service";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import { workspaceDOName } from "../../durable-objects/names";
import { WorkspaceTerminalNetworkModeSchema } from "../../durable-objects/workspace-terminal-network-protocol";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";
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
): Promise<(HarnessPlugin & Disposable) | null> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const configuration = parseTerminalRegionConfiguration(env);
  if (configuration.capability === "unsupported") return null;

  // One sandbox per ordinary conversation or per Sidekick. Delegated agents
  // share that same owner's files and mutation lease. Decided once and bound
  // into the factory so nothing below needs to know a run's Terminal address
  // can differ from its own.
  let scope: TerminalRunScope;
  let publicationHome: Awaited<ReturnType<typeof resolveTerminalPublicationHome>>;
  try {
    [scope, publicationHome] = await Promise.all([
      resolveTerminalRunScope(input, workspaceAgentOwnerLookup(env, input.workspaceId)),
      resolveTerminalPublicationHome(env, input),
    ]);
  } catch (error) {
    // Terminal is what an unresolved authority takes away, not the run: the
    // run keeps every other tool, and the refusal is logged with its reason.
    // A throw here would have failed the whole tool inventory as an unnamed
    // error. The two refusals in `authority.ts` and a WorkspaceDO hop that
    // fails on the way all land here.
    logStructuredEvent(env, "warn", "terminal_authority_unresolved", {
      workspace_id: input.workspaceId,
      workstream_id: input.parentId,
      substream_id: input.substreamId ?? "0",
      harness_run_id: input.harnessRunId,
      reason: diagnosticErrorCode(error, "terminal_authority_unresolved"),
    });
    return null;
  }
  // No in-object variant to choose between: the owning object installs its
  // Terminal executor on the environment a run is handed, so this factory is
  // local inside that object when the object is the authority conversation,
  // and a stub to that conversation anywhere else, without either caller
  // knowing which. See `runtime/local-authorities.ts`.
  const terminalPort = createTerminalPortFactory(env, undefined, scope.authoritySubstreamId);
  // The conversation's context-residency ledger, addressed by the substream
  // this run is: residency is a fact about one transcript. Resolves in-object
  // the same way the Terminal port does.
  const instructions = createTerminalInstructionFiles(
    createResidentContextPortFactory(env)(input.workspaceId, input.parentId, input.substreamId ?? "0"),
    (error, stage) => logStructuredEvent(env, "warn", "terminal_instruction_probe_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.parentId,
      harness_run_id: input.harnessRunId,
      stage,
      error_name: error instanceof Error ? error.name : "unknown",
      error_message: error instanceof Error ? error.message : String(error),
    }),
  );

  await admitTerminalPublicationGrant(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.parentId,
    harnessRunId: input.harnessRunId,
    triggerMessageId: input.triggerMessageId,
    executionPrincipal: input.executionPrincipal,
  }, new Date(), terminalPort);

  // Owned by this plugin, and so by the run: disposing the plugin releases the
  // provider session the run's tools share.
  const ownedProvider = options.provider ? null : createTerminalProviderRpcClient(env.TERMINAL_PROVIDER, configuration, {
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
          workstream_id: input.parentId,
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
  const provider = options.provider ?? ownedProvider!;
  // Shared files are an execution-user boundary, not permission to act as the
  // editor. Read the live Sidekick facts before activation and every tool,
  // including reads that can reuse the runtime's cached acquisition.
  const assertSandboxPrincipal = async (context: HarnessToolContext): Promise<void> => {
    if (input.parentKind !== "automation") return;
    const workspace = await durableObjectStubForWorkspace(
      env, env.WORKSPACE_DOS, asWorkspaceId(input.workspaceId),
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
    );
    const facts = context.executionPrincipal.type === "user"
      ? await workspace.sidekickReadAuthorizationFacts({
        workspaceId: asWorkspaceId(input.workspaceId), parentId: input.parentId,
        userId: context.executionPrincipal.userId, substreamIds: [],
      })
      : null;
    if (!facts?.exists || !facts.executor) {
      throw new TerminalToolError(
        "sandbox_authority_mismatch",
        "Only the user this Sidekick runs as can use its shared Terminal files. You can still edit its definition without accessing Terminal.",
        { reason: "Continue as the Sidekick's run-as user to use its Terminal sandbox." },
      );
    }
  };
  const coordinator = new TerminalSandboxCoordinator(
    env,
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
    { ...scope, runsPort: createHarnessRunPortFactory(env) },
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
        instructions,
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
        instructions,
      );
      return null;
    } catch (error) {
      // Repository selection and bootstrap failures are repaired through the
      // Terminal tool surface itself. The sandbox is already usable, so hiding
      // checkout_repository here would remove the only in-product repair path.
      //
      // `repository_not_configured` is the one code that leaves nothing to
      // revalidate, so it returns and the acquisition stands. Every other code
      // rethrows the original error, which rejects the shared per-run
      // acquisition. That rejection is load-bearing now that activation no
      // longer blocks the model: a Terminal tool from the next turn can already
      // be awaiting this promise, and evicting the cache after it resolves
      // never reaches an in-flight waiter — that waiter would go on to use a
      // sandbox whose checkout is stale or whose repository authorization was
      // revoked. Rethrowing the original `TerminalToolError` rather than a
      // sentinel is what gives that waiter the actionable code
      // (`repository_access_revoked` and friends) instead of an opaque one.
      if (error instanceof TerminalToolError && error.code === "repository_not_configured") {
        return error.code;
      }
      throw error;
    }
  };
  // Hoisted out of the runtime call: the effect reconciler below asks the
  // resource authority a question directly, without a sandbox, so it needs the
  // bridge rather than the runtime that wraps it.
  const resourceBridge = createTerminalResourceBridge(
      env,
      terminalPort,
      inObjectResourceAttacher,
      publicationHome?.parentId ?? null,
      // A background agent imports what its own conversation has attached into
      // its owner's sandbox; the import records that conversation so the
      // revocation check asks it, not the owner's.
      scope.runSubstreamId === scope.authoritySubstreamId ? null : scope.runSubstreamId,
      runRequesterUserId(input),
      publicationHome?.substreamId ?? "0",
  );
  const runtime = createDaytonaTerminalRuntime(
    terminalPort,
    coordinator,
    provider,
    resourceBridge,
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
    undefined,
    instructions,
  );
  const executors = createTerminalToolExecutors(runtime, {
    images: env.IMAGES,
    documentProcessor: env.DOCUMENT_PROCESSOR,
  });
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
        await assertSandboxPrincipal(context);
        const result = await withTerminalToolTrace(trace, () => executors[name](toolInput, context));
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, "info", "terminal_tool_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          substream_id: scope.runSubstreamId,
          terminal_substream_id: scope.authoritySubstreamId,
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
          substream_id: scope.runSubstreamId,
          terminal_substream_id: scope.authoritySubstreamId,
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
  // A typed read rather than SQL through the runtime facade, and deliberately
  // the non-creating one: this runs on every agent turn, and a workspace that
  // has never opened the setting should not have a row written for it here.
  const policy = WorkspaceTerminalNetworkModeSchema.parse(
    await (await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      asWorkspaceId(input.workspaceId),
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
    )).terminalNetworkMode({ workspaceId: input.workspaceId }),
  );
  const egressGuidance = policy.mode === "full_internet"
    ? " Current workspace egress is Full internet."
    : " Current workspace egress is Trusted only; a network failure may mean the destination is not approved, so ask a workspace owner to review Terminal network targets instead of trying to bypass it.";
  const sidekickGuidance = input.parentKind === "automation"
    ? " This Sidekick's wizard, activations, and background agents share one sandbox under its current run-as user. Other editors can configure its definition but cannot access those files. Resources visible in this Sidekick's home and explicitly attached conversations are available automatically under your existing permissions. Publications belong to its home conversation when it has one, so reuse the original site's path to update it. If a known site ID is missing from the resource list, attempt import_resource with that ID before asking for reattachment. Activations can overlap; the mutation lease protects one tool call, not a whole workflow. Load tracking-seen-or-done-items and claim a shared output before a multi-step update; use separate directories for independent work."
    : "";
  const plugin = createTerminalPlugin(
    observedExecutors,
    `${TERMINAL_PLUGIN_SYSTEM_MESSAGE}${sidekickGuidance}${egressGuidance}`,
    {
      // Only `publish_resource` needs one: the other re-enterable Terminal
      // writes resolve their effect from the receipt, so re-entering them is
      // already the question. See `REENTERABLE_TERMINAL_TOOLS`.
      publish_resource: async (rawInput, context) => resourceBridge.reconcilePublishedResource(
        context,
        TerminalArgumentSchemas.publish_resource.parse(rawInput),
      ),
    },
  );
  let activationAttempt = 0;
  return {
    ...plugin,
    activationTimeoutMs: TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
    [Symbol.dispose]: () => ownedProvider?.[Symbol.dispose](),
    onActivate: async (context: HarnessPluginActivationContext) => {
      const startedAt = Date.now();
      const activationAttemptNumber = ++activationAttempt;
      const toolCallId = `${context.harnessRunId}:plugin:terminal:activation:${activationAttemptNumber}`;
      const trace = createTerminalToolTrace({
        toolName: "terminal_plugin_activation",
        toolCallId,
        toolInvocationId: null,
      });
      const terminalContext: HarnessToolContext = { ...context, toolCallId };
      const settled = (level: "info" | "warn", fields: Record<string, unknown>): void => {
        const durationMs = Date.now() - startedAt;
        logStructuredEvent(env, level, "terminal_plugin_activation_finished", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          substream_id: scope.runSubstreamId,
          terminal_substream_id: scope.authoritySubstreamId,
          harness_run_id: context.harnessRunId,
          tool_call_id: toolCallId,
          activation_attempt: activationAttemptNumber,
          ...fields,
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
      };

      // Paired with `terminal_plugin_activation_finished`. Activation no longer
      // awaits its own work, so the runtime — not this code — decides whether
      // that work survives to settle. A started row with no finished row for the
      // same `tool_call_id` is the shape of the sandbox being abandoned mid
      // flight, and it is the only way to see it: a cancelled continuation
      // cannot log its own death.
      logStructuredEvent(env, "info", "terminal_plugin_activation_started", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        substream_id: scope.runSubstreamId,
        terminal_substream_id: scope.authoritySubstreamId,
        harness_run_id: context.harnessRunId,
        tool_call_id: toolCallId,
        activation_attempt: activationAttemptNumber,
      });

      let repositoryPreparationCode: string | null = null;
      // Start the sandbox; do not hold the model behind it. `runtime.prepare`
      // registers the shared per-run acquisition that every Terminal tool
      // already awaits, so the first tool that genuinely needs a sandbox
      // collects this work in flight instead of starting it. Measured across
      // runs that use Terminal, the median run does 16.5s of unrelated work
      // between activation and its first Terminal tool, against an ~18s median
      // cold start — so for most runs this wait stops being visible at all.
      const preparing = withTerminalToolTrace(trace, async () => {
        await assertSandboxPrincipal(terminalContext);
        await runtime.prepare(terminalContext, async (runtimeContext, sandbox) => {
          repositoryPreparationCode = await prepareRepositoryForActivation(runtimeContext, sandbox);
        });
      });

      void preparing.then(
        () => settled("info", {
          state: "completed",
          repository_state: repositoryPreparationCode ? "deferred" : "prepared",
          ...(repositoryPreparationCode ? { repository_code: repositoryPreparationCode } : {}),
        }),
        (error: unknown) => {
          // A repository that has to be revalidated is not an activation
          // failure: the plugin stays active and `checkout_repository` remains
          // the in-product repair path. The acquisition was rejected rather
          // than evicted, so whichever Terminal tool asks next receives this
          // same actionable error and reacquires.
          if (error instanceof TerminalToolError
            && repositoryPreparationDeferredCodes.has(error.code)) {
            settled("info", {
              state: "completed",
              repository_state: "deferred",
              repository_code: error.code,
            });
            return;
          }
          // Nothing to raise to the model here — activation already returned.
          // The first Terminal tool acquires again and reports the failure with
          // its own guidance, so the participant still hears about it through
          // the model. A run that never reaches a Terminal tool leaves only this
          // warn row, and the row is the operator's record: a Slack notice from
          // here would post once per failing run for the length of a provider
          // outage, and `docs/ops-alerting.md` asks for one notice per episode,
          // which needs a durable gate that a per-object module cannot hold.
          const code = error instanceof TerminalToolError
            ? error.code
            : "terminal_activation_failed";
          settled("warn", { state: "failed", code });
        },
      );
    },
  };
}
