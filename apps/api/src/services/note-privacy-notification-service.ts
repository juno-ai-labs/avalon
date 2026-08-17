import { createDatabase, newId, nowIso } from "@avalon/db";
import type { Env } from "../env";
import { publishWorkstreamEvent } from "./integrations";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
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

export async function processPendingNotePrivacyNotifications(
  env: Env,
  options: { noteId?: string } = {},
): Promise<void> {
  const filter = options.noteId ? "AND note_id = ?" : "";
  const bindings = options.noteId ? [options.noteId] : [];
  const pending = await env.DB.prepare(
    `SELECT * FROM note_privacy_change_outbox
     WHERE processed_at IS NULL ${filter}
     ORDER BY created_at ASC LIMIT 50`,
  ).bind(...bindings).all<PrivacyTransitionRow>();
  for (const transition of pending.results) {
    await processTransition(env, transition);
  }
}

async function processTransition(env: Env, transition: PrivacyTransitionRow): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  const affected = await env.DB.prepare(authority.phase === "durable_object_open"
    ? `SELECT DISTINCT link.workstream_id AS id
       FROM workstream_resource_link_projections link
       JOIN workstream_directory_projections w ON w.workstream_id = link.workstream_id
       LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
      WHERE link.workspace_id = ? AND link.resource_id = ?
        AND (
          (s.id IS NOT NULL AND (s.scope = 'workspace' OR s.owner_user_id IS NULL OR s.owner_user_id != ?))
          OR
          (s.id IS NULL AND (w.created_by_user_id IS NULL OR w.created_by_user_id != ?))
        )
      ORDER BY link.workstream_id ASC`
    : `SELECT DISTINCT w.id
     FROM workstream_resources wr
     JOIN workstreams w ON w.id = wr.workstream_id AND w.workspace_id = ?
     LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
     WHERE wr.resource_id = ?
       AND (
         (s.id IS NOT NULL AND (s.scope = 'workspace' OR s.owner_user_id IS NULL OR s.owner_user_id != ?))
         OR
         (s.id IS NULL AND (w.created_by_user_id IS NULL OR w.created_by_user_id != ?))
       )
     ORDER BY w.id ASC`)
    .bind(
    transition.workspace_id,
    transition.resource_id,
    transition.actor_user_id,
    transition.actor_user_id,
  ).all<AffectedWorkstreamRow>();

  const clientMessageId = `note-privacy:${transition.id}`;
  const text = `${transition.note_title} is now private and no longer accessible`;
  for (const workstream of affected.results) {
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
