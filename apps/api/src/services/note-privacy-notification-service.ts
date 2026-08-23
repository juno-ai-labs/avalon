import { asWorkspaceId } from "@avalon/contracts";
import { createDatabase, newId, nowIso } from "@avalon/db";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { publishWorkstreamEvent } from "./integrations";
import { workstreamExecutionEnvironment } from "./workstream-runtime-database";

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
    const executionEnv = await workstreamExecutionEnvironment(
      env,
      transition.workspace_id,
      workstream.id,
    );
    const database = createDatabase(executionEnv.DB);
    const messageId = newId();
    const at = nowIso();
    const results = await executionEnv.DB.batch([
      executionEnv.DB.prepare(
        `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at)
         SELECT ?, ?, ?, w.id, 'human', ?, 'text', ?, NULL, w.next_sequence_number, ?
         FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
         ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
      ).bind(
        messageId,
        clientMessageId,
        transition.workspace_id,
        transition.actor_user_id,
        text,
        at,
        workstream.id,
        transition.workspace_id,
      ),
      executionEnv.DB.prepare(
        `UPDATE workstreams
         SET next_sequence_number = next_sequence_number + 1,
             latest_attention_sequence_number = next_sequence_number,
             last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, workstream.id, transition.workspace_id, messageId),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) === 0) continue;
    const message = await database.workstreams.getMessageByClientId(
      transition.workspace_id,
      workstream.id,
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
