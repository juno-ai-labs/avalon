import { asWorkspaceId } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createMessageObjectPort } from "../runtime/message-port";
import { readMessage } from "../runtime/message-projection";
import { publishWorkstreamEvent } from "./integrations";

interface PrivacyTransitionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  note_id: string;
  resource_id: string;
  note_title: string;
  actor_user_id: string;
  created_at: string;
}

interface AffectedWorkstreamRow extends Record<string, unknown> {
  id: string;
}

/** Returns how many transitions the pass processed; the alarm reads it as progress. */
export async function processPendingNotePrivacyNotifications(
  env: Env,
  options: { noteId?: string } = {},
): Promise<number> {
  const filter = options.noteId ? "AND note_id = ?" : "";
  const bindings = options.noteId ? [options.noteId] : [];
  const pending = await env.DB.prepare(
    `SELECT * FROM note_privacy_change_outbox
     WHERE processed_at IS NULL ${filter}
     ORDER BY created_at ASC LIMIT 50`,
  ).bind(...bindings).all<PrivacyTransitionRow>();
  let processed = 0;
  for (const transition of pending.results) {
    await processTransition(env, transition);
    processed += 1;
  }
  return processed;
}

async function processTransition(env: Env, transition: PrivacyTransitionRow): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    transition.workspace_id,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(transition.workspace_id)),
  );
  const access = await workspace.resourceAccess({
    workspaceId: transition.workspace_id,
    resourceId: transition.resource_id,
    userId: transition.actor_user_id,
  });
  const subscriptionIds = [...new Set(access.items.flatMap((item) => (
    item.automationSubscriptionId ? [item.automationSubscriptionId] : []
  )))];
  const subscriptions = new Map<string, { scope: string; owner_user_id: string | null }>();
  if (subscriptionIds.length > 0) {
    const placeholders = subscriptionIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, scope, owner_user_id FROM automation_subscriptions
        WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(transition.workspace_id, ...subscriptionIds).all<{
      id: string;
      scope: string;
      owner_user_id: string | null;
    }>();
    for (const row of rows.results ?? []) subscriptions.set(row.id, row);
  }
  const affectedRows: AffectedWorkstreamRow[] = access.items.filter((item) => {
    if (!item.automationSubscriptionId) {
      return item.createdByUserId === null || item.createdByUserId !== transition.actor_user_id;
    }
    const subscription = subscriptions.get(item.automationSubscriptionId);
    return subscription?.scope === "workspace"
      || subscription?.owner_user_id === null
      || subscription?.owner_user_id !== transition.actor_user_id;
  }).map((item) => ({ id: item.workstreamId }));

  const clientMessageId = `note-privacy:${transition.id}`;
  const text = `${transition.note_title} is now private and no longer accessible`;
  for (const workstream of affectedRows) {
    const messages = createMessageObjectPort(env, transition.workspace_id, workstream.id);
    const appended = await messages.appendMessage({
      messageId: newId(),
      clientMessageId,
      authorType: "human",
      authorUserId: transition.actor_user_id,
      externalActorJson: null,
      messageType: "text",
      text,
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.now(),
    });
    // One notice per work stream per transition. The client message id is the
    // transition's, so a redelivered queue message finds the row it already
    // wrote and must not publish a second `message_created` for it.
    if (appended.outcome === "replayed") continue;
    const message = await readMessage(
      messages,
      { workspaceId: transition.workspace_id, workstreamId: workstream.id },
      clientMessageId,
    );
    if (message) {
      await publishWorkstreamEvent(env, transition.workspace_id, workstream.id, {
        type: "message_created",
        message,
      });
    }
  }

  await env.DB.prepare(
    `UPDATE note_privacy_change_outbox SET processed_at = ?
     WHERE id = ? AND processed_at IS NULL`,
  ).bind(nowIso(), transition.id).run();
}
