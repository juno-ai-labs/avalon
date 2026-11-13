import {
  CanvasSharingDefaultsSchema,
  CanvasSharingDefaultsUpdateSchema,
  DEFAULT_CANVAS_SHARING_DEFAULTS,
  type CanvasSharingDefaults,
} from "@rally/contracts/canvases";
import { WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The audiences a new Canvas starts with, held by the Organization's
 * WorkspaceDO beside the Canvases it makes, so `HostedCanvas.create` reads
 * them inside its own transaction with no round trip. One row at most;
 * absent means every default, so an Organization that never chose follows a
 * later change to `DEFAULT_CANVAS_SHARING_DEFAULTS`. `docs/canvases.md`.
 */
export const CANVAS_SHARING_DEFAULTS_STATEMENTS: readonly string[] = [
  `CREATE TABLE canvas_sharing_defaults (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    editors TEXT CHECK (editors IN ('creator', 'workspace')),
    artifacts TEXT CHECK (artifacts IN ('editors', 'workspace', 'public')),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * The stored choices over the defaults. A null column was never chosen and
 * reads as its default, so saving one setting does not pin the other.
 */
export function readCanvasSharingDefaults(sql: SqlStorage): CanvasSharingDefaults {
  const row = sql.exec<{ editors: string | null; artifacts: string | null }>(
    `SELECT editors, artifacts FROM canvas_sharing_defaults WHERE id = 1`,
  ).toArray()[0];
  return CanvasSharingDefaultsSchema.parse({
    editors: row?.editors ?? DEFAULT_CANVAS_SHARING_DEFAULTS.editors,
    artifacts: row?.artifacts ?? DEFAULT_CANVAS_SHARING_DEFAULTS.artifacts,
  });
}

/** Save the fields given; a field left out keeps what is stored. Answers with the whole record. */
export function saveCanvasSharingDefaults(
  sql: SqlStorage,
  update: z.infer<typeof CanvasSharingDefaultsUpdateSchema>,
  now: number,
): CanvasSharingDefaults {
  sql.exec(
    `INSERT INTO canvas_sharing_defaults (id, editors, artifacts, updated_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET editors = COALESCE(?1, editors), artifacts = COALESCE(?2, artifacts),
       updated_at = ?3`,
    update.editors ?? null, update.artifacts ?? null, now,
  );
  return readCanvasSharingDefaults(sql);
}

export const CanvasSharingDefaultsReadRequestSchema = z.strictObject({ workspaceId: WorkspaceIdSchema });
export type CanvasSharingDefaultsReadRequest = z.infer<typeof CanvasSharingDefaultsReadRequestSchema>;
export const CanvasSharingDefaultsWriteRequestSchema = CanvasSharingDefaultsReadRequestSchema.extend({
  defaults: CanvasSharingDefaultsUpdateSchema,
});
export type CanvasSharingDefaultsWriteRequest = z.infer<typeof CanvasSharingDefaultsWriteRequestSchema>;
