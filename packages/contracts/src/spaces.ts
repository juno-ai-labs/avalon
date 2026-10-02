import { z } from "zod";

import { IdSchema, UserIdSchema, WorkstreamIdSchema } from "./identifiers";
import { PICKABLE_APPEARANCE_ICON_KEYS, STORABLE_APPEARANCE_ICON_KEYS } from "./appearance-icons";
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

/**
 * The icons a Space can be given: the one shared catalog, the same keys a
 * Channel, a Breakout and a Sidekick choose from. See `appearance-icons.ts`.
 */
export const SPACE_ICON_KEYS = PICKABLE_APPEARANCE_ICON_KEYS;

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

/**
 * Validated against every key ever offered, not today's menu, so a Space whose
 * icon left the catalog keeps parsing; the same split as the colours below.
 */
export const SpaceIconKeySchema = z.enum(STORABLE_APPEARANCE_ICON_KEYS);
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

export const SpaceParticipantSchema = z.strictObject({
  userId: UserIdSchema,
});
export type SpaceParticipant = z.infer<typeof SpaceParticipantSchema>;

/**
 * Why *this* viewer can see this Space — the one field every surface decides
 * from.
 *
 * Three ways, and they are not equivalent:
 *
 * - `participant` — they are one of the Space's own participants.
 * - `organization` — the Space is Organization-wide, so every active member
 *   reaches it.
 * - `through_channel` — they reach it only because they can read a Channel
 *   placed in it. The Space itself is participants-only and they are not a
 *   participant, or it is archived and they are neither.
 *
 * The third is the one that changes what a surface may draw. A Space's icon,
 * colour and name are disclosed to whoever can see a Channel inside it, so the
 * Channel can be drawn under the Space it actually lives in rather than in a
 * flat list of homeless rows; **nothing else about the Space is**. The summary
 * such a viewer is handed carries no participants and no defaults, its
 * `channelCount` counts only the Channels that viewer can see, and every Space
 * write is refused them by name. One field rather than a second summary
 * schema: a second shape would be a second thing every reader has to branch
 * on, and the fields that are withheld are withheld by being empty — which is
 * a state each of them already has.
 *
 * The strongest relationship wins, so a participant of an Organization-wide
 * Space reads `participant`. Only `through_channel` is load-bearing today; the
 * other two are told apart because "you are in this Space" is a fact about
 * this person that "everyone is" does not imply, and a reader that conflated
 * them could not get it back.
 */
export const SpaceReachSchema = z.enum(["participant", "organization", "through_channel"]);
export type SpaceReach = z.infer<typeof SpaceReachSchema>;

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
  /**
   * Why this viewer can see this Space; see {@link SpaceReachSchema}.
   *
   * The one viewer-dependent field on this shape, and deliberately so. Every
   * other field here is the Organization's fact about the Space, which is why
   * the projection that builds it is otherwise the same for everybody — but
   * *which* Spaces a person is handed is now three questions rather than two,
   * and the third admits a viewer who may see the Space's mark and nothing
   * else. A surface that had to re-derive that from `scope` and `participants`
   * would get it wrong the moment `participants` is withheld, which for this
   * viewer it always is.
   */
  reach: SpaceReachSchema,
  /**
   * The Space's own participants — empty for a `through_channel` viewer, who
   * is told the Space exists and nothing about who is in it.
   */
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
   *
   * The Organization's count for a `participant` or `organization` viewer, and
   * **this viewer's** for a `through_channel` one. Those two readings differ on
   * purpose: for a member of the Space the count is what keeps an expansion
   * holding no rows from claiming the Space is empty, and being short of it is
   * not proof anything is missing. For somebody who reaches the Space through
   * one Channel it would be the size of a participants-only Space — which is
   * exactly the disclosure this field used to be kept off a Channel row to
   * avoid.
   */
  channelCount: z.number().int().nonnegative(),
  /** Channels and Breakouts in this Space that currently need this viewer. */
  attentionCount: z.number().int().nonnegative().optional(),
  /** Empty for a `through_channel` viewer: a Space's defaults are not theirs to see. */
  defaultResourceIds: z.array(z.string().uuid()).default([]),
  /** Empty for a `through_channel` viewer, with {@link SpaceSummarySchema.shape.defaultResourceIds}. */
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

/** One server-coordinated Channel move, destination first and source second. */
export const MoveChannelBetweenSpacesRequestSchema = z.strictObject({
  sourceSpaceId: SpaceIdSchema,
});
export type MoveChannelBetweenSpacesRequest = z.infer<typeof MoveChannelBetweenSpacesRequestSchema>;

/**
 * Both containers changed by a move.
 *
 * The two authoritative Space summaries are the mutation witness, so the
 * initiating client can update both rails immediately and derive the Channel's
 * new placement without a refetch. Other clients receive the same state through
 * WorkspaceDO's normal realtime publication.
 */
export const MoveChannelBetweenSpacesResultSchema = z.strictObject({
  source: SpaceSummarySchema,
  target: SpaceSummarySchema,
});
export type MoveChannelBetweenSpacesResult = z.infer<typeof MoveChannelBetweenSpacesResultSchema>;

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

/**
 * What a person may arrange by hand, named by the thing that contains it.
 *
 * Four lists in the product are ordered per person — the Organization's
 * Spaces, the Channels placed in one Space, the Breakouts under one Channel,
 * and the Channels pinned under **All** — and they are one mechanism because the question
 * each answers is identical: in what order does *this* person want the items of
 * *this* container. The kind says which list, the id says which container of
 * that kind, and the items are ids of whatever that container holds.
 *
 * **`organization` and `pinned` carry no id.** A request is already addressed to one
 * Organization — the authority reads the workspace from the caller's session
 * and writes the rows under it — so an id here would be a second answer to a
 * question already settled, and a wrong one would be *accepted*: the write
 * landed on the real Organization's list while the answer echoed the id the
 * caller sent, which the desktop then filed its cache under. The shape says
 * which kinds have a container to name instead of leaving a field somebody has
 * to fill in correctly. The stored row still keys on the workspace id, because
 * a row wants to say what it is about; the wire does not have to be told.
 */
export const OrderedContainerKindSchema = z.enum(["organization", "space", "channel", "pinned"]);
export type OrderedContainerKind = z.infer<typeof OrderedContainerKindSchema>;

export const OrderedContainerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization") }),
  z.strictObject({ kind: z.literal("space"), id: IdSchema }),
  z.strictObject({ kind: z.literal("channel"), id: IdSchema }),
  // The Pinned section under **All**: every Channel this person pinned in any
  // Space, in one order of their own. Each Space keeps its own pinned run; All
  // draws from several, so it has no run to rearrange and keeps this list
  // instead. Addressed like `organization`, by the request's own Organization.
  z.strictObject({ kind: z.literal("pinned") }),
]);
export type OrderedContainer = z.infer<typeof OrderedContainerSchema>;

/**
 * One container's order for one person: the request that writes it, and the
 * element of the ordering the socket delivers.
 *
 * One schema for both directions on purpose. The write is "put these items in
 * this order", the delivery is "these items are in this order", and two
 * declarations of the same pair would be two things to keep in step for no
 * difference on the wire.
 *
 * What the authority may drop from `itemIds` differs by kind and is
 * `docs/spaces.md`'s to state: the Organization's list is filtered to the
 * Spaces this viewer can see, a Space's list to the Channels actually placed
 * there that this viewer can read, and a Channel's Breakouts are stored as
 * given — WorkspaceDO does not know a Channel's children, so the client drops
 * whatever it cannot draw.
 */
export const ContainerOrderSchema = z.strictObject({
  container: OrderedContainerSchema,
  itemIds: z.array(IdSchema),
});
export type ContainerOrder = z.infer<typeof ContainerOrderSchema>;

/**
 * Every container this person has arranged, in one field.
 *
 * A list rather than a map keyed by container, because the key is a pair and a
 * map would have to encode it into a string that each reader parses back —
 * which is a second, undeclared format for something the pair already says.
 * Order within the list carries nothing; each entry is addressed by its
 * container.
 */
export const PersonalOrderSchema = z.array(ContainerOrderSchema);
export type PersonalOrder = z.infer<typeof PersonalOrderSchema>;

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
 * `space_membership_final` is a refusal about *a Channel* that would be left
 * with no home while the caller was acting on the Space. The legacy
 * `space_audience_incompatible` code remains parseable during fleet cutover.
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
 * name what it rejected. A generic `space_error` would make the twelve distinct
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
  /** Legacy: associative ancestor visibility means current authorities do not emit this. */
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
  /**
   * A member Channel's own conversation could not answer, so the question was
   * never asked.
   *
   * Distinct from `space_membership_content_fence`, which is the same RPC
   * saying *no*. `previewAudienceContainment` is a tri-state — `true`, `false`,
   * or `null` when the object it reached is not that Channel's main
   * conversation — and the two negatives need different remediations: a fence
   * is a decision about content, an unreachable conversation is a Channel whose
   * authority is missing or mis-addressed. The cutover has always read them
   * apart, under `space_bootstrap_conversation_unreachable`; this is the
   * request path's half of the same reading.
   */
  "space_conversation_unreachable",
  /**
   * The Space authority could not be opened or reached, including the D1
   * anchor and authority route used to open its hidden conversation.
   *
   * The far end of {@link SpaceErrorCode} `space_conversation_unreachable`,
   * which is about a *member Channel's* conversation failing the containment
   * question. This one is the Space's own participant and resource authority
   * — the object a scope change, a rename, an appearance, a participant and a
   * resource default are all written on — or the routing/bootstrap path to it
   * failing in a way that is not itself a refusal: a broken recovery, a
   * mis-addressed object, or a storage error crossing the boundary as a bare
   * `Error`.
   *
   * It exists because that failure had nothing to be called. It reached the
   * client as `internal_error`, which is the same word the Worker uses for
   * every unhandled failure it has, so a log line could not tell a Space whose
   * authority is unreachable from anything else — and the remediation is
   * particular: nothing is wrong with the request, the Organization, or the
   * member Channels, and retrying is the whole of what a person can do.
   */
  "space_authority_unreachable",
  /**
   * The audience this request asks for would leave its own caller out of the
   * Space.
   *
   * A Space narrowed to `personal` admits its participants and nobody else, so
   * a caller who leaves themselves off that list has just made a Space they
   * can no longer change — and, when no Channel in it is one they can read, no
   * longer see. Every following read of it answers them as somebody who is not
   * in it: an empty participant roster, no defaults, and a Channel count taken
   * over what they can see, which may be nothing.
   *
   * Refused rather than allowed and explained, because there is no undo. The
   * Space's own authority would accept the change, the walk would carry it to
   * every member Channel, and the person who asked for it would be the one
   * person who cannot ask for it back. Removing *somebody else* is a different
   * decision with a different rule — an Organization owner or admin may, and
   * `participant_removal_denied` is what refuses anybody else.
   */
  "space_audience_self_excluded",
  /**
   * The page cursor this request carried is not one this Space issued.
   *
   * Its own code rather than `space_not_found`, which is what a malformed
   * cursor used to be answered with: the two want opposite things from the
   * caller — one says stop, the other says drop the cursor and read the first
   * page — and "that space no longer exists" about a Space the reader is
   * looking at is a diagnosis nobody can act on. The reason was in hand at the
   * point of refusal, which is `CLAUDE.md`'s test for a generic code being a
   * defect.
   *
   * A cursor is opaque and the ordering behind it is the authority's, so this
   * is also what a client gets for one it constructed itself.
   */
  "space_cursor_invalid",
]);
export type SpaceErrorCode = z.infer<typeof SpaceErrorCodeSchema>;
