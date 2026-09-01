import { z } from "zod";

export const IdSchema = z.string().uuid();
export const WorkspaceIdSchema = IdSchema.brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export const WorkstreamIdSchema = IdSchema.brand<"WorkstreamId">();
export type WorkstreamId = z.infer<typeof WorkstreamIdSchema>;
export const HarnessRunIdSchema = IdSchema.brand<"HarnessRunId">();
export type HarnessRunId = z.infer<typeof HarnessRunIdSchema>;
export const UserIdSchema = IdSchema.brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;
export const SubstreamIdSchema = z.union([z.literal("0"), IdSchema]).brand<"SubstreamId">();
export type SubstreamId = z.infer<typeof SubstreamIdSchema>;
export const BlockIdSchema = IdSchema.brand<"BlockId">();
export type BlockId = z.infer<typeof BlockIdSchema>;
/**
 * A live web artifact's id.
 *
 * Branded like the rest, and for the sharpest form of the reason the others
 * are: this id is the artifact's hostname label *and* the segment its
 * supervisor Durable Object is named by, so a value that reached here as some
 * other id would address a different object and serve a different artifact,
 * with no error on either side.
 */
export const ArtifactIdSchema = IdSchema.brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const asWorkspaceId = (value: string): WorkspaceId => WorkspaceIdSchema.parse(value);
export const asWorkstreamId = (value: string): WorkstreamId => WorkstreamIdSchema.parse(value);
export const asHarnessRunId = (value: string): HarnessRunId => HarnessRunIdSchema.parse(value);
export const asUserId = (value: string): UserId => UserIdSchema.parse(value);
export const asSubstreamId = (value: string): SubstreamId => SubstreamIdSchema.parse(value);
export const asBlockId = (value: string): BlockId => BlockIdSchema.parse(value);
export const asArtifactId = (value: string): ArtifactId => ArtifactIdSchema.parse(value);

export const ModelPluginIdSchema = z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u);
export const ActivitySourceBindingKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/u);
