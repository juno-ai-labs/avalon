import type { WorkspaceNotificationIntentDelivery } from "../durable-objects/workspace-notification-intent-protocol";
import { enqueueNotice } from "./push-delivery-service";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import {
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
} from "@rally/contracts/conversation-effects";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceDirectoryNotificationStateSchema } from "../durable-objects/workspace-directory-protocol";
import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "../durable-objects/workspace-notification-intent-protocol";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

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

/** Resolve current regional identity/delivery state and execute one intent. */
export async function notificationDeliveryContext(env: Env, row: WorkspaceNotificationIntentDelivery) {
  const typedWorkspaceId = asWorkspaceId(row.workspaceId);
  const workspaceId = row.workspaceId;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, typedWorkspaceId, workspaceDOName(env.AVALON_REGION, typedWorkspaceId));
  const identity = await workspaceRegionalDatabase(env).prepare(
    `SELECT user.email AS recipient_email, user.name AS recipient_name,
            workspace.name AS workspace_name
       FROM users user JOIN workspaces workspace ON workspace.id = ?
       JOIN workspace_members member ON member.workspace_id = workspace.id
        AND member.user_id = user.id AND member.status = 'active'
      WHERE user.id = ?`,
  ).bind(workspaceId, row.recipientUserId).first<NotificationRecipientIdentity>();
  if (!identity) return { outcome: "skipped" as const, reason: "recipient_inactive_or_identity_missing" };
  const payload: unknown = JSON.parse(row.payloadJson);
  const participantAdded = row.notificationKind === "participant_added";
  const effect = participantAdded
    ? WorkstreamParticipantNotificationEffectSchema.parse(payload)
    : WorkstreamMentionNotificationEffectSchema.parse(payload);
  const childId = effect.substreamId && effect.substreamId !== "0" ? effect.substreamId : null;
  if (childId) {
    const parent = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, typedWorkspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(typedWorkspaceId)));
    const access = await parent.authorizeViewer({ workspaceId: typedWorkspaceId, parentId: row.workstreamId,
      userId: asUserId(row.recipientUserId), substreamId: asSubstreamId(childId) });
    if (!access.authorized || access.archived) {
      return { outcome: "skipped" as const, reason: "access_revoked" };
    }
  }

  const rawDirectoryState = await workspace.notificationDirectoryState({
    workspaceId: row.workspaceId,
    workstreamId: row.workstreamId,
    userId: row.recipientUserId,
  });
  const viewer = rawDirectoryState
    ? WorkspaceDirectoryNotificationStateSchema.parse(rawDirectoryState)
    : null;
  // Neither a Canvas nor a Sidekick: a retired Thread's intent, which nobody can open.
  if (!viewer) return { outcome: "skipped" as const, reason: "notification_parent_missing" };
  // The parent was replaced after the effect was written: wait for this
  // object to hear of the generation the conversation spoke from.
  if (viewer.authorityGeneration < row.sourceGeneration) {
    return { outcome: "pending" as const, reason: "notification_parent_generation_pending", viewer };
  }
  if (!childId && !viewer.listable) return { outcome: "skipped" as const, reason: "recipient_not_listable" };
  const originator = effect.kind === "mention_notification" ? effect.authorUserId : effect.actorUserId;
  if (effect.recipientUserId === originator) return { outcome: "skipped" as const, reason: "self_notification" };
  return { outcome: "ready" as const, identity, effect, childId, viewer };
}

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
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome !== "ready") {
    if (context.outcome === "pending") {
      const transition = await transitionNotificationIntent(workspace, {
        workspaceId: typedWorkspaceId, intentId, leaseId, transition: "defer", errorCode: context.reason,
      });
      logInfo(env, "workstream_notification_deferred", {
        workspace_id: row.workspaceId, workstream_id: row.workstreamId, notification_intent_id: intentId,
        kind: row.notificationKind, recipient_user_id: row.recipientUserId,
        outcome: transition.outcome === "applied" ? "busy" : transition.outcome,
        reason: transition.outcome === "applied" ? context.reason : "notification_lease_lost_before_defer",
        required_generation: row.sourceGeneration, current_generation: context.viewer?.authorityGeneration ?? null,
        current_state: transition.outcome === "lease_lost" ? transition.state : null,
      });
      if (transition.outcome === "lease_lost" && (transition.state === "delivered" || transition.state === "skipped")) return transition.state;
    } else {
      await requireNotificationIntentTransition(workspace, { workspaceId: typedWorkspaceId, intentId, leaseId, transition: "settle", state: "skipped" });
    }
    if (context.outcome === "skipped") logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId, workstream_id: row.workstreamId, notification_intent_id: intentId,
      kind: row.notificationKind, recipient_user_id: row.recipientUserId, outcome: "skipped", reason: context.reason,
    });
    return context.outcome === "pending" ? "busy" : "skipped";
  }
  const { effect } = context;
  try {
    // Each sink the person chose for this kind, and only those; the notice
    // is rendered once, by the consumer, for whichever sink takes it.
    // Nothing falls back to another: an empty choice means Activity alone.
    const preferences = await workspace.memberPreferences({ workspaceId: typedWorkspaceId, userId: row.recipientUserId });
    const channels = preferences.notify[row.notificationKind === "participant_added" ? "added" : "mentions"];
    const queued = await enqueueNotice(env, { workspaceId: row.workspaceId, recipientUserId: row.recipientUserId, intentId }, channels);
    const sourceId = effect.kind === "participant_notification" ? effect.sourceId : effect.messageId;
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "delivered",
      // The sinks read the notice back from the intent.
      retainPayload: queued,
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      source_id: sourceId,
      recipient_user_id: effect.recipientUserId,
      outcome: "delivered",
      reason: channels.length ? "chosen_channels_queued" : "no_channel_chosen",
      channels: channels.join(","),
      queued,
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
