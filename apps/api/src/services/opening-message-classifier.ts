import { classifyOpeningMessage, type OpeningMessageInput } from "@rally/agent-harness";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { createClassifierDiagnosticSink } from "./classifier-diagnostics";

// Admission only: classifier labels, confidence, and failure details belong in
// internal diagnostics, never in a conversation message or the agent's context.
export async function openingMessageStartsRun(
  env: Env,
  input: OpeningMessageInput & {
    workspaceId: string;
    workstreamId: string;
    substreamId: string;
    defer: (promise: Promise<unknown>) => void;
  },
): Promise<boolean> {
  const traceId = crypto.randomUUID();
  const diagnostics = createClassifierDiagnosticSink(env, {
    role: "addressing_classifier",
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    traceId,
    defer: input.defer,
  });
  const decision = await classifyOpeningMessage({
    ...input,
    typesafeApiKey: env.TYPESAFE_API_KEY,
    onDiagnostic: diagnostics.record,
    traceContext: { requestId: traceId },
  });
  logStructuredEvent(env, "info", "opening_message_classifier_outcome", {
    workspace_id: input.workspaceId,
    workstream_id: input.workstreamId,
    substream_id: input.substreamId,
    trace_id: traceId,
    classification: decision.classification,
    outcome: decision.outcome,
    confidence: decision.confidence,
    failure_kind: decision.failureKind,
  });
  return decision.classification === "prompt_to_process";
}
