import { asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import {
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectQueueMessageSchema,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffectEnvelope,
  type WorkstreamRegionalEffectQueueMessage,
} from "../durable-objects/workstream-regional-effect";
import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import {
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceRegionalEffectApplyResultSchema,
} from "../durable-objects/workspace-directory-protocol";
import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "../durable-objects/workspace-notification-intent-protocol";
import { sendWorkstreamMentionEmail } from "./mention-email-service";
import { sendWorkstreamParticipantAddedEmail } from "./participant-email-service";
import {
  sendWorkstreamMentionSlack,
  sendWorkstreamParticipantAddedSlack,
} from "./slack-notification-service";
import { enqueueMentionOpportunitySnapshot } from "./work-opportunity-batching";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

function workspaceTopicsForEffect(
  effect: WorkstreamRegionalEffectEnvelope["effect"],
) {
  if (effect.kind === "activity_event") {
    return ["activity", "work_opportunities"] as const;
  }
  return ["activity", "workstream_directory"] as const;
}

interface NotificationRecipientIdentity {
  recipient_email: string;
  recipient_name: string;
  workspace_name: string;
}

interface NotificationIntentTransitionPort {
  transitionWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentTransitionRequest,
  ): Promise<unknown>;
}

export interface WorkstreamRegionalEffectResult {
  replayed: boolean;
  notificationIntentId: string | null;
}

export function isWorkspaceDirectoryEffect(
  effect: WorkstreamRegionalEffectEnvelope["effect"],
): effect is Extract<WorkstreamRegionalEffectEnvelope["effect"], {
  kind: "directory_common" | "directory_user" | "suggestion_feedback";
}> {
  return effect.kind === "directory_common"
    || effect.kind === "directory_user"
    || effect.kind === "suggestion_feedback";
}

/** Apply one unordered, at-least-once Queue delivery to WorkspaceDO. */
export async function applyQueuedWorkspaceDirectoryEffect(
  env: Env,
  input: WorkstreamRegionalEffectEnvelope,
): Promise<void> {
  const message = WorkstreamRegionalEffectEnvelopeSchema.parse(input);
  if (!isWorkspaceDirectoryEffect(message.effect)) {
    throw new Error("non_workspace_effect_misdirected_to_workspace_do");
  }
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    message.workspaceId,
    workspaceDOName(message.region, message.workspaceId),
  );
  const result = WorkspaceDirectoryApplyResultSchema.parse(
    await workspace.applyWorkstreamDirectoryEffects({
      workspaceId: message.workspaceId,
      envelopes: [message],
    }),
  );
  if (result.accepted.length !== 1
    || result.accepted[0]?.messageId !== message.messageId
    || result.accepted[0]?.payloadHash !== message.payloadHash) {
    throw new Error("workspace_directory_effect_ack_incomplete");
  }
}

/**
 * Apply one WorkstreamDO activity/mention effect to the regional delivery plane.
 * Product state commits idempotently in WorkspaceDO before the thin D1 Queue
 * receipt; a crash between those authorities retries the same event or intent
 * identity. Directory effects never enter here.
 */
export async function applyWorkstreamRegionalEffect(
  env: Env,
  input: WorkstreamRegionalEffectEnvelope,
): Promise<WorkstreamRegionalEffectResult> {
  const message = WorkstreamRegionalEffectEnvelopeSchema.parse(input);
  if (message.region !== env.AVALON_REGION) throw new Error("workstream_effect_region_mismatch");
  if (
    workstreamRegionalEffectHash(message.effect, message.requiredProjectionVersion)
    !== message.payloadHash
  ) {
    throw new Error("workstream_effect_payload_hash_mismatch");
  }
  if (
    message.effect.kind === "directory_common"
    || message.effect.kind === "directory_user"
    || message.effect.kind === "suggestion_feedback"
  ) {
    throw new Error("workspace_owned_effect_misdirected_to_regional_queue");
  }

  const route = await env.DB.prepare(
    `SELECT generation, state FROM workstream_authority_routes
      WHERE workspace_id = ? AND workstream_id = ?`,
  ).bind(message.workspaceId, message.workstreamId).first<{ generation: number; state: string }>();
  if (route?.state === "active" && route.generation > message.generation) {
    // A previous authority generation can still have Queue messages in flight.
    // Its state was superseded at cutover, so acknowledging it is the only
    // terminal and safe outcome; applying it would regress the current owner.
    logInfo(env, "workstream_regional_effect_apply_terminal", {
      workspace_id: message.workspaceId,
      workstream_id: message.workstreamId,
      message_id: message.messageId,
      effect_kind: message.effect.kind,
      outcome: "skipped",
      reason: "authority_generation_superseded",
      message_generation: message.generation,
      active_generation: route.generation,
    });
    return { replayed: true, notificationIntentId: null };
  }
  if (route?.state !== "active" || route.generation !== message.generation) {
    throw new Error("workstream_effect_route_not_active");
  }

  // Current regional identity crosses into the object as data: the actor and
  // targets that still exist, and whether the mention recipient is still an
  // active member. The object commits the product row and its replay receipt
  // in one transaction — invariant 14's "effect and receipt together" — so
  // there is no longer a regional D1 receipt that can disagree with it. A
  // same-source re-emission under a new message ID converges on the product
  // identities (event dedupe key, intent identity) instead of a receipt row.
  let actorUserId: string | null = null;
  let targetUserIds: string[] = [];
  let recipientIsActiveMember = false;
  if (message.effect.kind === "activity_event") {
    const effect = message.effect;
    const currentActor = effect.actorUserId
      ? await env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
        .bind(effect.actorUserId).first<{ id: string }>()
      : null;
    actorUserId = currentActor?.id ?? null;
    if (effect.targets.length > 0) {
      const placeholders = effect.targets.map(() => "?").join(",");
      const users = await env.DB.prepare(
        `SELECT id FROM users WHERE id IN (${placeholders})`,
      ).bind(...effect.targets.map((target) => target.userId)).all<{ id: string }>();
      targetUserIds = (users.results ?? []).map((user) => user.id);
    }
  } else {
    const activeMember = await env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(message.workspaceId, message.effect.recipientUserId).first();
    recipientIsActiveMember = Boolean(activeMember);
  }

  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    message.workspaceId,
    workspaceDOName(message.region, message.workspaceId),
  );
  const applied = WorkspaceRegionalEffectApplyResultSchema.parse(
    await workspace.applyWorkstreamRegionalEffect({
      workspaceId: message.workspaceId,
      envelope: message,
      actorUserId,
      targetUserIds,
      recipientIsActiveMember,
    }),
  );

  if (message.effect.kind !== "activity_event" && !applied.notificationIntentId) {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: message.workspaceId,
      workstream_id: message.workstreamId,
      message_id: message.messageId,
      kind: message.effect.kind,
      recipient_user_id: message.effect.recipientUserId,
      outcome: "skipped",
      reason: recipientIsActiveMember ? "notification_intent_not_created" : "recipient_inactive",
      replayed: applied.replayed,
    });
  }

  if (
    message.effect.kind === "activity_event"
    && message.effect.sourceKind === "workstream_message"
    && message.effect.sourceId
    && targetUserIds.length > 0
  ) {
    // Deliberately runs on replayed deliveries too. The receipt now commits
    // atomically with the event, so a crash between that commit and this
    // enqueue is repaired only by the redelivery; the batch-event unique key
    // makes a repeated enqueue converge.
    await enqueueMentionOpportunitySnapshot(env, {
      workspaceId: message.workspaceId,
      messageId: message.effect.sourceId,
      targetUserIds,
      occurredAt: message.effect.occurredAt,
      inputCharacters: message.effect.body.length,
    });
  }
  await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
  return {
    replayed: applied.replayed,
    notificationIntentId: applied.notificationIntentId,
  };
}

/** Resolve current regional identity/delivery state and execute one intent. */
export async function processWorkstreamNotificationIntent(
  env: Env,
  workspaceId: string,
  intentId: string,
): Promise<"delivered" | "skipped" | "busy"> {
  const typedWorkspaceId = asWorkspaceId(workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    typedWorkspaceId,
    workspaceDOName(env.AVALON_REGION, typedWorkspaceId),
  );
  const claim = WorkspaceNotificationIntentClaimResultSchema.parse(
    await workspace.claimWorkstreamNotificationIntent({ workspaceId: typedWorkspaceId, intentId }),
  );
  if (claim.outcome === "missing") {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId,
      notification_intent_id: intentId,
      outcome: "skipped",
      reason: "notification_intent_missing",
    });
    return "skipped";
  }
  if (claim.outcome === "terminal") {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId,
      workstream_id: claim.intent.workstreamId,
      notification_intent_id: intentId,
      kind: claim.intent.notificationKind,
      recipient_user_id: claim.intent.recipientUserId,
      outcome: claim.intent.state,
      reason: claim.intent.state === "delivered"
        ? "notification_already_delivered"
        : "notification_already_skipped",
      replayed: true,
    });
    return claim.intent.state;
  }
  if (claim.outcome === "busy") {
    logInfo(env, "workstream_notification_deferred", {
      workspace_id: workspaceId,
      workstream_id: claim.intent.workstreamId,
      notification_intent_id: intentId,
      kind: claim.intent.notificationKind,
      recipient_user_id: claim.intent.recipientUserId,
      outcome: "busy",
      reason: "notification_lease_active",
      state: claim.intent.state,
    });
    return "busy";
  }

  const row = claim.intent;
  const leaseId = claim.leaseId;
  const identity = await workspaceRegionalDatabase(env).prepare(
    `SELECT user.email AS recipient_email, user.name AS recipient_name,
            workspace.name AS workspace_name
       FROM users user JOIN workspaces workspace ON workspace.id = ?
       JOIN workspace_members member ON member.workspace_id = workspace.id
        AND member.user_id = user.id AND member.status = 'active'
      WHERE user.id = ?`,
  ).bind(workspaceId, row.recipientUserId).first<NotificationRecipientIdentity>();
  if (!identity) {
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "skipped",
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: row.recipientUserId,
      outcome: "skipped",
      reason: "recipient_inactive_or_identity_missing",
    });
    return "skipped";
  }

  const rawDirectoryState = await workspace.notificationDirectoryState({
    workspaceId: row.workspaceId,
    workstreamId: row.workstreamId,
    userId: row.recipientUserId,
  });
  const viewer = rawDirectoryState
    ? WorkspaceDirectoryNotificationStateSchema.parse(rawDirectoryState)
    : null;
  if (
    !viewer
    || viewer.authorityGeneration < row.sourceGeneration
    || (
      viewer.authorityGeneration === row.sourceGeneration
      && viewer.viewerVersion < row.requiredDirectoryVersion
    )
  ) {
    const transition = await transitionNotificationIntent(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "defer",
      errorCode: "directory_projection_pending",
    });
    logInfo(env, "workstream_notification_deferred", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: row.recipientUserId,
      outcome: transition.outcome === "applied" ? "busy" : transition.outcome,
      reason: transition.outcome === "applied"
        ? "directory_projection_pending"
        : "notification_lease_lost_before_defer",
      required_generation: row.sourceGeneration,
      current_generation: viewer?.authorityGeneration ?? null,
      required_directory_version: row.requiredDirectoryVersion,
      current_directory_version: viewer?.viewerVersion ?? null,
      current_state: transition.outcome === "lease_lost" ? transition.state : null,
    });
    if (transition.outcome === "lease_lost" && transition.state === "delivered") return "delivered";
    if (transition.outcome === "lease_lost" && transition.state === "skipped") return "skipped";
    return "busy";
  }
  if (!viewer.listable) {
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "skipped",
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: row.recipientUserId,
      outcome: "skipped",
      reason: "recipient_not_listable",
    });
    return "skipped";
  }

  const payload: unknown = JSON.parse(row.payloadJson);
  const participantAdded = row.notificationKind === "participant_added";
  const effect = participantAdded
    ? WorkstreamParticipantNotificationEffectSchema.parse(payload)
    : WorkstreamMentionNotificationEffectSchema.parse(payload);
  // Nobody is told about their own doing, whichever kind this is: a person who
  // mentions themselves, or who adds themselves on the way to making a work
  // stream personal, already knows.
  const originatorUserId = effect.kind === "mention_notification"
    ? effect.authorUserId
    : effect.actorUserId;
  if (effect.recipientUserId === originatorUserId) {
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "skipped",
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: effect.recipientUserId,
      outcome: "skipped",
      reason: "self_notification",
    });
    return "skipped";
  }
  try {
    // Both kinds try Slack first and fall back to email, because a linked
    // member reads Slack and an unlinked one has only an inbox. The two are
    // sequenced rather than fanned out so nobody is told twice.
    const recipient = {
      recipientUserId: effect.recipientUserId,
      recipientEmail: identity.recipient_email,
      workspaceId: row.workspaceId,
      workspaceName: identity.workspace_name,
      workstreamId: row.workstreamId,
      workstreamTitle: effect.workstreamTitleSnapshot,
    };
    const sourceId = effect.kind === "participant_notification" ? effect.sourceId : effect.messageId;
    const slack = effect.kind === "participant_notification"
      ? await sendWorkstreamParticipantAddedSlack(env, {
        ...recipient,
        sourceId: effect.sourceId,
        actorName: effect.actorNameSnapshot,
        workstreamObjective: effect.workstreamObjectiveSnapshot,
        titleIsProvisional: effect.titleIsProvisional,
      })
      : await sendWorkstreamMentionSlack(env, {
        ...recipient,
        messageId: effect.messageId,
        authorName: effect.authorNameSnapshot,
        messageText: effect.messageText,
      });
    logInfo(env, "workstream_notification_transport_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      source_id: sourceId,
      recipient_user_id: effect.recipientUserId,
      channel: "slack",
      outcome: slack,
      reason: slack === "sent" ? "provider_accepted" : "fallback_required",
    });
    let email: "sent" | "skipped" | null = null;
    if (slack !== "sent") {
      const fallback = {
        ...recipient,
        recipientName: identity.recipient_name,
        workstreamEmailAddress: viewer.emailAddress,
        region: env.AVALON_REGION,
      };
      if (effect.kind === "participant_notification") {
        email = await sendWorkstreamParticipantAddedEmail(env, {
          ...fallback,
          sourceId: effect.sourceId,
          actorName: effect.actorNameSnapshot,
          workstreamObjective: effect.workstreamObjectiveSnapshot,
          titleIsProvisional: effect.titleIsProvisional,
        });
      } else {
        email = await sendWorkstreamMentionEmail(env, {
          ...fallback,
          messageId: effect.messageId,
          authorName: effect.authorNameSnapshot,
          messageText: effect.messageText,
        });
      }
      logInfo(env, "workstream_notification_transport_terminal", {
        workspace_id: row.workspaceId,
        workstream_id: row.workstreamId,
        notification_intent_id: intentId,
        kind: row.notificationKind,
        source_id: sourceId,
        recipient_user_id: effect.recipientUserId,
        channel: "email",
        outcome: email,
        reason: email === "sent" ? "provider_accepted" : "transport_disabled_for_environment",
      });
    }
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "delivered",
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      source_id: sourceId,
      recipient_user_id: effect.recipientUserId,
      outcome: "delivered",
      reason: slack === "sent" ? "slack_sent" : "email_fallback_completed",
      delivery_channel: slack === "sent" ? "slack" : "email",
      slack_outcome: slack,
      email_outcome: email,
    });
    return "delivered";
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "notification_delivery_failed";
    const transition = await transitionNotificationIntent(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "fail",
      errorCode: code,
    });
    logWarn(env, "workstream_notification_failed", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: row.recipientUserId,
      outcome: "failed",
      reason: code,
      error_name: error instanceof Error ? error.name : "Error",
      transition_outcome: transition.outcome,
      current_state: transition.outcome === "lease_lost" ? transition.state : null,
    });
    throw error;
  }
}

async function transitionNotificationIntent(
  workspace: NotificationIntentTransitionPort,
  input: WorkspaceNotificationIntentTransitionRequest,
): Promise<WorkspaceNotificationIntentTransitionResult> {
  return WorkspaceNotificationIntentTransitionResultSchema.parse(
    await workspace.transitionWorkstreamNotificationIntent(input),
  );
}

async function requireNotificationIntentTransition(
  workspace: NotificationIntentTransitionPort,
  input: WorkspaceNotificationIntentTransitionRequest,
): Promise<void> {
  const result = await transitionNotificationIntent(workspace, input);
  if (result.outcome === "applied") return;
  if (
    input.transition === "settle"
    && result.outcome === "lease_lost"
    && result.state === input.state
  ) return;
  throw new Error(`workstream_notification_transition_not_applied:${result.outcome}`);
}

/** Remove an acknowledged DO outbox row; the replay receipt stays in WorkspaceDO. */
export async function acknowledgeWorkstreamOutboxEffect(
  env: Env,
  message: WorkstreamRegionalEffectEnvelope,
): Promise<void> {
  const objectName = workstreamDOName(message.region, message.workspaceId, message.workstreamId);
  const workstream = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    message.workspaceId,
    objectName,
  );
  const removed = await workstream.acknowledgeRegionalEffect({
    messageId: message.messageId,
    payloadHash: message.payloadHash,
  });
  logInfo(env, "workstream_outbox_acknowledged", {
    workspace_id: message.workspaceId,
    workstream_id: message.workstreamId,
    message_id: message.messageId,
    effect_kind: message.effect.kind,
    removed,
    outcome: removed ? "deleted" : "already_absent",
  });
}

export async function loadWorkstreamRegionalEffect(
  env: Env,
  input: WorkstreamRegionalEffectQueueMessage,
): Promise<WorkstreamRegionalEffectEnvelope | null> {
  const wake = WorkstreamRegionalEffectQueueMessageSchema.parse(input);
  const objectName = workstreamDOName(wake.region, wake.workspaceId, wake.workstreamId);
  const workstream = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    wake.workspaceId,
    objectName,
  );
  const loaded = await workstream.loadRegionalEffect({
    messageId: wake.messageId,
    payloadHash: wake.payloadHash,
  });
  // A prior acknowledgement may have removed this row after a duplicate
  // wake-up was queued. There is nothing left for this delivery to do, and
  // retrying it cannot recreate an acknowledged row.
  if (!loaded) return null;
  const envelope = WorkstreamRegionalEffectEnvelopeSchema.parse(loaded);
  if (
    envelope.region !== wake.region
    || envelope.workspaceId !== wake.workspaceId
    || envelope.workstreamId !== wake.workstreamId
    || envelope.generation !== wake.generation
    || envelope.messageId !== wake.messageId
    || envelope.payloadHash !== wake.payloadHash
  ) throw new Error("workstream_effect_fetch_identity_mismatch");
  return envelope;
}
