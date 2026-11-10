import { IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * What `write_artifact_data` asks WorkspaceDO before it changes a site's rows:
 * which artifact a resource is, which Canvas owns it, and whether that Canvas
 * is open and attached to the Sidekick whose run is writing.
 *
 * One local read. `artifact_registry`, `canvas_directory` and
 * `sidekick_conversation_attachments` all live in this object, so the whole
 * gate is one statement and one call. The attachment table is the only
 * Sidekick-to-Canvas edge read here; `canvas_directory.writer_sidekick_id` is
 * deliberately not consulted.
 *
 * It admits nobody by itself. The caller has already resolved the resource as
 * one the acting person can read, and decides from these facts
 * (`workstream-artifact-data-wiring.ts`); the rule is in
 * `docs/live-web-artifacts.md`.
 */
export const ArtifactDataWriteFactsRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  resourceId: IdSchema,
  /** The Sidekick whose run is writing, or null for a Canvas's Chat. */
  sidekickId: IdSchema.nullable(),
});
export type ArtifactDataWriteFactsRequest = z.input<typeof ArtifactDataWriteFactsRequestSchema>;

export interface ArtifactDataWriteFacts {
  artifactId: string;
  /** The Canvas the artifact belongs to: `artifact_registry.workstream_id`. */
  canvasId: string;
  mode: "static" | "active";
  stateful: boolean;
  /** That Canvas is archived. False for an owner this Organization holds no Canvas row for. */
  canvasArchived: boolean;
  /**
   * `sidekickId` has that Canvas's Chat attached, and the Canvas exists and is
   * not archived. Always false when no Sidekick was named.
   */
  attachedToSidekick: boolean;
}

/** The facts for one resource, or null when it is no registered artifact here. */
export function artifactDataWriteFacts(
  sql: SqlStorage,
  request: z.infer<typeof ArtifactDataWriteFactsRequestSchema>,
): ArtifactDataWriteFacts | null {
  const row = sql.exec<{
    artifact_id: string; workstream_id: string; mode: string; stateful: number; archived: number; attached: number;
  }>(
    `SELECT registry.artifact_id, registry.workstream_id, registry.mode, registry.stateful,
            canvas.archived_at IS NOT NULL AS archived,
            canvas.canvas_id IS NOT NULL AND canvas.archived_at IS NULL AND EXISTS (
              SELECT 1 FROM sidekick_conversation_attachments attachment
               WHERE attachment.automation_id = ? AND attachment.parent_kind = 'canvas'
                 AND attachment.parent_id = registry.workstream_id AND attachment.substream_id = '0'
            ) AS attached
       FROM artifact_registry registry
       LEFT JOIN canvas_directory canvas ON canvas.canvas_id = registry.workstream_id
      WHERE registry.workspace_id = ? AND registry.resource_id = ?`,
    request.sidekickId, request.workspaceId, request.resourceId,
  ).toArray()[0];
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    canvasId: row.workstream_id,
    mode: row.mode === "active" ? "active" : "static",
    stateful: row.stateful === 1,
    canvasArchived: row.archived === 1,
    attachedToSidekick: row.attached === 1,
  };
}
