import { z } from "zod";

import { UserIdSchema, WorkstreamIdSchema } from "./identifiers";

/**
 * Spaces: the Organization's grouping of Channels.
 *
 * A Space is the product abstraction; `SpaceDO` is the work-stream primitive
 * under a role, and `docs/workstream-durable-object.md` owns that. This file is
 * only what the wire carries. `projects.ts` re-exports the appearance registry
 * below under its old `PROJECT_*` names so nothing breaks before the Projects
 * cutover deletes it.
 */

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
 * The hue ring: fourteen colours in wheel order, `pink` adjacent to `rose` so
 * the sequence closes on itself.
 *
 * The pickers rely on that — each runs its first row left to right and its
 * second right to left, so both seams of the ring meet rather than jumping back
 * across the grid. Reordering this list reorders the swatches and breaks a seam;
 * add a hue where it belongs on the wheel, not at the end.
 */
export const PALETTE_RING = [
  "rose",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "emerald",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;

/**
 * Keys retired when the palette became the ring. Rows written before that still
 * hold them, and a stored value has to survive a read —
 * `WorkstreamAppearanceSchema.parse` runs on every work-stream read and throws
 * rather than degrading — so they stay storable, keep their design tokens, and
 * keep rendering exactly as they did. Nothing recolours under anyone; the
 * colour simply cannot be chosen again.
 */
export const PALETTE_RETIRED = [
  "gray",
  "brown",
  "yellow",
  "teal",
] as const;

/**
 * Every colour the design system defines a token for: the ring, the `black`
 * neutral, and the retired keys still being rendered for whoever holds one.
 *
 * This is the vocabulary, not a menu. What a *Space* may be and what a
 * *person* may be are narrower lists below, and they are deliberately different
 * — `black` is the account accent's alone.
 */
export const PALETTE_KEYS = [...PALETTE_RING, "black", ...PALETTE_RETIRED] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

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

/**
 * Which ink reads on each fill.
 *
 * The basis is APCA — the perceptual contrast model the WCAG 3 drafts are built
 * on — together with a look at every fill at the sizes it actually ships. It is
 * deliberately not WCAG 2's relative-luminance ratio, which this table used to
 * follow. WCAG 2 makes black the winner on sixteen of these nineteen fills,
 * `blue`, `red` and `violet` among them, where a white symbol plainly reads
 * better and where every other design system ships white. Thirteen of those
 * sixteen are what this table reversed; the other three still take black. Its luminance curve is
 * known to misjudge saturated mid-tones, and this palette is nothing but
 * saturated mid-tones: on `blue` it scores black 5.71 against white's 3.68,
 * while APCA scores white Lc 69 against black's Lc 40.
 *
 * The boundary sits between `green` and `cyan`, and it was set by review rather
 * than by arithmetic alone. APCA's own crossover is one step further along,
 * between `emerald` and `orange`, but the fills on either side of it are ties in
 * its terms — `cyan` is Lc 52 white against Lc 57 black, `emerald` Lc 54 against
 * Lc 55. Where the two inks tie, the ring reads better with one of them running
 * through it than with two exceptions stranded in the middle.
 *
 * What this knowingly gives up: none of the thirteen fills this change flips to
 * white meets WCAG 2's 4.5:1 for text with that ink — they are scattered around
 * the ring rather than being a run of it — and four of them —
 * `cyan` at 2.43:1, `emerald`, `orange`, `yellow` — are under even the 3:1 that
 * standard asks of a graphical object. An audit run against WCAG 2 will flag
 * them. That is the price of following the model that matches what is on the
 * screen, and it is recorded here so the next person meets it as a decision
 * rather than as a surprise.
 *
 * `emerald` and `orange` are the weakest entries whichever ink they take:
 * neither reaches APCA's Lc 60 for body text on them, and these fills carry
 * message-bubble prose, so that gap is real. It belongs to the fills rather than
 * to this table — darkening those two closes it and no ink choice can.
 *
 * Checked in rather than computed at render, so a value change that flips an ink
 * has to be a visible edit; `palette.css.node.test.ts` holds the readable floor
 * against the tokens in both appearances, and pins both the WCAG 2 shortfall and
 * the two APCA ties by name so neither can grow unnoticed.
 */
export const PALETTE_INK = {
  rose: "white",
  red: "white",
  orange: "white",
  amber: "black",
  lime: "black",
  green: "black",
  emerald: "white",
  cyan: "white",
  blue: "white",
  indigo: "white",
  violet: "white",
  purple: "white",
  fuchsia: "white",
  pink: "white",
  black: "white",
  gray: "white",
  brown: "white",
  yellow: "white",
  teal: "white",
} as const satisfies Record<PaletteKey, "white" | "black">;

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
   * payload grow with the Organization. The ids are paginated separately —
   * see {@link SpaceChannelPageSchema}.
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
 * One page of a Space's member Channels.
 *
 * Opaque cursor: the ordering is the authority's, and a client that could
 * construct a cursor could ask for a page the ordering no longer has.
 */
export const SpaceChannelPageSchema = z.strictObject({
  items: z.array(WorkstreamIdSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type SpaceChannelPage = z.infer<typeof SpaceChannelPageSchema>;

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
 * Every way a Space operation is refused, as a code the far side can branch on.
 *
 * Closed, and closed for the reason `docs/naming-a-schema-failure.md` gives: a
 * refusal that reaches a log, an operator, or the far side of an RPC hop has to
 * name what it rejected. A generic `space_error` would make the eight distinct
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
