import { COMPLETION_STOP_CONFIDENCE, type judgeCompletionStop } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { TelemetryEventProperties } from "@rally/contracts/telemetry";
import type { Env } from "../env";
import { runtimeDeferral, type WorkDeferral } from "../lib/defer";
import { diagnosticErrorCode, logStructuredEvent } from "../observability/logger";
import { emitProductUsageTelemetry, resourceTelemetryEventId, runTelemetryOperationId } from "./product-usage";

export interface CompletionRepromptObservation {
  decision: Awaited<ReturnType<typeof judgeCompletionStop>>;
  contextStatus: "resolved" | "unresolved";
}

function repromptReason({ decision, contextStatus }: CompletionRepromptObservation): TelemetryEventProperties<"agent_completion_reprompted">["reason"] {
  if (decision.failureKind === "credential_missing") return "credential_missing";
  if (decision.failureKind === "typesafe_request_timed_out") return "judge_timeout";
  if (decision.failureKind || !decision.answer) return "judge_failure";
  if (contextStatus === "unresolved") return "context_missing";
  if (decision.answer.choice === "announces_unfinished_work") return "unfinished_work";
  if (decision.answer.choice === "unclear") return "unclear";
  return "low_confidence";
}

/** Called only after the recovery prompt commits. Acceptance is best effort,
 * deferred, and deduplicated per execution; it never gates model continuation. */
export function emitCompletionRepromptTelemetry(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "harnessRunId" | "executionPrincipal" | "automationRun">,
  observation: CompletionRepromptObservation,
  defer: WorkDeferral = runtimeDeferral,
): void {
  try {
    const properties: TelemetryEventProperties<"agent_completion_reprompted"> = {
      workstreamId: input.parentId,
      harnessRunId: input.harnessRunId,
      ...(input.automationRun ? { automationId: input.automationRun.automationId } : {}),
      reason: repromptReason(observation),
      choice: observation.decision.answer?.choice ?? null,
      confidence: observation.decision.answer?.confidence ?? null,
      stopConfidenceThreshold: COMPLETION_STOP_CONFIDENCE,
      judgeModel: "jev-1.14.0",
    };
    logStructuredEvent(env, "info", "agent_completion_reprompted", {
      workspace_id: input.workspaceId, ...properties,
    });
    emitProductUsageTelemetry(env, {
      workspaceId: input.workspaceId,
      ...(input.executionPrincipal.type === "user" ? { userId: input.executionPrincipal.userId } : {}),
      name: "agent_completion_reprompted", properties,
      operationId: runTelemetryOperationId(input.harnessRunId),
      // Run terminal uses namespace 2; recovery is a separate observation.
      eventId: resourceTelemetryEventId(input.harnessRunId, 3),
    }, defer);
  } catch (error) {
    logStructuredEvent(env, "warn", "completion_reprompt_telemetry_failed", {
      harness_run_id: input.harnessRunId,
      error_code: diagnosticErrorCode(error, "completion_reprompt_telemetry_failed"),
    });
  }
}
