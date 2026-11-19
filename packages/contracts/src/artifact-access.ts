import { z } from 'zod';
import { RegionSchema } from './regions';
import { HttpUrlSchema } from './url-schemas';
import { IdSchema, UserIdSchema, WorkspaceIdSchema } from './identifiers';
import { deferredZodSchema } from "./deferred-zod-schema";

export const CanvasArtifactVisibilitySchema = deferredZodSchema(() => z.enum(['editors', 'participants', 'workspace', 'public']));
export type CanvasArtifactVisibility = z.infer<typeof CanvasArtifactVisibilitySchema>;

/** A complete, replaceable projection. Only the owning Canvas produces revisions. */
export const ArtifactAccessSnapshotSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  canvasId: IdSchema,
  revision: z.number().int().positive(),
  public: z.boolean(),
  archived: z.boolean(),
  users: z.array(z.strictObject({ userId: UserIdSchema, incarnation: z.string().min(1), editor: z.boolean() })),
}));
export type ArtifactAccessSnapshot = z.infer<typeof ArtifactAccessSnapshotSchema>;

/** Queue bodies carry addresses, not potentially unbounded audience lists. */
export const ArtifactAccessMessageSchema = deferredZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('canvas_artifact_access_changed'), region:RegionSchema, workspaceId: WorkspaceIdSchema, canvasId: IdSchema }),
  z.strictObject({ kind: z.literal('artifact_access_sync'), region:RegionSchema, workspaceId: WorkspaceIdSchema, canvasId: IdSchema,
    artifactId: IdSchema, resourceId: IdSchema }),
]));
export type ArtifactAccessMessage = z.infer<typeof ArtifactAccessMessageSchema>;

/** Platform-owned references to published file bytes; never populated by a visitor. */
export const PublishedArtifactFileSchema = deferredZodSchema(() => z.strictObject({
  resourceId: IdSchema,
  title: z.string(),
  versions: z.array(z.strictObject({ version: z.number().int().positive(), contentRef: z.string().min(1), mimeType: z.string() })),
}));
export type PublishedArtifactFile = z.infer<typeof PublishedArtifactFileSchema>;

/**
 * The path a published file is also served at, besides `/`: its own name, so
 * the URL ends in `.mp3` or `.pdf`. Podcast apps and download managers guess a
 * file's type from its URL, and a feed's enclosure that ends in `/` is one some
 * of them refuse. Null for a title that is not a plain file name (an upload's
 * display title, say), which is served at `/` only.
 */
export function publishedFilePath(title: string): string | null {
  return PLAIN_FILE_NAME.test(title) ? `/${title}` : null;
}

/**
 * Whether a request path is a published file's own-name path. Any plain name
 * is accepted, not only the current title: a file can be renamed after its
 * link went into a feed or a message, and that link must keep working. Only
 * the file itself is ever served on its host, so the name claims nothing.
 */
export function isPublishedFileNamePath(path: string): boolean {
  return path.startsWith("/") && PLAIN_FILE_NAME.test(path.slice(1));
}

const PLAIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.[A-Za-z0-9]{1,10}$/u;

export const ArtifactLinkSchema = deferredZodSchema(() => z.strictObject({artifactId:IdSchema,canonicalUrl:HttpUrlSchema}));
