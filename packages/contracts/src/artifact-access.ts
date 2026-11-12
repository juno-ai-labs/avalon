import { z } from 'zod';
import { RegionSchema } from './regions';
import { HttpUrlSchema } from './url-schemas';
import { IdSchema, UserIdSchema, WorkspaceIdSchema } from './identifiers';

export const CanvasArtifactVisibilitySchema = z.enum(['editors', 'participants', 'workspace', 'public']);

/** A complete, replaceable projection. Only the owning Canvas produces revisions. */
export const ArtifactAccessSnapshotSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  canvasId: IdSchema,
  revision: z.number().int().positive(),
  public: z.boolean(),
  archived: z.boolean(),
  users: z.array(z.strictObject({ userId: UserIdSchema, incarnation: z.string().min(1), editor: z.boolean() })),
});
export type ArtifactAccessSnapshot = z.infer<typeof ArtifactAccessSnapshotSchema>;

/** Queue bodies carry addresses, not potentially unbounded audience lists. */
export const ArtifactAccessMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('canvas_artifact_access_changed'), region:RegionSchema, workspaceId: WorkspaceIdSchema, canvasId: IdSchema, revision:z.number().int().positive() }),
  z.strictObject({ kind: z.literal('artifact_access_sync'), region:RegionSchema, workspaceId: WorkspaceIdSchema, canvasId: IdSchema,
    artifactId: IdSchema, resourceId: IdSchema }),
]);
export type ArtifactAccessMessage = z.infer<typeof ArtifactAccessMessageSchema>;

/** Platform-owned references to published file bytes; never populated by a visitor. */
export const PublishedArtifactFileSchema = z.strictObject({
  resourceId: IdSchema,
  title: z.string(),
  versions: z.array(z.strictObject({ version: z.number().int().positive(), contentRef: z.string().min(1), mimeType: z.string() })),
});
export type PublishedArtifactFile = z.infer<typeof PublishedArtifactFileSchema>;

export const ArtifactLinkSchema = z.strictObject({artifactId:IdSchema,canonicalUrl:HttpUrlSchema});
