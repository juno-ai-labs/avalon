import { asSubstreamId, asWorkspaceId } from "@rally/contracts";

import { conversationObjectName } from "../durable-objects/names";
import type { SettledTurnJudgement } from "../durable-objects/substream-agent";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * The one classifier failure the backfill settles on: without a
 * `TYPESAFE_API_KEY`, as locally, no retry would answer differently.
 */
const SETTLES_WITHOUT_RETRY = "typesafe_key_missing";

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

/**
 * A classifier failure is a failure, not an outcome (docs/thread-backfill.md):
 * thrown so the lane releases the row and sends it again, and the observer,
 * which keeps no answer for a failed judgement, asks again. The one exception
 * is a missing key, which a retry cannot fix.
 */
export function settledBackfillOutcome(judgement: SettledTurnJudgement): string {
  if (judgement.failureKind !== null && judgement.failureKind !== SETTLES_WITHOUT_RETRY) {
    // Shaped as a stable code, so `thread_backfill_failed` logs the kind
    // rather than its fallback (docs/naming-a-schema-failure.md).
    throw new Error(`suggestion_backfill_classifier_unavailable_${judgement.failureKind}`
      .toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 120));
  }
  return judgement.outcome;
}
