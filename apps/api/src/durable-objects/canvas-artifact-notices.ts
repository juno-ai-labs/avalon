import type { CanvasEditor } from "@rally/contracts/canvases";
import { truncateUtf16Safe } from "@rally/contracts/text";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logInfo } from "../observability/logger";
import { enqueuePushDelivery } from "../services/push-delivery-service";
import type { NoteActivity } from "./workspace-activity";
import type { ParentNotice } from "./workspace-notification-intent-protocol";
import { recordParentNotice } from "./workspace-notification-intent-storage";
import { isArtifactNewsCause } from "./workspace-pin-storage";
import { NAME_SNAPSHOT_CHARACTERS } from "./canvas-access-requests";

/** What telling a Canvas's pinners needs from the Organization object that holds it. */
export interface CanvasArtifactNoticeHost {
  env: Env;
  storage: DurableObjectStorage;
  noteActivityChanged: NoteActivity;
}

interface VersionRow extends Record<string, SqlStorageValue> {
  version: number;
  cause: string | null;
  author_kind: string | null;
  author_user_id: string | null;
  author_connection_id: string | null;
  on_behalf_of_user_id: string | null;
}

/**
 * Who made a version, as Activity and the push name them. A member's version
 * is that person; a connector's is named by its connection; an agent's or the
 * system's is whoever the publish says edited the Canvas — Rally for its
 * Chat, the Sidekick for a run — as the version history calls it Rally.
 */
async function versionAuthor(env: Env, sql: SqlStorage, workspaceId: string, version: VersionRow, editor: CanvasEditor):
  Promise<{ kind: "person" | "rally" | "sidekick"; id: string | null; name: string }> {
  if (version.author_kind === "member" && version.author_user_id) {
    const person = await env.DB.prepare(
      `SELECT person.name FROM users person JOIN workspace_members member ON member.user_id = person.id AND member.workspace_id = ?
        WHERE person.id = ?`,
    ).bind(workspaceId, version.author_user_id).first<{ name: string | null }>();
    return { kind: "person", id: version.author_user_id, name: truncateUtf16Safe(person?.name || "Someone", NAME_SNAPSHOT_CHARACTERS) };
  }
  if (version.author_kind === "connector" && version.author_connection_id) {
    const connection = await env.DB.prepare(`SELECT display_name AS name FROM connector_connections WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, version.author_connection_id).first<{ name: string | null }>();
    return { kind: "rally", id: null, name: truncateUtf16Safe(connection?.name || "A connection", NAME_SNAPSHOT_CHARACTERS) };
  }
  if (editor.kind === "sidekick" && editor.id) {
    const sidekick = sql.exec<{ title: string }>(`SELECT title FROM automation_directory WHERE automation_id = ?`, editor.id).toArray()[0];
    return { kind: "sidekick", id: editor.id, name: truncateUtf16Safe(sidekick?.title || "A Sidekick", NAME_SNAPSHOT_CHARACTERS) };
  }
  return { kind: "rally", id: null, name: "Rally" };
}

/**
 * A new version of one of a Canvas's artifacts tells everyone who pinned the
 * Canvas, but not whoever made it or had it made: one `artifact_updated`
 * intent and Activity row each, the row collapsing to one per Canvas while it
 * is unseen. Which versions are news is the rule a pinned artifact's unread
 * uses (`artifactNewsSql`: version 2 on, a republish or a replacement), read
 * from the resource's newest version when its publish notes the Canvas. A
 * publish noted twice (a recovered one) records nothing twice and enqueues
 * again, which the push receipts make harmless. `docs/canvases.md` owns it.
 */
export async function tellCanvasPinners(host: CanvasArtifactNoticeHost, input: {
  workspaceId: string; canvasId: string; canvasTitle: string; generation: number; resourceId: string; editor: CanvasEditor;
}): Promise<void> {
  const sql = host.storage.sql;
  const version = sql.exec<VersionRow>(
    `SELECT version, cause, author_kind, author_user_id, author_connection_id, on_behalf_of_user_id
       FROM resource_versions WHERE resource_id = ? ORDER BY version DESC LIMIT 1`, input.resourceId,
  ).toArray()[0];
  if (!version || version.version <= 1 || !isArtifactNewsCause(version.cause)) return;
  const pinners = sql.exec<{ user_id: string }>(
    `SELECT user_id FROM workspace_pins WHERE item_kind = 'canvas' AND item_id = ? AND user_id IS NOT ? AND user_id IS NOT ?`,
    input.canvasId, version.author_user_id, version.on_behalf_of_user_id,
  ).toArray().map((row) => row.user_id);
  if (pinners.length === 0) return;
  const artifactTitle = sql.exec<{ title: string }>(`SELECT title FROM resources WHERE id = ?`, input.resourceId).toArray()[0]?.title ?? "an artifact";
  const author = await versionAuthor(host.env, sql, input.workspaceId, version, input.editor);
  const notice: ParentNotice = {
    kind: "artifact_updated", parentId: input.canvasId, parentTitle: input.canvasTitle, resourceId: input.resourceId,
    artifactTitle, authorName: author.name,
  };
  const payloadJson = JSON.stringify(notice);
  const payloadHash = await sha256(payloadJson);
  const sourceId = `artifact_updated:${input.resourceId}:${version.version}`;
  const now = Date.now();
  const recorded = host.storage.transactionSync(() => pinners.map((recipientUserId) => ({
    recipientUserId,
    ...recordParentNotice(host.storage, {
      workspaceId: input.workspaceId, parentId: input.canvasId, generation: input.generation, kind: "artifact_updated",
      recipientUserId, intentId: `${sourceId}:${recipientUserId}`, sourceId, payloadJson, payloadHash, skipCode: null, collapse: true,
      activity: {
        parentKind: "canvas", parentId: input.canvasId, substreamId: "0", messageId: null, runId: null,
        actorKind: author.kind, actorId: author.id, text: null, subjectId: input.resourceId,
      },
    }, now, host.noteActivityChanged),
  })));
  for (const intent of recorded) {
    if (!intent.push) continue;
    await enqueuePushDelivery(host.env, {
      region: host.env.AVALON_REGION, workspaceId: input.workspaceId, recipientUserId: intent.recipientUserId, intentId: intent.intentId,
    });
  }
  logInfo(host.env, "canvas_artifact_notice_recorded", { canvas_id: input.canvasId, resource_id: input.resourceId,
    version: version.version, recipients: recorded.length });
}
