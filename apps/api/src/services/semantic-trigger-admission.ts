import {
  judgeSemanticTriggerConditions,
  type SemanticTriggerDecision,
} from "@rally/agent-harness";
import type {
  AutomationExternalEventAdmission,
  AutomationSemanticConditionVerdict,
} from "../durable-objects/automation-do-protocol";
import type { Env } from "../env";
import { createClassifierDiagnosticSink } from "./classifier-diagnostics";

/**
 * The one Organization call this admission needs, so a test can supply it.
 *
 * An admission that arrives without a verdict for a Sidekick whose trigger
 * carries a written condition is refused as unjudged, and the refusal carries
 * the conditions to judge. Asking with a verdict is then the second and last
 * call. Every other delivery is settled by the first.
 */
export interface SemanticTriggerAdmissionPort {
  admitExternalEvent(input: AutomationExternalEventAdmission): Promise<{
    admitted: boolean;
    outcomeCode: string;
    judge?: { conditions: string[]; connectorType: string | null } | undefined;
  }>;
}

export interface SemanticTriggerAdmissionResult {
  admitted: boolean;
  outcomeCode: string;
  /** Present only when a condition was judged, for the delivery's log line. */
  gate?: {
    code: SemanticTriggerDecision["code"];
    confidence: number | null;
    model: string | null;
    failureKind?: string | undefined;
    conditionCount: number;
  };
}

/**
 * Admit one matched external event, testing any written condition first.
 *
 * The object is asked first, and for most deliveries that one call is the
 * whole admission: lifecycle, trigger membership and the activation boundary
 * settle them, and an ungated event is admitted on the spot. Only a gated one
 * comes back with its conditions, is judged by the classifier, and is asked
 * again with the verdict. A paused Sidekick does not pay for a model call to
 * be told it is paused.
 *
 * The model call runs here rather than inside the object deliberately. Every
 * other model call in this tree runs in a Worker, and an object that blocked on
 * a provider would serialize every other request to that Sidekick behind a
 * network round trip it does not control. The object keeps the decision: it
 * refuses a gated event that arrives without a verdict.
 *
 * Without a TypeSafe credential there is no classifier, so a gated delivery is
 * refused as unjudged rather than admitted. Hosted regions always have one —
 * `assertEnvContract` requires it — so that path is local development, where
 * refusing is the honest answer and admitting would reproduce the defect this
 * exists to fix.
 */
export async function admitExternalEventWithSemanticGate(
  env: Env,
  input: {
    sidekick: SemanticTriggerAdmissionPort;
    admission: AutomationExternalEventAdmission;
    workspaceId: string;
    defer: (promise: Promise<unknown>) => void;
    signal?: AbortSignal | undefined;
    fetch?: typeof globalThis.fetch | undefined;
  },
): Promise<SemanticTriggerAdmissionResult> {
  const first = await input.sidekick.admitExternalEvent(input.admission);
  if (!first.judge) return { admitted: first.admitted, outcomeCode: first.outcomeCode };
  const plan = first.judge;

  const traceId = crypto.randomUUID();
  const decision: SemanticTriggerDecision = env.TYPESAFE_API_KEY
    ? await judgeSemanticTriggerConditions({
      typesafeApiKey: env.TYPESAFE_API_KEY,
      conditions: plan.conditions,
      event: {
        connectorType: plan.connectorType,
        eventType: input.admission.event.eventType,
        title: input.admission.event.title,
        summary: input.admission.event.summary,
        textSnippet: input.admission.event.textSnippet,
      },
      signal: input.signal,
      fetch: input.fetch,
      traceContext: {
        source: "semantic_trigger_gate",
        feature: "semantic-trigger-gate",
        workspaceId: input.workspaceId,
        requestId: traceId,
        region: env.AVALON_REGION,
        environment: env.APP_ENV,
        ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
      },
      onDiagnostic: createClassifierDiagnosticSink(env, {
        role: "semantic_trigger_gate",
        workspaceId: input.workspaceId,
        traceId,
        defer: input.defer,
      }).record,
    })
    : { admit: false, code: "classifier_unavailable", confidence: null, model: null };

  const verdict: AutomationSemanticConditionVerdict = {
    admit: decision.admit,
    code: decision.code,
    confidence: decision.confidence,
    model: decision.model,
  };
  const result = await input.sidekick.admitExternalEvent({ ...input.admission, conditionVerdict: verdict });
  return {
    ...result,
    gate: {
      code: decision.code,
      confidence: decision.confidence,
      model: decision.model,
      failureKind: decision.failureKind,
      conditionCount: plan.conditions.length,
    },
  };
}
