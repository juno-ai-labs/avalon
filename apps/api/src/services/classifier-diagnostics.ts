import type { StructuredModelDiagnostic } from "@rally/agent-harness";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import type { MeteredActivity } from "@rally/contracts/usage";
import { captureStructuredInferenceDiagnostic } from "./inference-lakehouse";
import { emitInferenceUsage } from "./usage-metering";

/**
 * Where a classifier's provider diagnostics go, for every classifier.
 *
 * Two destinations, and both are required of any model call in this tree: one
 * `structured_inference` log line an operator can read without credentials, and
 * one archived record on the access-controlled inference path that holds the
 * exact request and response. The addressing classifier had both, written inline
 * beside it; a second classifier copying forty lines of field mapping is how the
 * two drift until a query has to know which classifier it is reading.
 *
 * The sink deliberately does not decide severity by classifier: a validation
 * issue or a named failure is a warning wherever it happens, because the shape
 * of that judgement is not one classifier's business.
 */
export interface ClassifierDiagnosticSink {
  /** Pass to a harness classifier's `onDiagnostic`. */
  record: (diagnostic: StructuredModelDiagnostic) => void;
}

export function createClassifierDiagnosticSink(
  env: Env,
  context: {
    /**
     * Names the classifier in logs and lakehouse records, and is the metered
     * activity its calls are recorded as.
     */
    role: Extract<MeteredActivity, "addressing_classifier" | "semantic_trigger_gate" | "completion_verification">;
    workspaceId: string;
    workstreamId?: string | undefined;
    /** Stable across every stage of one decision, including its fallback. */
    traceId: string;
    /** How the caller keeps an archival write off the response path. */
    defer: (promise: Promise<unknown>) => void;
  },
): ClassifierDiagnosticSink {
  return {
    record: (diagnostic) => {
      const provider = diagnostic.provider ?? "openrouter";
      logStructuredEvent(
        env,
        diagnostic.validationIssues || diagnostic.failureKind ? "warn" : "info",
        "structured_inference",
        {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          trace_id: diagnostic.traceId,
          inference_request_id: diagnostic.inferenceRequestId,
          role: context.role,
          stage: diagnostic.stage,
          schema_name: diagnostic.schemaName,
          provider,
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
          provider_error_detail: diagnostic.providerError?.detail,
          validation_issues: diagnostic.validationIssues,
        },
      );
      if (diagnostic.stage === "complete") {
        // The JEV leg reports tokens but no cost, so it is logged as unpriced
        // until its rate is known (PRD open question 1).
        emitInferenceUsage(env, context.defer, {
          eventId: diagnostic.inferenceRequestId
            ? `inf:${diagnostic.inferenceRequestId}`
            : `cls:${context.traceId}:${provider}:${diagnostic.attempt}:${diagnostic.fallbackAttempt}`,
          workspaceId: context.workspaceId,
          activity: context.role,
          costCents: diagnostic.costCents,
          model: diagnostic.model,
          refs: context.workstreamId ? { workstreamId: context.workstreamId } : {},
        });
      }
      context.defer(captureStructuredInferenceDiagnostic(env, {
        source: context.role,
        workspaceId: context.workspaceId,
        ...(context.workstreamId ? { workstreamId: context.workstreamId } : {}),
        traceId: context.traceId,
        requestId: context.traceId,
      }, diagnostic));
    },
  };
}
