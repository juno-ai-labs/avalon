import {
  automationResultDispositionJsonSchema,
  renderAutomationResultDispositionMessages,
  type AutomationResultDisposition,
} from "@rally/agent-harness";
import { z } from "zod";

import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { runStructuredInference } from "./structured-inference";

export interface AutomationResultDispositionInput {
  workspaceId: string;
  /** The run's own work stream, for the inference ledger's coordinates. */
  workstreamId: string;
  automationName: string;
  automationObjective: string;
  triggerKind: "manual" | "schedule" | "external_event" | "inbound_email";
  triggerSummary: string | null;
  result: string;
  recentDispositions: readonly AutomationResultDisposition[];
  reach: { canDeliver: boolean; canExpose: boolean };
  signal?: AbortSignal;
}

export interface AutomationResultDispositionDecision {
  disposition: AutomationResultDisposition;
  reason: string;
  /**
   * `classified` and `default` deliver identically and mean completely
   * different things. An operator reading a surprising delivery needs to know
   * which they are looking at, and a run of `default` rows across a workspace is
   * the shape a routing outage takes here: nothing errors, everything delivers.
   */
  source: "classified" | "default";
}

const DecisionSchema = z.object({
  disposition: z.enum(["done", "deliver", "expose_workstream"]),
  reason: z.string().trim().min(1).max(300),
}).strict();

/**
 * What one completed occurrence's result is worth, decided once.
 *
 * This is the only thing standing between an automation result and the people
 * it can reach — the prose regex that used to approximate one arm of it is
 * deleted — so the failure direction is the whole design. A classifier that
 * cannot answer **delivers**: a spurious delivery is noise somebody can see and
 * complain about, and a swallowed result is silence nobody knows to look for.
 */
export async function classifyAutomationResult(
  env: Env,
  input: AutomationResultDispositionInput,
): Promise<AutomationResultDispositionDecision> {
  // Nothing to decide: an automation that can neither deliver nor expose has
  // no arm but `done`, and asking a model to choose from a set of one spends an
  // inference on a foregone conclusion.
  //
  // No caller can currently produce this, and the arithmetic is why: a room's
  // automation always delivers to its room, and one no room owns can always
  // expose the run it executed in, so the two flags cannot both be false. It
  // stays because it is the honest guard for the question this function asks —
  // a future reach rule that can empty the set would otherwise send a model a
  // schema with one value in it.
  if (!input.reach.canDeliver && !input.reach.canExpose) {
    return {
      disposition: "done",
      reason: "This automation has no destination and no work stream to expose.",
      source: "default",
    };
  }
  try {
    const { result } = await runStructuredInference(env, {
      role: "automation_result_disposition",
      context: { workspaceId: input.workspaceId, workstreamId: input.workstreamId },
      messages: renderAutomationResultDispositionMessages({
        automationName: input.automationName,
        automationObjective: input.automationObjective,
        triggerKind: input.triggerKind,
        triggerSummary: input.triggerSummary,
        result: input.result,
        recentDispositions: input.recentDispositions,
        reach: input.reach,
      }),
      schemaName: "automation_result_disposition",
      jsonSchema: automationResultDispositionJsonSchema(input.reach),
      parse: (value) => DecisionSchema.parse(value),
      ...(input.signal ? { signal: input.signal } : {}),
      // `reasoningEffort` is deliberately not set. The other one-turn structured
      // roles pass "none" because they are mechanical mappings and thinking buys
      // them nothing; this one judges whether to interrupt a room full of
      // people, once per completed occurrence, off the critical path.
    });
    // An arm the schema did not offer cannot arrive, but a model that returned
    // one anyway would be asking for reach nobody granted. Treated as the
    // failure it is rather than honoured.
    if (result.disposition === "deliver" && !input.reach.canDeliver) return unreachableArm(env, input, "deliver");
    if (result.disposition === "expose_workstream" && !input.reach.canExpose) {
      return unreachableArm(env, input, "expose_workstream");
    }
    return { disposition: result.disposition, reason: result.reason, source: "classified" };
  } catch (error) {
    logStructuredEvent(env, "warn", "automation_result_disposition_unavailable", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return {
      disposition: input.reach.canDeliver ? "deliver" : "expose_workstream",
      reason: "Rally could not judge this result, so it was sent rather than withheld.",
      source: "default",
    };
  }
}

function unreachableArm(
  env: Env,
  input: AutomationResultDispositionInput,
  arm: AutomationResultDisposition,
): AutomationResultDispositionDecision {
  logStructuredEvent(env, "warn", "automation_result_disposition_unreachable_arm", {
    workspace_id: input.workspaceId,
    workstream_id: input.workstreamId,
    arm,
  });
  return {
    disposition: input.reach.canDeliver ? "deliver" : "expose_workstream",
    reason: "Rally could not judge this result, so it was sent rather than withheld.",
    source: "default",
  };
}
