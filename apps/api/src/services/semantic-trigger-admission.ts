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
 * The part of one Sidekick object this admission needs, so a test can supply it.
 *
 * Narrower than the stub on purpose: a fake for this is two methods rather than
 * a Durable Object, and the shape says exactly which two the delivery path is
 * allowed to call.
 */
export interface SemanticTriggerAdmissionPort {
  externalEventAdmissionPlan(input: AutomationExternalEventAdmission): Promise<
    | { kind: "refuse"; outcomeCode: string }
    | { kind: "admit" }
    | { kind: "judge"; conditions: string[]; connectorType: string | null }
  >;
  admitExternalEvent(input: AutomationExternalEventAdmission): Promise<{
    admitted: boolean;
    outcomeCode: string;
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
 * Three steps, and the middle one is the only one that costs anything: the
 * object says whether this delivery is gated, the classifier judges the
 * condition if it is, and the object admits. The object is asked first because
 * lifecycle, trigger membership and the activation boundary settle most
 * deliveries for free, and a paused Sidekick should not pay for a model call to
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
  const plan = await input.sidekick.externalEventAdmissionPlan(input.admission);
  if (plan.kind === "refuse") return { admitted: false, outcomeCode: plan.outcomeCode };
  if (plan.kind === "admit") return input.sidekick.admitExternalEvent(input.admission);

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
