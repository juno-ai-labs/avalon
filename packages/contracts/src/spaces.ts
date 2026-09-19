import { z } from "zod";

import { UserIdSchema, WorkstreamIdSchema } from "./identifiers";
import { PALETTE_KEYS, PALETTE_RING } from "./palette";

/**
 * Spaces: the Organization's grouping of Channels.
 *
 * A Space is the product abstraction; `SpaceDO` is the work-stream primitive
 * under a role, and `docs/workstream-durable-object.md` owns that. This file is
 * only what the wire carries. `projects.ts` re-exports the appearance registry
 * below under its old `PROJECT_*` names so nothing breaks before the Projects
 * cutover deletes it.
 *
 * The palette the registries below draw from is `palette.ts`, and is
 * re-exported here so no importer has to know it moved.
 */

export {
  PALETTE_INK,
  PALETTE_KEYS,
  PALETTE_RETIRED,
  PALETTE_RING,
  type PaletteKey,
} from "./palette";

export const SPACE_ICON_KEYS = [
  "briefcase",
  "target",
  "calendar-days",
  "list-checks",
  "clipboard-list",
  "file-text",
  "folder",
  "lightbulb",
  "star",
  "flag",
  "rocket",
  "chart-no-axes-combined",
  "calculator",
  "coins",
  "users",
  "user-search",
  "handshake",
  "megaphone",
  "palette",
  "image",
  "pen-tool",
  "package",
  "building-2",
  "globe-2",
  "heart",
] as const;

/**
 * What the picker offers for a Space or Channel: the ring, and nothing
 * else.
 *
 * `black` is left out on purpose. It reads as an absence of colour rather than a
 * colour, which is the wrong signal for an object sitting in a list beside
 * thirteen others it is meant to be told apart from; it belongs to a person,
 * where only one is on screen at a time.
 *
 * Left out of the *menu*, not out of the vocabulary — see
 * `SPACE_COLOR_KEYS_STORABLE`. Narrowing what can be stored is how a colour
 * somebody already holds turns into a failed read.
 */
export const SPACE_COLOR_KEYS = PALETTE_RING;

/**
 * What a stored Space colour may legally hold: every colour the palette
 * defines, which is deliberately wider than the menu.
 *
 * This is the vocabulary for schemas and for the SQLite CHECK constraint. It
 * carries the retired keys and `black` alike — a value that is no longer
 * offered still has to parse and still has to render, whether it stopped being
 * offered because it was retired or because it was reserved for accounts.
 */
export const SPACE_COLOR_KEYS_STORABLE = PALETTE_KEYS;


export const SpaceIdSchema = z.string().uuid().brand<"SpaceId">();
export type SpaceId = z.infer<typeof SpaceIdSchema>;
export const asSpaceId = (value: string): SpaceId => SpaceIdSchema.parse(value);

export const SpaceIconKeySchema = z.enum(SPACE_ICON_KEYS);
export type SpaceIconKey = z.infer<typeof SpaceIconKeySchema>;
export const SpaceColorKeySchema = z.enum(SPACE_COLOR_KEYS_STORABLE);
export type SpaceColorKey = z.infer<typeof SpaceColorKeySchema>;

/**
 * Who a Space is for, in the vocabulary every Channel scope, grant, and
 * directory row already uses.
 *
 * `workspace` is the Organization-wide audience. The product word on every
 * visible surface is **Organization**; the wire keeps `workspace` because
 * composing an Organization-wide Space source with a Channel's direct scope is
 * a comparison between two scope values, and two spellings of the same audience
 * would need a translation at every seam that compares them.
 */
export const SpaceScopeSchema = z.enum(["personal", "workspace"]);
export type SpaceScope = z.infer<typeof SpaceScopeSchema>;

/**
 * A Space is active or archived, with nothing in between.
 *
 * Deliberately narrower than `ProjectStatus`, which carries four transitional
 * states. A Project's archive fans out to its member work streams and can be
 * observed mid-flight; a Space's archive is refused outright unless every
 * member Channel already has another active Space, so the transition either
 * commits at the WorkspaceDO authority or never starts.
 */
export const SpaceStatusSchema = z.enum(["active", "archived"]);
export type SpaceStatus = z.infer<typeof SpaceStatusSchema>;

/**
 * A role the Organization itself depends on, rather than a label a person
 * chose.
 *
 * Only `general` today: the one Space per Organization that receives a Channel
 * created without another destination. It is an enum rather than a boolean
 * because the value is stored, and a second protected role would otherwise
 * arrive as a second column with its own backfill.
 */
export const SpaceSystemRoleSchema = z.enum(["general"]);
export type SpaceSystemRole = z.infer<typeof SpaceSystemRoleSchema>;

export const SpaceParticipantSchema = z.strictObject({
  userId: UserIdSchema,
});
export type SpaceParticipant = z.infer<typeof SpaceParticipantSchema>;

export const SpaceSummarySchema = z.strictObject({
  id: SpaceIdSchema,
  name: z.string().trim().min(1),
  iconKey: SpaceIconKeySchema,
  colorKey: SpaceColorKeySchema,
  scope: SpaceScopeSchema,
  status: SpaceStatusSchema,
  /** `general` for the Organization's protected fallback Space, `null` otherwise. */
  systemRole: SpaceSystemRoleSchema.nullable(),
  /**
   * The Space revision every fence reads.
   *
   * One counter rather than the Project model's three generations
   * (presentation, audience, lifecycle). Membership, default delivery, and
   * audience propagation are all fenced on "the Space as it was when this work
   * was staged", and three counters meant every fence had to name which of them
   * it meant — while a change to one of the other two still invalidated the
   * work. A future change may add a second counter, but it has to say what it
   * fences that this one does not.
   */
  revision: z.number().int().positive(),
  participants: z.array(SpaceParticipantSchema),
  /**
   * Channels a surface can show: a listable active membership whose Channel is
   * not archived.
   *
   * A count rather than the ids. `ProjectSummary.workstreamIds` carried the
   * whole membership and is nested inside the workspace socket's opening
   * payload; one Channel may now belong to several Spaces and General holds
   * every Channel in the Organization, so the same field would make that
   * payload grow with the Organization. The Channels themselves are paginated
   * separately, by `SpaceChannelPageSchema` — which lives in `index.ts`,
   * beside the `Workstream` shape one page of them is made of.
   *
   * Archived Channels are excluded for the reason the Project count excluded
   * them: their membership rows survive archival so an unarchive returns them
   * to the Space, but no list renders them, so counting them claimed members no
   * screen could produce.
   */
  channelCount: z.number().int().nonnegative(),
  defaultResourceIds: z.array(z.string().uuid()).default([]),
  defaultSidekickIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SpaceSummary = z.infer<typeof SpaceSummarySchema>;

export const SpaceDirectorySchema = z.strictObject({
  waterline: z.number().int().nonnegative(),
  items: z.array(SpaceSummarySchema),
});
export type SpaceDirectory = z.infer<typeof SpaceDirectorySchema>;

export const SpaceSnapshotSchema = z.strictObject({
  active: SpaceDirectorySchema,
  inactive: SpaceDirectorySchema,
}).superRefine((snapshot, context) => {
  // Both halves are one authority's answer at one waterline. Two different
  // numbers mean the two lists were read across a mutation, and a client that
  // applied them would render a Space in both or in neither.
  if (snapshot.active.waterline !== snapshot.inactive.waterline) {
    context.addIssue({
      code: "custom",
      path: ["inactive", "waterline"],
      message: "must match the active space directory waterline",
    });
  }
});
export type SpaceSnapshot = z.infer<typeof SpaceSnapshotSchema>;

export const CreateSpaceRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  iconKey: SpaceIconKeySchema,
  colorKey: SpaceColorKeySchema,
  scope: SpaceScopeSchema,
});
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequestSchema>;

export const UpdateSpacePresentationRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  iconKey: SpaceIconKeySchema,
  colorKey: SpaceColorKeySchema,
});
export type UpdateSpacePresentationRequest = z.infer<typeof UpdateSpacePresentationRequestSchema>;

export const UpdateSpaceAudienceRequestSchema = z.strictObject({
  scope: SpaceScopeSchema,
  /**
   * The whole participant set, never a delta.
   *
   * At least one, because a Space with no participants is a personal Space
   * nobody can open and an Organization-wide Space nobody can edit. The
   * authority decides who may be removed; this only refuses the empty set.
   */
  participantUserIds: z.array(UserIdSchema).min(1),
});
export type UpdateSpaceAudienceRequest = z.infer<typeof UpdateSpaceAudienceRequestSchema>;

export const ReorderSpacesRequestSchema = z.strictObject({
  spaceIds: z.array(SpaceIdSchema),
});
export type ReorderSpacesRequest = z.infer<typeof ReorderSpacesRequestSchema>;

/**
 * What a Space hands down to its member Channels, as one kind-keyed value.
 *
 * A resource and a Sidekick recommendation are the same mechanism with a
 * different consumer: staged per membership, fenced on a generation, published
 * through the outbox, rechecked by the Queue consumer, settled by receipt. The
 * Project model had that machinery for resources alone, so a Sidekick default
 * would have been a second copy of it. `kind` is what stops that.
 *
 * It lives here rather than beside the RPCs that carry it because it is on the
 * wire in both directions — `POST /spaces/:id/defaults/:kind` sends it and the
 * dashboard renders one section per value — and a renderer that cannot import
 * the Worker's protocol module was restating it from a comment.
 */
export const SpaceDefaultKindSchema = z.enum(["resource", "sidekick"]);
export type SpaceDefaultKind = z.infer<typeof SpaceDefaultKindSchema>;

/**
 * Every source that currently grants a reader access to one Channel.
 *
 * What **Manage access** renders, and the shape the Channel's effective
 * audience is derived from: the Channel's own direct source plus one entry per
 * active Space the Channel belongs to. They are listed rather than merged
 * because removing one is only legal when the others still cover the readers it
 * supplied, and a merged audience cannot answer that.
 */
export const ChannelAccessSourcesSchema = z.strictObject({
  direct: z.strictObject({
    scope: SpaceScopeSchema,
    participantUserIds: z.array(UserIdSchema),
  }),
  spaces: z.array(z.strictObject({
    spaceId: SpaceIdSchema,
    scope: SpaceScopeSchema,
    participantUserIds: z.array(UserIdSchema),
  })),
});
export type ChannelAccessSources = z.infer<typeof ChannelAccessSourcesSchema>;

/**
 * What `GET /workstreams/:id/access` answers with: the Channel's own
 * provenance, plus the Spaces the *Organization* says currently hold it.
 *
 * Two lists rather than one, and `spaceIds` is deliberately not on
 * {@link ChannelAccessSourcesSchema}: that shape is what the Channel's own
 * authority knows, and WorkstreamDO cannot see a membership. They agree in the
 * steady state and disagree exactly while an operation is in flight or has been
 * interrupted, which is the thing **Manage access** has to be able to show
 * rather than hide behind one merged answer.
 */
export const ChannelAccessSchema = ChannelAccessSourcesSchema.extend({
  spaceIds: z.array(SpaceIdSchema),
});
export type ChannelAccess = z.infer<typeof ChannelAccessSchema>;

/**
 * What a refusal knows that its code does not: which Channels are in the way.
 *
 * `space_membership_final` and `space_audience_incompatible` are both refusals
 * about *a Channel* — the one that would be left with no home, or whose readers
 * would lose every way of finding it — and the caller was acting on the Space.
 * Without this the confirmation could only say that some Channel has to move
 * first, which leaves the person to find it by archiving repeatedly.
 *
 * Only the Channels the caller may already read. The refusal is about the
 * Space's whole membership, which can include a Channel this person has no
 * access to; naming that one would disclose its existence, and they could not
 * move it either. So the list is what they can act on, and may be shorter than
 * the reason — which is why the copy beside it still has to stand on its own.
 */
export const SpaceRefusalDetailsSchema = z.strictObject({
  channelIds: z.array(WorkstreamIdSchema),
});
export type SpaceRefusalDetails = z.infer<typeof SpaceRefusalDetailsSchema>;

/**
 * Every way a Space operation is refused, as a code the far side can branch on.
 *
 * Closed, and closed for the reason `docs/naming-a-schema-failure.md` gives: a
 * refusal that reaches a log, an operator, or the far side of an RPC hop has to
 * name what it rejected. A generic `space_error` would make the ten distinct
 * remediations below indistinguishable in a log line.
 */
export const SpaceErrorCodeSchema = z.enum([
  /** The caller may not read, or may not edit, this Space. */
  "space_access_denied",
  /** No Space with this id in this Organization. */
  "space_not_found",
  /** General: its lifecycle, system role, and Organization-wide audience are immutable. */
  "space_protected",
  /** The Channel's last active membership, or a Space archive that would produce one. */
  "space_membership_final",
  /** Removing this membership would leave a reader unable to discover any remaining Space. */
  "space_audience_incompatible",
  /** A Space still makes this Channel Organization-wide; take it out of that Space first. */
  "channel_scope_locked_by_space",
  /** The Channel holds retained content the proposed wider audience may not read. */
  "space_membership_content_fence",
  /** A default resource or Sidekick the full effective Channel audience cannot reach. */
  "space_default_audience_mismatch",
  /** The Space moved under a staged operation; re-read its revision and retry. */
  "space_revision_conflict",
  /** The Organization has not finished creating General and placing its Channels. */
  "space_bootstrap_pending",
]);
export type SpaceErrorCode = z.infer<typeof SpaceErrorCodeSchema>;
