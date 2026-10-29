import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { SidekickReviewQueueMessage } from "../durable-objects/automation-do-protocol";
import type { SidekickReviewDelivery } from "../durable-objects/hosted-sidekick";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { sidekickReviewText } from "./sidekick-review-notice";

/**
 * Wake a hosted Sidekick's wizard with a scheduled self-review.
 *
 * The Organization object hands each requested review here on the activity
 * Queue rather than awaiting the wizard from its own alarm, exactly as it
 * hands a run to provisioning. Every step is idempotent, so a redelivery or a
 * re-send admits nothing twice: the notice's client message id is the review
 * id, the conversation answers a repeat with the turn it already holds, and
 * the report to the Organization is a no-op once recorded. See
 * `HostedSidekick.startReview`.
 */
export async function deliverSidekickReview(env: Env, message: SidekickReviewQueueMessage): Promise<void> {
  const workspaceId = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const address = { workspaceId, automationId: message.automationId, reviewId: message.reviewId };
  // Typed here: the notice's shape is opaque to the RPC type mapping.
  const delivery = await workspace.sidekickReviewDelivery(address) as SidekickReviewDelivery | null;
  // Delivered already, abandoned, or the Sidekick is no longer active.
  if (!delivery) return;
  const now = Date.now();
  const wizard = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, workspaceId,
    conversationObjectName(delivery.region, workspaceId, delivery.automationId, asSubstreamId("0")));
  const admitted = await wizard.admitSidekickReview({
    workspaceId,
    workstreamId: asWorkstreamId(delivery.automationId),
    messageId: uuidV7(now),
    clientMessageId: `sidekick-review:${delivery.reviewId}`,
    text: sidekickReviewText(delivery.notice),
    review: delivery.notice,
    executionPrincipal: { type: "user", userId: asUserId(delivery.coordinatorUserId) },
    origin: "sidekick_review",
    now,
  });
  // One stable code, so the consumer's log names the refusal rather than its fallback.
  if (!admitted.accepted) throw new Error(`sidekick_review_refused_${admitted.code}`);
  await workspace.sidekickReviewDelivered(address);
}
