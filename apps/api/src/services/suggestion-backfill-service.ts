import { asSubstreamId, asWorkspaceId } from "@rally/contracts";

import { conversationObjectName } from "../durable-objects/names";
import type { SettledTurnJudgement } from "../durable-objects/agent-loop-do";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { stableCode } from "../observability/logger";

/**
 * The `suggestion_backfill` job's per-conversation work
 * (docs/thread-backfill.md, docs/conversation-suggestions.md): the
 * conversation object judges its newest settled Rally turn the way a fresh
 * settlement would. Idempotent through the observer's run gate, so a row sent
 * twice judges once. The answer is the object's outcome, for the lane's log.
 */
export async function backfillSuggestion(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
}): Promise<string> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const conversation = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, workspaceId,
    conversationObjectName(env.AVALON_REGION, workspaceId, input.workstreamId, asSubstreamId(input.substreamId)));
  return settledBackfillOutcome(await conversation.backfillTurnDisposition(input));
}

/** The settlement step's own catch: the step threw before it could judge. */
const STEP_FAILED = "failed:";

/**
 * The classifier failures a retry can answer: the provider overloaded or
 * unreachable, or the request's own deadline. Every other kind (a missing or
 * refused key, a request the provider rejected, an answer it could not shape)
 * would fail the same way again, and the lane caps nothing, so retrying it
 * would pay for a JEV call every gate until someone noticed.
 */
const TRANSIENT_HTTP = /^typesafe_http_(?:5\d\d|408|429)$/u;
const TRANSIENT_REQUEST = new Set(["typesafe_request_timed_out", "typesafe_request_failed", "typesafe_request_aborted"]);
export function retryableClassifierFailure(kind: string): boolean {
  return TRANSIENT_HTTP.test(kind) || TRANSIENT_REQUEST.has(kind);
}

/**
 * A failure is a failure, not an outcome (docs/thread-backfill.md): thrown so
 * the lane releases the row and sends it again. A transient classifier
 * failure retries because the observer keeps no answer for a failed judgement
 * and asks again; a step that threw retries because nothing was judged. A
 * classifier failure a retry cannot fix settles, with the kind recorded in
 * the judgement as the record.
 */
export function settledBackfillOutcome(judgement: SettledTurnJudgement): string {
  if (judgement.failureKind !== null && retryableClassifierFailure(judgement.failureKind)) {
    throw new Error(stableCode(`suggestion_backfill_classifier_unavailable_${judgement.failureKind}`));
  }
  if (judgement.outcome.startsWith(STEP_FAILED)) {
    throw new Error(stableCode(`suggestion_backfill_${judgement.outcome.slice(STEP_FAILED.length)}`));
  }
  return judgement.outcome;
}
