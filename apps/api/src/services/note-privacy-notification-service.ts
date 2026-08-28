import { asWorkspaceId } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createMessageObjectPort } from "../runtime/message-port";

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
  const affectedRows: AffectedWorkstreamRow[] = access.items.filter((item) => {
    // Generated work streams project the accepted automation's scope and
    // author into the same directory fields as ad-hoc work streams. Those are
    // the visibility facts needed here; consulting a second subscription
    // authority only duplicated them and could disagree after cutover.
    return item.scope === "workspace"
      || item.createdByUserId === null
      || item.createdByUserId !== transition.actor_user_id;
  }).map((item) => ({ id: item.workstreamId }));

  const clientMessageId = `note-privacy:${transition.id}`;
  const text = `${transition.note_title} is now private and no longer accessible`;
  for (const workstream of affectedRows) {
    const messages = createMessageObjectPort(env, transition.workspace_id, workstream.id);
    await messages.appendMessage({
      messageId: newId(),
      clientMessageId,
      // This is a product-generated access notice, not a statement authored by
      // the person who changed the note. Treating it as human also bypassed the
      // immutable profile snapshot required for real participant messages.
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "text",
      text,
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.now(),
    });
  }

  await env.DB.prepare(
    `UPDATE note_privacy_change_outbox SET processed_at = ?
     WHERE id = ? AND processed_at IS NULL`,
  ).bind(nowIso(), transition.id).run();
}
