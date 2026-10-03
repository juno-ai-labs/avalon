/**
 * The shape of a demo conversation pack: what each step and field is, without
 * the cross-field rules that make a pack playable.
 *
 * The rules (who may speak where, one question per conversation, a room made
 * before it is used, the `expect` block matching what each viewer sees) live
 * beside the planner in `apps/api/src/services/demo-pack.ts`, which builds
 * `DemoPackSchema` from this shape. The shape lives here, rather than with the
 * rules, because the Demo MCP Worker advertises it to clients as JSON Schema
 * and that Worker cannot import the API. `docs/demo-workspaces.md` owns the
 * pack; `docs/demo-mcp.md` owns how it is advertised.
 */
import { z } from "zod";

import { DemoSeedSayTurnSchema, DemoSeedTurnSchema } from "./demo-seed";
import { IanaTimezoneSchema } from "./index";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { SpaceColorKeySchema, SpaceIconKeySchema } from "./spaces";

/** A role the cast plays. Bound to an account per demo, never in the pack. */
export const DemoPackRoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
export type DemoPackRole = z.infer<typeof DemoPackRoleSchema>;

/**
 * A step's id doubles as the action id on every receipt and seed, and — joined
 * to the operation id — as the client message id the production path dedupes
 * on. 80 is what `DemoSeedSchema.actionId` allows, and the pair fits the 120
 * a client message id may be.
 */
export const StepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
export const RoomKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
/**
 * The pack's own name for a substream, unique across the pack. The main
 * conversation of a room has no name of its own: creating the room creates it,
 * and a step that names no substream is a step in it.
 */
export const SubstreamKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
export const MessageTextSchema = z.string().min(1).max(MESSAGE_MAX_CHARACTERS);

/**
 * `@{role}` in a message names a cast member. The planner replaces it with the
 * bound account's display name and records a mention at those offsets, which
 * is what makes the mention real: the object validates that the visible text
 * matches the person, and a confirmed mention seats them in the room.
 */
export const DEMO_PACK_MENTION_TOKEN = /@\{([a-z][a-z0-9-]{0,39})\}/gu;

export const CreateWorkstreamStepSchema = z.strictObject({
  kind: z.literal("create_workstream"),
  execution: z.enum(["run", "history"]).optional(),
  id: StepIdSchema,
  room: RoomKeySchema,
  as: DemoPackRoleSchema,
  title: z.string().min(1),
  space: RoomKeySchema.optional(),
  /**
   * Roles seated at creation, besides the author. May be empty: a person alone
   * with Rally is an ordinary room, and whether a seeded line starts a run is
   * the seed's decision rather than the room's size.
   */
  participants: z.array(DemoPackRoleSchema),
  scope: z.enum(["workspace", "personal"]),
  openingMessage: MessageTextSchema,
  /** What Rally says: an opening message always starts a run. */
  assistant: DemoSeedTurnSchema,
});

/**
 * Open a substream: a private conversation inside a room the pack already
 * created. Only its participants ever see it — it is not a second work stream,
 * takes no row in anybody's sidebar, and changes nothing about how the room it
 * hangs off is listed.
 *
 * Two things the production flow decides for a person are the pack's here.
 * Membership, because a substream opens creator-only and everybody else is
 * added afterwards, so the pack says who ends up in it rather than leaving a
 * demo's private room with one person in it. And the starting context, because
 * Rally normally writes that by summarizing the parent conversation with a
 * model: scripting it keeps a seeded demo reproducible and keeps one more live
 * model call out of the minutes an operator spends waiting to present.
 */
export const CreateSubstreamStepSchema = z.strictObject({
  kind: z.literal("create_substream"),
  id: StepIdSchema,
  /** The room this hangs off, which an earlier step must have created. */
  room: RoomKeySchema,
  substream: SubstreamKeySchema,
  /** Who opens it. A substream is created by one person and starts idle. */
  as: DemoPackRoleSchema,
  title: z.string().min(1),
  /** Everyone else in it, added by the creator once it is ready. */
  participants: z.array(DemoPackRoleSchema),
  /** What Rally's starting context says, in place of the summary a model would write. */
  startingContext: z.string().min(1).max(20_000),
});

export const MessageStepSchema = z.strictObject({
  kind: z.literal("message"),
  id: StepIdSchema,
  room: RoomKeySchema,
  /** Which conversation of the room. Absent: the main one. */
  substream: SubstreamKeySchema.optional(),
  as: DemoPackRoleSchema,
  text: MessageTextSchema,
  /** What Rally says when this message starts a run. Absent: it starts none. */
  assistant: DemoSeedTurnSchema.optional(),
});

export const UploadStepSchema = z.strictObject({
  kind: z.literal("upload"),
  id: StepIdSchema,
  room: RoomKeySchema,
  /** Which conversation of the room. Absent: the main one. */
  substream: SubstreamKeySchema.optional(),
  as: DemoPackRoleSchema,
  title: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.enum(["text/markdown", "text/plain"]),
  content: z.string().min(1),
});

/**
 * A Sidekick the demo already has, published and on a schedule.
 *
 * It belongs to no room: it is created by `createAutomation` like the one a
 * person makes from the Sidekicks library, it owns its own authoring
 * conversation, and no later step refers back to it. That is why this step
 * carries no `room` key while every other step does.
 *
 * The definition's four prose fields are the ones a drafting conversation would
 * have produced, written here instead so a demo does not depend on a live model
 * to have a Sidekick in it. `schedule` is the recurrence, and its `timezone` is
 * always named: a demo is presented in a zone somebody chose, and leaving it
 * null would resolve it against whichever colleague happens to be cast as the
 * author, whose own zone is not the one the demo is being shown in.
 */
export const SidekickStepSchema = z.strictObject({
  kind: z.literal("sidekick"),
  id: StepIdSchema,
  as: DemoPackRoleSchema,
  /** `personal` is the author's alone; `workspace` is offered to every member. */
  scope: z.enum(["personal", "workspace"]),
  name: z.string().min(1).max(140),
  description: z.string().min(1).max(1200),
  overview: z.string().min(1).max(3000),
  instructions: z.string().min(1).max(12000),
  schedule: z.strictObject({
    rrule: z.string().min(1),
    timezone: IanaTimezoneSchema,
    summary: z.string().min(1),
  }),
  /**
   * One run it has already made, so the demo has something to look at before
   * the schedule first fires. Absent: it is published and has never run. Only
   * a `say`, because a Sidekick run has no room to park a question in.
   */
  firstRun: DemoSeedSayTurnSchema.optional(),
});

export const DemoPackStepSchema = z.discriminatedUnion("kind", [
  CreateWorkstreamStepSchema,
  CreateSubstreamStepSchema,
  MessageStepSchema,
  UploadStepSchema,
  SidekickStepSchema,
]);
export type DemoPackStep = z.infer<typeof DemoPackStepSchema>;

/**
 * What one viewer should find in one room once the demo is Ready — the flags
 * the directory answers per viewer and nothing can derive from the steps
 * alone, because they depend on who opened what: the seeder reads a room as
 * the cast member who acted in it, and that read opens it for them.
 */
export const DemoViewerRoomExpectationSchema = z.strictObject({
  /** In the room and never opened it. */
  unseen: z.boolean(),
  hasUnread: z.boolean(),
  /** A mention of this viewer sits above what they have seen. */
  mentioned: z.boolean(),
});

/**
 * One viewer the readiness barrier verifies. The rooms listed must be exactly
 * the rooms the pack makes visible to them — every workspace-scoped room, and
 * every room they were seated in — which the schema checks, so a pack cannot
 * expect a room a viewer will never see or forget one they will.
 */
export const DemoViewerExpectationSchema = z.strictObject({
  viewer: DemoPackRoleSchema,
  /** The home screen's attention summary for this viewer. */
  attention: z.strictObject({
    waitingForYou: z.number().int().nonnegative(),
    waitingReason: z.enum(["mentioned", "needs_input", "unseen"]).nullable(),
  }),
  rooms: z.record(RoomKeySchema, DemoViewerRoomExpectationSchema),
});
export type DemoViewerExpectation = z.infer<typeof DemoViewerExpectationSchema>;

/**
 * Every field of a pack, unrefined. `DemoPackSchema` in the API adds the rules;
 * nothing should accept a pack through this alone.
 */
export const DemoPackShapeSchema = z.strictObject({
  version: z.string().min(1),
  roles: z.array(DemoPackRoleSchema).min(1),
  spaces: z.record(RoomKeySchema, z.strictObject({
    as: DemoPackRoleSchema, name: z.string().trim().min(1),
    iconKey: SpaceIconKeySchema, colorKey: SpaceColorKeySchema,
  })).optional(),
  steps: z.array(DemoPackStepSchema).min(1),
  /**
   * The viewers the readiness barrier verifies, and what each should find.
   * Usually the presenter alone: a cast member who acted in a room opened it
   * by acting, and a pack that lists them has to say so in their flags. The
   * barrier refuses a pack that lists nobody, so Ready never means nothing
   * was checked.
   */
  expect: z.array(DemoViewerExpectationSchema).default([]),
  /**
   * What each cast role is, in a word or two — the part the operator is
   * casting somebody into. The form labels its dropdowns with these, because
   * a role token reads as this pack's own character and says nothing about
   * who should play it: a colleague seated in the wrong part has the pack's
   * scripted words attributed to them under their real name.
   */
  roleLabels: z.record(DemoPackRoleSchema, z.string().trim().min(1).max(40)).default({}),
});
export type DemoPackShape = z.infer<typeof DemoPackShapeSchema>;
