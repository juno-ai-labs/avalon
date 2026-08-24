import {
  OpenRouterClient,
  type ModelMessage,
  type StructuredModelDiagnostic,
} from "@avalon/agent-harness";
import type { Env } from "../env";
import { createDeadline } from "../lib/deadline";
import { logStructuredEvent } from "../observability/logger";
import {
  resolveAgentModelRouting,
  type AgentModelFlagContext,
  type AgentModelRole,
} from "./agent-model-flags";
import { captureStructuredInferenceDiagnostic } from "./inference-lakehouse";

const STRUCTURED_INFERENCE_TIMEOUT_MS = 2 * 60_000;

type StructuredInferenceRole = Extract<
  AgentModelRole,
  | "workstream"
  | "activity_structured"
  | "work_opportunity_admission"
  | "work_opportunity_ranking"
  | "workstream_description"
  | "workstream_naming"
>;

export async function runStructuredInference<T>(
  env: Env,
  input: {
    role: StructuredInferenceRole;
    context: AgentModelFlagContext;
    messages: ModelMessage[];
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T;
    /**
     * `"none"` asks the provider to switch reasoning off rather than leaving it
     * to the model's default, which differs by model — a mechanical one-turn
     * role would otherwise start paying for thinking the first time a flag
     * retargets it at a model that reasons unless told not to.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high";
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
  },
): Promise<{ result: T; model: string }> {
  const routing = await resolveAgentModelRouting(env, input.role, input.context);
  input.onModelResolved?.(routing.model);
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: routing.model,
    fallbackModels: routing.fallbackModels,
    appUrl: env.PUBLIC_API_BASE_URL,
    appName: "Avalon",
  });
  // Most callers are queue consumers and Workflow steps, whose invocation ends
  // when this returns. An `AbortSignal.timeout` would stay armed for the rest of
  // its two-minute window and hold that invocation open; the deadline is
  // disposed once the call settles instead. See `lib/deadline.ts`.
  const deadline = createDeadline(STRUCTURED_INFERENCE_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline.signal])
    : deadline.signal;
  const onDiagnostic = async (diagnostic: StructuredModelDiagnostic): Promise<void> => {
    logStructuredEvent(
      env,
      diagnostic.validationIssues || diagnostic.failureKind ? "warn" : "info",
      "structured_inference",
      {
        workspace_id: input.context.workspaceId,
        user_id: input.context.userId,
        workstream_id: input.context.workstreamId,
        role: input.role,
        stage: diagnostic.stage,
        schema_name: diagnostic.schemaName,
        provider: "openrouter",
        model: diagnostic.model,
        attempt: diagnostic.attempt,
        fallback_attempt: diagnostic.fallbackAttempt,
        repair_attempt: diagnostic.repairAttempt,
        latency_ms: diagnostic.latencyMs,
        response_bytes: diagnostic.responseBytes,
        input_tokens: diagnostic.inputTokens,
        output_tokens: diagnostic.outputTokens,
        success: diagnostic.success,
        failure_kind: diagnostic.failureKind,
        provider_error_code: diagnostic.providerError?.code,
        provider_error_provider: diagnostic.providerError?.providerName,
        validation_issues: diagnostic.validationIssues,
      },
    );
    await captureStructuredInferenceDiagnostic(env, {
      source: input.role,
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.userId ? { userId: input.context.userId } : {}),
      ...(input.context.workstreamId ? { workstreamId: input.context.workstreamId } : {}),
    }, diagnostic);
  };
  try {
    const result = await client.structured({
      messages: input.messages,
      schemaName: input.schemaName,
      jsonSchema: input.jsonSchema,
      parse: input.parse,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      signal,
      onDiagnostic,
    });
    return { result, model: routing.model };
  } finally {
    deadline.dispose();
  }
}
