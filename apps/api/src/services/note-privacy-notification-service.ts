import { asWorkspaceId } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceNotePrivacyMarkResultSchema,
  WorkspaceNotePrivacyPendingResultSchema,
  type WorkspaceNotePrivacyTransition,
} from "../durable-objects/workspace-notes-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createMessageObjectPort } from "../runtime/message-port";

function workspaceObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/** Returns how many transitions the pass processed; the alarm reads it as progress. */
export async function processPendingNotePrivacyNotifications(
  env: Env,
  options: { workspaceId: string; noteId?: string },
): Promise<number> {
  const pending = WorkspaceNotePrivacyPendingResultSchema.parse(
    await (await workspaceObject(env, options.workspaceId)).pendingNotePrivacyTransitions({
      workspaceId: options.workspaceId,
      ...(options.noteId === undefined ? {} : { noteId: options.noteId }),
    }),
  );
  let processed = 0;
  for (const transition of pending.items) {
    await processTransition(env, transition);
    processed += 1;
  }
  return processed;
}

async function processTransition(env: Env, transition: WorkspaceNotePrivacyTransition): Promise<void> {
  const workspace = await workspaceObject(env, transition.workspaceId);
  const access = await workspace.resourceAccess({
    workspaceId: transition.workspaceId,
    resourceId: transition.resourceId,
    userId: transition.actorUserId,
  });
  const affected = access.items.filter((item) => {
    // Generated work streams project the accepted automation's scope and
    // author into the same directory fields as ad-hoc work streams. Those are
    // the visibility facts needed here; consulting a second subscription
    // authority only duplicated them and could disagree after cutover.
    return item.scope === "workspace"
      || item.createdByUserId === null
      || item.createdByUserId !== transition.actorUserId;
  }).map((item) => item.workstreamId);

  const clientMessageId = `note-privacy:${transition.id}`;
  const text = `${transition.noteTitle} is now private and no longer accessible`;
  for (const workstreamId of affected) {
    const messages = createMessageObjectPort(env, transition.workspaceId, workstreamId);
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

  WorkspaceNotePrivacyMarkResultSchema.parse(
    await workspace.markNotePrivacyTransitionProcessed({
      workspaceId: transition.workspaceId,
      transitionId: transition.id,
      at: nowIso(),
    }),
  );
}
