/**
 * The conversation pack, and the plan the seeder plays from it.
 *
 * A pack is versioned data behind a schema: a cast of roles, and an ordered
 * list of steps that create rooms, open private substreams inside them, say
 * things in either as cast members, attach documents, and publish Sidekicks.
 * Roles are bound to real accounts only when a demo is prepared, so one pack
 * serves every demo and the pack never names a user id. What Rally says in a
 * seeded room is part of the step that starts the run (`assistant`) — prose
 * that carries its findings itself, with no tool call behind it, because a
 * seeded transcript records nothing Rally did not do.
 *
 * A room step addresses a *conversation*, not a room: a room's main
 * conversation by naming the room alone, a substream by naming both. That
 * distinction is the whole of what substreams cost the rest of this module,
 * because a private child takes no directory row — `packRoomFacts` says why the
 * readiness barrier must not see one. A Sidekick step is in no room at all and
 * addresses no conversation.
 *
 * `planDemoSeed` turns a pack and a cast binding into the actions the seeder
 * applies one at a time: mentions resolved to user ids and offsets, seats
 * resolved to ids, every step carrying the seed the object reads addressing
 * from. The plan is pure — it reads nothing and writes nothing — which is what
 * lets a test prove a pack is playable before anything is written.
 *
 * `docs/demo-workspaces.md` owns the feature and says which scenarios the
 * placeholder pack carries and why.
 */
import { z } from "zod";

import {
  DemoSeedSayTurnSchema,
  DemoSeedTurnSchema,
  IanaTimezoneSchema,
  MESSAGE_MAX_CHARACTERS,
  type DemoSeed,
  type DemoSeedTurn,
  type Message,
} from "@rally/contracts";

type Mention = Message["mentions"][number];

/** A role the cast plays. Bound to an account per demo, never in the pack. */
export const DemoPackRoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
export type DemoPackRole = z.infer<typeof DemoPackRoleSchema>;

/**
 * The one role that has to be the person presenting. They sign in and the demo
 * is their view of it, so they are cast from the template's members; every
 * other role is cast from the company's directory when the demo is prepared.
 * A pack without this role is cast entirely from that directory.
 */
export const DEMO_PRESENTER_ROLE = "presenter";

/** The roles the operator names: every role the presenter does not play. */
export function demoCastRoles(roles: readonly DemoPackRole[]): DemoPackRole[] {
  return roles.filter((role) => role !== DEMO_PRESENTER_ROLE);
}

/**
 * A step's id doubles as the action id on every receipt and seed, and — joined
 * to the operation id — as the client message id the production path dedupes
 * on. 80 is what `DemoSeedSchema.actionId` allows, and the pair fits the 120
 * a client message id may be.
 */
const StepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
const RoomKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
/**
 * The pack's own name for a substream, unique across the pack. The main
 * conversation of a room has no name of its own: creating the room creates it,
 * and a step that names no substream is a step in it.
 */
const SubstreamKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
const MessageTextSchema = z.string().min(1).max(MESSAGE_MAX_CHARACTERS);

/**
 * `@{role}` in a message names a cast member. The planner replaces it with the
 * bound account's display name and records a mention at those offsets, which
 * is what makes the mention real: the object validates that the visible text
 * matches the person, and a confirmed mention seats them in the room.
 */
const MENTION_TOKEN = /@\{([a-z][a-z0-9-]{0,39})\}/gu;

const CreateWorkstreamStepSchema = z.strictObject({
  kind: z.literal("create_workstream"),
  id: StepIdSchema,
  room: RoomKeySchema,
  as: DemoPackRoleSchema,
  title: z.string().min(1),
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
const CreateSubstreamStepSchema = z.strictObject({
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

const MessageStepSchema = z.strictObject({
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

const UploadStepSchema = z.strictObject({
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
const SidekickStepSchema = z.strictObject({
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

/** The steps that happen inside a room, which is every step but a Sidekick's. */
type DemoPackRoomStep = Exclude<DemoPackStep, { kind: "sidekick" }>;
function isRoomStep(step: DemoPackStep): step is DemoPackRoomStep {
  return step.kind !== "sidekick";
}

/**
 * Which conversation a room step writes to, as one key. A room's main
 * conversation is the room's own key; a substream is the room's key and its
 * own. Seating, the one-question rule and the planner all address conversations
 * rather than rooms, because a room now has more than one.
 *
 * A Sidekick is in no room and so addresses no conversation, which is why this
 * takes a room step: `isRoomStep` has to answer first.
 */
function conversationKey(step: DemoPackRoomStep): string {
  if (step.kind === "create_workstream") return step.room;
  if (step.kind === "create_substream") return `${step.room}/${step.substream}`;
  return step.substream === undefined ? step.room : `${step.room}/${step.substream}`;
}

/**
 * Whether a room step writes to a room's main conversation, which is what the
 * directory shows. Same reason as above for taking a room step: a Sidekick is
 * neither a main-conversation step nor a substream one.
 */
function isMainConversationStep(step: DemoPackRoomStep): boolean {
  if (step.kind === "create_workstream") return true;
  if (step.kind === "create_substream") return false;
  return step.substream === undefined;
}

function mentionedRoles(text: string): string[] {
  return [...text.matchAll(MENTION_TOKEN)].map((match) => match[1]!);
}

/**
 * What one viewer should find in one room once the demo is Ready — the flags
 * the directory answers per viewer and nothing can derive from the steps
 * alone, because they depend on who opened what: the seeder reads a room as
 * the cast member who acted in it, and that read opens it for them.
 */
const ViewerRoomExpectationSchema = z.strictObject({
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
const ViewerExpectationSchema = z.strictObject({
  viewer: DemoPackRoleSchema,
  /** The home screen's attention summary for this viewer. */
  attention: z.strictObject({
    waitingForYou: z.number().int().nonnegative(),
    waitingReason: z.enum(["mentioned", "needs_input", "unseen"]).nullable(),
  }),
  rooms: z.record(RoomKeySchema, ViewerRoomExpectationSchema),
});
export type DemoViewerExpectation = z.infer<typeof ViewerExpectationSchema>;

/** What the steps say about one room, once every step has been applied. */
export interface DemoPackRoomFacts {
  room: string;
  title: string;
  scope: "workspace" | "personal";
  creator: DemoPackRole;
  /** Everyone in the room at the end: the creator, the seated, and the mentioned. */
  seated: DemoPackRole[];
  /** Roles a step in this room mentions. */
  mentioned: DemoPackRole[];
  /** Index of the room's last step in `steps`; recency order follows it. */
  lastStepIndex: number;
  /** How the room's loop ends: parked on a question, or completed. */
  finalState: "needs_input" | "completed";
  /** Step ids of the room's uploads. */
  uploads: string[];
}

/**
 * The rooms a pack builds, from its steps alone. Assumes a pack the schema
 * accepted; the readiness manifest and the schema's own viewer check both read
 * from this so there is one statement of who ends up in a room.
 *
 * **Substreams are not rooms and are deliberately invisible here.** A private
 * child takes no directory row, and the parent object aggregates only its main
 * conversation into the row the sidebar and the home screen read — so a
 * substream changes neither the parent's seats, its state, its attachments nor
 * where it sorts. Counting substream steps would make the barrier expect a
 * projection the platform never produces, and it would wait forever. A Sidekick
 * step is skipped for the plainer reason that it is in no room at all;
 * `packSidekickFacts` is what reads those.
 */
export function packRoomFacts(steps: readonly DemoPackStep[]): Map<string, DemoPackRoomFacts> {
  const rooms = new Map<string, DemoPackRoomFacts>();
  steps.forEach((step, index) => {
    if (!isRoomStep(step) || !isMainConversationStep(step)) return;
    const text = step.kind === "create_workstream" ? step.openingMessage : step.kind === "message" ? step.text : "";
    const mentions = mentionedRoles(text);
    if (step.kind === "create_workstream") {
      rooms.set(step.room, {
        room: step.room,
        title: step.title,
        scope: step.scope,
        creator: step.as,
        seated: [...new Set([step.as, ...step.participants, ...mentions])],
        mentioned: [...new Set(mentions)],
        lastStepIndex: index,
        finalState: step.assistant.kind === "ask" ? "needs_input" : "completed",
        uploads: [],
      });
      return;
    }
    const facts = rooms.get(step.room);
    if (!facts) return;
    facts.lastStepIndex = index;
    facts.seated = [...new Set([...facts.seated, ...mentions])];
    facts.mentioned = [...new Set([...facts.mentioned, ...mentions])];
    if (step.kind === "upload") facts.uploads.push(step.id);
    if (step.kind === "message" && step.assistant) {
      facts.finalState = step.assistant.kind === "ask" ? "needs_input" : "completed";
    }
  });
  return rooms;
}

/** The rooms one viewer is offered: every workspace-scoped one, and every one they are in. */
export function visibleRoomsFor(role: DemoPackRole, rooms: Iterable<DemoPackRoomFacts>): DemoPackRoomFacts[] {
  return [...rooms].filter((facts) => facts.scope === "workspace" || facts.seated.includes(role));
}

/** What the steps say about one Sidekick, once every step has been applied. */
export interface DemoPackSidekickFacts {
  /** The step's id, which is also its action id on the receipt. */
  stepId: string;
  name: string;
  scope: "personal" | "workspace";
  author: DemoPackRole;
  /** Whether the pack seeded a first run for it. */
  hasFirstRun: boolean;
}

/** The Sidekicks a pack publishes, in pack order. */
export function packSidekickFacts(steps: readonly DemoPackStep[]): DemoPackSidekickFacts[] {
  return steps.filter((step) => step.kind === "sidekick").map((step) => ({
    stepId: step.id,
    name: step.name,
    scope: step.scope,
    author: step.as,
    hasFirstRun: step.firstRun !== undefined,
  }));
}

/**
 * The Sidekicks one viewer is offered: every workspace-scoped one, and every
 * personal one they authored. The same shape as `visibleRoomsFor`, and the same
 * reason: the readiness barrier compares against what this viewer will actually
 * be shown, not against everything the pack made.
 */
export function visibleSidekicksFor(
  role: DemoPackRole,
  sidekicks: readonly DemoPackSidekickFacts[],
): DemoPackSidekickFacts[] {
  return sidekicks.filter((facts) => facts.scope === "workspace" || facts.author === role);
}

/**
 * What one viewer's `expect` block has to say, for a viewer who never acts.
 *
 * `expect` exists because the per-viewer flags depend on who opened what, and
 * the seeder opens a room for whoever acted in it. For a viewer who acts in no
 * room that dependency is gone and every flag follows from the steps, so this
 * derives the block rather than leaving an author to reason it out — a wrong
 * flag is not a test failure, it is a demo that sits in **Waiting for
 * workspace** until the operator gives up, because the barrier is comparing
 * against something the platform will never produce.
 *
 * The three flags and the count are the directory's and the home screen's own
 * rules, read back for a viewer with nothing seen:
 *
 * - **unseen** is "in the room and never opened it", so for this viewer it is
 *   exactly whether the pack seats them.
 * - **hasUnread** is activity above what they have seen, and they have seen
 *   nothing, so every room they are offered is unread. A room always carries a
 *   message — creating one is a message — so there is no empty-room case.
 * - **mentioned** is a mention above what they have seen, so it is whether any
 *   step in the room's *main* conversation names them.
 * - **waitingForYou** counts the rooms they are *in* — a workspace room nobody
 *   seated them in never counts, however it ends — and every such room counts,
 *   because being seated and never opening it is already `unseen`. The reason
 *   is the strongest one across those rooms: a mention beats an unanswered
 *   question beats merely never having opened it.
 *
 * A substream is invisible here for the same reason it is invisible to
 * `packRoomFacts`: it takes no directory row, and being in one seats nobody in
 * its parent.
 *
 * Refused for a viewer who authors a step in a room's main conversation,
 * because acting there opened it and the flags are then a fact about the
 * seeding order rather than about the pack. Authoring a substream step or a
 * Sidekick is not acting in a room and does not refuse: neither touches the
 * directory row this reads.
 */
export function demoIdleViewerExpectation(
  steps: readonly DemoPackStep[],
  viewer: DemoPackRole,
): DemoViewerExpectation {
  const acted = steps.some((step) => isRoomStep(step) && isMainConversationStep(step) && step.as === viewer);
  if (acted) throw new Error(`demo_pack_viewer_is_not_idle:${viewer}`);
  const visible = visibleRoomsFor(viewer, packRoomFacts(steps).values());
  const seated = visible.filter((room) => room.seated.includes(viewer));
  return {
    viewer,
    attention: {
      waitingForYou: seated.length,
      waitingReason: seated.some((room) => room.mentioned.includes(viewer))
        ? "mentioned"
        : seated.some((room) => room.finalState === "needs_input")
          ? "needs_input"
          : seated.length > 0 ? "unseen" : null,
    },
    rooms: Object.fromEntries(visible.map((room) => [room.room, {
      unseen: seated.includes(room),
      hasUnread: true,
      mentioned: room.mentioned.includes(viewer),
    }])),
  };
}

/**
 * The rules a pack has to satisfy to be playable at all, checked at parse time
 * so a bad pack stops preparation before the first write rather than after
 * the third.
 */
export const DemoPackSchema = z.strictObject({
  version: z.string().min(1),
  roles: z.array(DemoPackRoleSchema).min(1),
  steps: z.array(DemoPackStepSchema).min(1),
  /**
   * The viewers the readiness barrier verifies, and what each should find.
   * Usually the presenter alone: a cast member who acted in a room opened it
   * by acting, and a pack that lists them has to say so in their flags. The
   * barrier refuses a pack that lists nobody, so Ready never means nothing
   * was checked.
   */
  expect: z.array(ViewerExpectationSchema).default([]),
  /**
   * What each cast role is, in a word or two — the part the operator is
   * casting somebody into. The form labels its dropdowns with these, because
   * a role token reads as this pack's own character and says nothing about
   * who should play it: a colleague seated in the wrong part has the pack's
   * scripted words attributed to them under their real name.
   */
  roleLabels: z.record(DemoPackRoleSchema, z.string().trim().min(1).max(40)).default({}),
}).superRefine((pack, context) => {
  const roles = new Set(pack.roles);
  // Every role the operator casts, and only those: an unlabelled dropdown
  // says nothing about the part, and a label for a role nobody plays would
  // read as one more person in the demo.
  const cast = new Set(demoCastRoles(pack.roles));
  for (const role of cast) {
    if (!pack.roleLabels[role]) {
      context.addIssue({ code: "custom", path: ["roleLabels"], message: `Role "${role}" has no label` });
    }
  }
  for (const role of Object.keys(pack.roleLabels)) {
    if (!cast.has(role)) {
      context.addIssue({ code: "custom", path: ["roleLabels", role], message: `"${role}" is not a role the operator casts` });
    }
  }
  if (roles.size !== pack.roles.length) {
    context.addIssue({ code: "custom", path: ["roles"], message: "Roles must be unique" });
  }
  const ids = new Set<string>();
  /**
   * Who is in each conversation so far, keyed by `conversationKey`: a room's
   * main conversation under the room's name, a substream under both. A room
   * and its substreams have separate rosters — being in the work stream is not
   * being in its private child, and the parent object says so explicitly.
   */
  const seated = new Map<string, Set<string>>();
  /** A room's scope, which is what decides who may be put in its substreams. */
  const roomScope = new Map<string, "workspace" | "personal">();
  /** Every substream name the pack has used, and the room it named it in. */
  const substreams = new Map<string, string>();
  const asked = new Set<string>();
  /** Sidekick names, folded, so two cannot collide in the directory. */
  const sidekickNames = new Set<string>();
  pack.steps.forEach((step, index) => {
    const path = ["steps", index];
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: [...path, "id"], message: `Step id "${step.id}" is used twice` });
    }
    ids.add(step.id);
    const named = [step.as, ...(step.kind === "create_workstream" || step.kind === "create_substream" ? step.participants : [])];
    for (const role of named) {
      if (!roles.has(role)) {
        context.addIssue({ code: "custom", path, message: `Role "${role}" is not in the cast` });
      }
    }
    if (step.kind === "sidekick") {
      // A Sidekick is in no room, so none of the room rules below apply to it.
      // Its own prose names people the same way Rally's does — by token,
      // expanded when the cast is bound — so an unbound one is refused here for
      // the same reason: it is dereferenced mid-seeding, long after the last
      // point at which refusing costs nothing.
      const spoken = [step.description, step.overview, step.instructions, step.firstRun?.text ?? ""];
      for (const role of spoken.flatMap(mentionedRoles)) {
        if (!roles.has(role)) {
          context.addIssue({ code: "custom", path, message: `The Sidekick's prose names role "${role}", which is not in the cast` });
        }
      }
      const name = step.name.trim().toLowerCase();
      if (sidekickNames.has(name)) {
        // The directory lists Sidekicks by title and the barrier matches a
        // viewer's row by name, so two under one name would make one of them
        // unverifiable.
        context.addIssue({ code: "custom", path: [...path, "name"], message: `Two Sidekicks are named "${step.name}"` });
      }
      sidekickNames.add(name);
      return;
    }
    // Everything below is about a conversation, which only a room step has.
    const conversation = conversationKey(step);
    const text = step.kind === "create_workstream" ? step.openingMessage : step.kind === "message" ? step.text : null;
    const mentions = text === null ? [] : mentionedRoles(text);
    for (const role of mentions) {
      if (!roles.has(role)) {
        context.addIssue({ code: "custom", path, message: `Mentioned role "${role}" is not in the cast` });
      }
    }
    // Rally's own prose names people with the same tokens, expanded to bare
    // names when played. An unbound one there seats nobody, but it is
    // dereferenced when the seed is planned — mid-seeding, after the
    // workspace exists and the connections are copied — so it is refused here,
    // with the rest.
    const assistant = "assistant" in step ? step.assistant : undefined;
    const spoken = assistant === undefined
      ? []
      : assistant.kind === "say" ? [assistant.text] : [assistant.prompt, ...assistant.options];
    for (const role of spoken.flatMap(mentionedRoles)) {
      if (!roles.has(role)) {
        context.addIssue({ code: "custom", path: [...path, "assistant"], message: `Rally's turn names role "${role}", which is not in the cast` });
      }
    }
    // A substream's starting context is Rally's prose too, and it names people
    // with the same tokens. Unbound there it would throw mid-seed, after the
    // work stream it hangs off already exists.
    if (step.kind === "create_substream") {
      for (const role of mentionedRoles(step.startingContext)) {
        if (!roles.has(role)) {
          context.addIssue({ code: "custom", path: [...path, "startingContext"], message: `The starting context names role "${role}", which is not in the cast` });
        }
      }
    }
    if (step.kind === "create_workstream") {
      if (seated.has(step.room)) {
        context.addIssue({ code: "custom", path: [...path, "room"], message: `Room "${step.room}" is created twice` });
      }
      if (step.participants.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "participants"], message: "The author is seated already" });
      }
      roomScope.set(step.room, step.scope);
      seated.set(step.room, new Set([step.as, ...step.participants, ...mentions]));
      return;
    }
    if (step.kind === "create_substream") {
      const parent = seated.get(step.room);
      if (!parent) {
        context.addIssue({ code: "custom", path: [...path, "room"], message: `Room "${step.room}" is used before it is created` });
        return;
      }
      const owner = substreams.get(step.substream);
      if (owner !== undefined) {
        context.addIssue({ code: "custom", path: [...path, "substream"], message: `Substream "${step.substream}" is created twice` });
      }
      if (step.participants.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "participants"], message: "The creator is in it already" });
      }
      // The parent refuses anybody it would not let read the work stream —
      // a workspace room lets every member in, a personal one only its own
      // participants. Refused here rather than at the add, which happens
      // after the child is already open and half its roster seated.
      const readable = roomScope.get(step.room) === "workspace";
      for (const role of new Set([step.as, ...step.participants])) {
        if (!readable && !parent.has(role)) {
          context.addIssue({
            code: "custom",
            path,
            message: `Role "${role}" cannot be put in a substream of personal room "${step.room}" without being in it`,
          });
        }
      }
      substreams.set(step.substream, step.room);
      seated.set(conversation, new Set([step.as, ...step.participants]));
      return;
    }
    const room = seated.get(conversation);
    if (!room) {
      if (step.substream !== undefined && substreams.get(step.substream) !== step.room) {
        context.addIssue({ code: "custom", path: [...path, "substream"], message: `Substream "${step.substream}" is not a substream of room "${step.room}"` });
      } else {
        context.addIssue({ code: "custom", path: [...path, "room"], message: `Room "${conversation}" is used before it is created` });
      }
      return;
    }
    if (asked.has(conversation)) {
      // The `ask` parked its run on a real open elicitation. Anything said in
      // the room after that is said into a question nobody has answered, and
      // the presenter is the one who is meant to answer it.
      context.addIssue({ code: "custom", path, message: `Room "${conversation}" continues after its question` });
    }
    if (!room.has(step.as)) {
      // The production path admits a message from a workspace member who is
      // not in the room only by seating them, which is a fact the pack would
      // be relying on by accident. Say who is in the room instead.
      context.addIssue({ code: "custom", path: [...path, "as"], message: `Role "${step.as}" is not in room "${conversation}"` });
    }
    for (const role of mentions) {
      if (step.substream === undefined) {
        room.add(role);
        continue;
      }
      // A confirmed mention seats somebody in a work stream, but a substream's
      // roster is the parent object's and a message cannot add to it. The
      // client adds the person before sending; a pack says so up front.
      if (!room.has(role)) {
        context.addIssue({
          code: "custom",
          path,
          message: `Role "${role}" is mentioned in substream "${conversation}" without being in it`,
        });
      }
    }
    if (step.kind === "message" && step.assistant?.kind === "ask") asked.add(conversation);
  });
  const facts = packRoomFacts(pack.steps);
  const viewers = new Set<string>();
  pack.expect.forEach((expectation, index) => {
    const path = ["expect", index];
    if (viewers.has(expectation.viewer)) {
      context.addIssue({ code: "custom", path, message: `Viewer "${expectation.viewer}" is expected twice` });
    }
    viewers.add(expectation.viewer);
    if (!roles.has(expectation.viewer)) {
      context.addIssue({ code: "custom", path, message: `Viewer "${expectation.viewer}" is not in the cast` });
      return;
    }
    const visible = new Set(visibleRoomsFor(expectation.viewer, facts.values()).map((room) => room.room));
    const listed = new Set(Object.keys(expectation.rooms));
    for (const room of visible) {
      if (!listed.has(room)) {
        context.addIssue({ code: "custom", path: [...path, "rooms"], message: `Viewer "${expectation.viewer}" will see room "${room}", which is not expected` });
      }
    }
    for (const room of listed) {
      if (!visible.has(room)) {
        context.addIssue({ code: "custom", path: [...path, "rooms", room], message: `Viewer "${expectation.viewer}" will not see room "${room}"` });
      }
    }
  });
});
export type DemoPack = z.infer<typeof DemoPackSchema>;

/** Who plays each role in one demo: a workspace member, by id and by name. */
export interface DemoCastMember {
  userId: string;
  /** The name the workspace directory has for them; a mention's visible text. */
  displayName: string;
}
export type DemoCast = Readonly<Record<DemoPackRole, DemoCastMember>>;

interface ResolvedText {
  text: string;
  mentions: Mention[];
  /** The mentioned members, who a confirmed mention seats in the room. */
  mentionedUserIds: string[];
}

/**
 * Expand every `@{role}` in Rally's own prose to the bound name, with no
 * mention: an assistant turn names people the way the model would, and the
 * pack cannot know who is cast until it is played. The schema has already
 * refused a role the cast does not bind, so the lookup cannot miss.
 */
function resolveRoleNames(text: string, cast: DemoCast): string {
  return text.replaceAll(MENTION_TOKEN, (_token, role: string) => {
    const member = cast[role];
    if (!member) throw new Error(`demo_pack_role_unbound:${role}`);
    return member.displayName;
  });
}

function resolveTurn(turn: DemoSeedTurn, cast: DemoCast): DemoSeedTurn {
  return turn.kind === "say"
    ? { kind: "say", text: resolveRoleNames(turn.text, cast) }
    : {
        kind: "ask",
        prompt: resolveRoleNames(turn.prompt, cast),
        options: turn.options.map((option) => resolveRoleNames(option, cast)),
      };
}

/**
 * Expand every `@{role}` to the bound name and record where it landed. Offsets
 * are on the expanded text, which is the text the object receives.
 */
function resolveMentions(text: string, cast: DemoCast): ResolvedText {
  const mentions: Mention[] = [];
  const mentionedUserIds: string[] = [];
  let resolved = "";
  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const member = cast[match[1]!]!;
    resolved += text.slice(cursor, match.index);
    const label = `@${member.displayName}`;
    mentions.push({
      type: "person",
      userId: member.userId,
      connectorType: null,
      startOffset: resolved.length,
      endOffset: resolved.length + label.length,
    });
    if (!mentionedUserIds.includes(member.userId)) mentionedUserIds.push(member.userId);
    resolved += label;
    cursor = match.index + match[0].length;
  }
  resolved += text.slice(cursor);
  return { text: resolved, mentions, mentionedUserIds };
}

interface ActionBase {
  actionId: string;
  /** The cast member who does this, by user id. */
  actorUserId: string;
}

/** An action inside a room, which is every action but a Sidekick's. */
interface RoomActionBase extends ActionBase {
  room: string;
  /**
   * The pack's name for the conversation within the room, or `null` for its
   * main one. The seeder turns this into the substream id the receipts of an
   * earlier action recorded.
   */
  substream: string | null;
}

export type DemoSeedAction =
  | (RoomActionBase & {
      kind: "create_workstream";
      substream: null;
      title: string;
      scope: "workspace" | "personal";
      participantUserIds: string[];
      openingMessage: string;
      mentions: Mention[];
      seed: DemoSeed;
    })
  | (RoomActionBase & {
      kind: "create_substream";
      substream: string;
      title: string;
      /** Added by the creator once the child is ready; never includes them. */
      participantUserIds: string[];
      /** Rally's starting context, with every role token expanded to a name. */
      startingContext: string;
    })
  | (RoomActionBase & {
      kind: "message";
      text: string;
      mentions: Mention[];
      confirmedParticipantUserIds: string[];
      seed: DemoSeed;
    })
  | (RoomActionBase & {
      kind: "upload";
      title: string;
      fileName: string;
      mimeType: "text/markdown" | "text/plain";
      content: string;
    })
  | (ActionBase & {
      kind: "sidekick";
      scope: "personal" | "workspace";
      /** The definition to publish, with every role token expanded to a name. */
      definition: {
        name: string;
        description: string;
        overview: string;
        instructions: string;
      };
      schedule: { rrule: string; timezone: string; summary: string };
      /** The one run to seed, or null when the pack seeded none. */
      firstRun: DemoSeed | null;
    });

/**
 * The actions a pack plays as, once its roles are bound.
 *
 * Every role the pack names must be bound: a pack that plays a role nobody is
 * cast in is not playable, and that is found here rather than at the message
 * that needed them.
 */
/**
 * The actions that happen inside a room, which is every action but a
 * Sidekick's — the action-side twin of `DemoPackRoomStep`. Only these address a
 * conversation, so only these carry `room` and `substream`.
 */
export type DemoSeedRoomAction = Exclude<DemoSeedAction, { kind: "sidekick" }>;

export function planDemoSeed(pack: DemoPack, cast: DemoCast): DemoSeedAction[] {
  for (const role of pack.roles) {
    if (!(role in cast)) throw new Error(`demo_pack_role_unbound:${role}`);
  }
  const seed = (step: DemoPackStep, assistant: DemoSeedTurn | null): DemoSeed => ({
    packVersion: pack.version,
    actionId: step.id,
    assistant: assistant ? resolveTurn(assistant, cast) : null,
  });
  return pack.steps.map((step): DemoSeedAction => {
    const actor = cast[step.as]!;
    switch (step.kind) {
      case "create_workstream": {
        const resolved = resolveMentions(step.openingMessage, cast);
        return {
          kind: "create_workstream",
          actionId: step.id,
          room: step.room,
          substream: null,
          actorUserId: actor.userId,
          title: step.title,
          scope: step.scope,
          participantUserIds: [
            ...new Set([
              ...step.participants.map((role) => cast[role]!.userId),
              ...resolved.mentionedUserIds,
            ]),
          ],
          openingMessage: resolved.text,
          mentions: resolved.mentions,
          seed: seed(step, step.assistant),
        };
      }
      case "create_substream":
        return {
          kind: "create_substream",
          actionId: step.id,
          room: step.room,
          substream: step.substream,
          actorUserId: actor.userId,
          title: step.title,
          participantUserIds: [...new Set(step.participants.map((role) => cast[role]!.userId))],
          startingContext: resolveRoleNames(step.startingContext, cast),
        };
      case "message": {
        const resolved = resolveMentions(step.text, cast);
        return {
          kind: "message",
          actionId: step.id,
          room: step.room,
          substream: step.substream ?? null,
          actorUserId: actor.userId,
          text: resolved.text,
          mentions: resolved.mentions,
          // Confirming a participant is what seats a mentioned person in a
          // work stream. A substream's roster belongs to the parent object and
          // a message cannot add to it, so the schema has already refused a
          // mention of anybody who is not in the child, and there is nobody
          // left for this to seat.
          confirmedParticipantUserIds: step.substream === undefined ? resolved.mentionedUserIds : [],
          seed: seed(step, step.assistant ?? null),
        };
      }
      case "upload":
        return {
          kind: "upload",
          actionId: step.id,
          room: step.room,
          substream: step.substream ?? null,
          actorUserId: actor.userId,
          title: step.title,
          fileName: step.fileName,
          mimeType: step.mimeType,
          content: step.content,
        };
      case "sidekick":
        return {
          kind: "sidekick",
          actionId: step.id,
          actorUserId: actor.userId,
          scope: step.scope,
          definition: {
            name: step.name,
            description: resolveRoleNames(step.description, cast),
            overview: resolveRoleNames(step.overview, cast),
            instructions: resolveRoleNames(step.instructions, cast),
          },
          schedule: step.schedule,
          firstRun: step.firstRun ? seed(step, step.firstRun) : null,
        };
    }
  });
}

const DECISION_MEMO_TITLE = "Insights pricing — decision memo";
const PRESS_RELEASE_TITLE = "Announcement — listing";

/**
 * The pack the feature is built and proved against.
 *
 * It carries the two scenarios the spike settled — the decision memo and the
 * multiplayer renewal — plus the standing Sidekick a demo is expected to open
 * with, and a third room the spike did not settle: drafting the announcement of
 * a filing, which exists to show two things the first two cannot. A document
 * that goes through versions, so the room holds three drafts rather than one
 * attachment. And a substream, so the demo has somewhere the side argument went
 * that is not the main conversation. It is not the spike's onboarding-email
 * room, which was invented to test a third directory row and is not approved
 * copy. The cast roles and their names are open inputs the PRD hands to the
 * team; this pack is what runs until they arrive, and swapping any of it is a
 * data change behind the schema above.
 *
 * Every assistant turn cites only what the room holds. A seeded run makes no
 * tool call, so Rally cannot have read Drive, Granola or Linear: the people
 * bring the facts in their own messages, Rally reasons from them, and the
 * memo is attached by the person who wrote it. That is also what keeps the
 * one real run in a demo — the presenter's answer to the closing question —
 * honest: it inherits a transcript in which every number has a source. Names
 * in Rally's prose are `@{role}` tokens, expanded to the cast when played.
 *
 * A literal, not a parsed value: it is checked against the schema the first
 * time a demo asks for it (`activeDemoPack`) and by `demo-pack.test.ts`, not
 * when the Worker's module graph loads — a pack the schema refused took every
 * route in both regions down at boot, for a feature one region refuses.
 */
export const PLACEHOLDER_DEMO_PACK = {
  version: "placeholder-2026-09",
  // Product, sales and legal, in the order the operator meets them in the
  // form. A role is a part in the script, not a person: whoever is cast as
  // `priya` plays it under their own name.
  roles: ["presenter", "priya", "marcus", "dana"],
  // What each part is, in the order the operator meets them in the form. A
  // role is a part in the script, not a person: whoever is cast as `priya`
  // plays it under their own name, and the label is what tells the operator
  // whose words they are about to put in a colleague's mouth.
  roleLabels: { priya: "Product", marcus: "Sales", dana: "Legal" },
  steps: [
    {
      kind: "create_workstream",
      id: "memo-open",
      room: "decision-memo",
      as: "priya",
      title: "Insights pricing before the Northgate renewal",
      participants: ["marcus"],
      scope: "workspace",
      openingMessage: [
        "I need a decision memo on Insights pricing before the Northgate renewal, and I",
        "want the argument for and against bundling, not a summary. What I have: sales",
        "say it is the separate line item, not the price, that stalls deals, and two",
        "renewals this quarter asked for Insights to be included. Bundling it into",
        "Growth at a $4k uplift still reaches the Q4 revenue target, at 41 attached",
        "accounts instead of 18 at the $12k add-on. Finance's ARPA floor is $31k.",
        "TID-431 is still open — billing has no bundle SKU.",
      ].join(" "),
      assistant: {
        kind: "say",
        text: [
          "From what you have given me, the argument runs both ways, and it is not close.",
          "",
          "**For bundling.** The objection sales report is the line item, not the price,",
          "and two renewals have already asked for Insights to be included — that is",
          "demand for the bundle, not for a discount. The bundled case reaches the Q4",
          "target at 41 attached accounts against 18 for the add-on, so the revenue risk",
          "is in the add-on, not the bundle.",
          "",
          "**Against.** A $4k uplift on Growth clears the $31k ARPA floor, but you have",
          "not said by how much, and a thin margin leaves no room for a concession at",
          "renewal. And TID-431 means a bundled launch cannot be quoted today: with no",
          "bundle SKU, the first bundled deal is a manual invoice.",
          "",
          "My read: bundle, and make TID-431 the blocker rather than the price.",
        ].join("\n"),
      },
    },
    {
      kind: "upload",
      id: "memo-attach",
      room: "decision-memo",
      as: "priya",
      title: DECISION_MEMO_TITLE,
      fileName: "insights-pricing-decision-memo.md",
      mimeType: "text/markdown",
      content: [
        `# ${DECISION_MEMO_TITLE}`,
        "",
        "Recommendation: fold Insights into Growth at a $4k uplift.",
        "",
        "## The case for bundling",
        "",
        "Sales report the separate line item, not the price, is what stalls deals. Two",
        "renewals this quarter asked for Insights to be included. The bundled case",
        "reaches the Q4 revenue target at 41 attached accounts.",
        "",
        "## The case against",
        "",
        "ARPA floor is $31k and the bundle clears it, but not by much. TID-431 means",
        "billing has no bundle SKU, so nothing can be quoted until it exists.",
        "",
      ].join("\n"),
    },
    {
      kind: "create_workstream",
      id: "renewal-open",
      room: "northgate-renewal",
      as: "marcus",
      title: "Northgate renewal: what we owe them on Insights",
      participants: ["dana", "priya"],
      scope: "workspace",
      openingMessage: [
        "Northgate renewal is up. They are on the 2024 Growth agreement — 140 seats, a",
        "6% uplift cap at renewal, and a 60-day notice window that opens in eleven",
        "days. Insights was given to them free during the pilot and never added to the",
        "order form. Before we quote it I want to know what we actually owe them on it.",
      ].join(" "),
      assistant: {
        kind: "say",
        text: [
          "On the terms you describe, nothing. Insights is not on the order form, the",
          "pilot grant was free, and the Growth agreement's uplift cap governs the seats,",
          "not an add-on it never named. What you owe them is the conversation: a year",
          "of use is not an entitlement, but nothing in the paperwork stops them reading",
          "it as one, and the notice window opens in eleven days — so the position has",
          "to be settled before then, not argued during it.",
        ].join("\n"),
      },
    },
    {
      kind: "message",
      id: "renewal-dana-1",
      room: "northgate-renewal",
      as: "dana",
      text: "Legally nothing. Practically, they have a year of usage and a champion who will "
        + "say it was always part of the deal.",
    },
    {
      kind: "message",
      id: "renewal-priya-1",
      room: "northgate-renewal",
      as: "priya",
      text: "Their usage is real — 40-odd weekly actives on Insights out of 140 seats. Pulling "
        + "it at renewal is the version of this that loses the account.",
    },
    {
      kind: "message",
      id: "renewal-marcus-1",
      room: "northgate-renewal",
      as: "marcus",
      text: "I am not proposing we pull it. I am asking whether it goes on the order form at "
        + "$12k, at the $4k Growth uplift, or at zero.",
    },
    {
      kind: "message",
      id: "renewal-dana-2",
      room: "northgate-renewal",
      as: "dana",
      text: "Zero sets the precedent for every renewal behind them. I would rather lose the "
        + "6% uplift than the line item.",
    },
    {
      kind: "message",
      id: "renewal-priya-2",
      room: "northgate-renewal",
      as: "priya",
      text: "@{presenter} you own the commercial call here — we cannot answer this without you.",
    },
    {
      kind: "message",
      id: "renewal-marcus-2",
      room: "northgate-renewal",
      as: "marcus",
      text: "We are going in circles and the notice window opens in eleven days. Rally, take "
        + "the three positions above and tell me which one the proposal should argue for.",
      assistant: {
        kind: "ask",
        prompt: [
          "Northgate's notice window opens in eleven days and the room disagrees about",
          "what Insights costs them at renewal. @{dana} would hold the line item and give",
          "up the 6% uplift; @{priya} would not pull Insights at renewal; @{marcus}",
          "wants a number on the order form. Which position should the renewal proposal",
          "argue for? I will draft the argument for whichever you pick.",
        ].join(" "),
        options: [
          "Include Insights at no uplift — protect the renewal",
          "Include Insights at the $4k Growth uplift",
          "Keep Insights as a separate $12k add-on and hold the line",
        ],
      },
    },
    {
      kind: "sidekick",
      id: "morning-briefing",
      as: "priya",
      // Workspace-scoped, so every member is offered it and the presenter finds
      // it in their Sidekick strip without anybody having shared it.
      scope: "workspace",
      name: "Morning briefing",
      description: "Posts a short briefing each weekday morning on what moved overnight and what needs a decision today.",
      overview: [
        "Every weekday at 9am Pacific, this Sidekick reads the work streams it can see and",
        "writes one short briefing: what changed since yesterday, what is waiting on somebody,",
        "and which decisions have a date attached. It states what it found and stops; it does",
        "not chase people or answer on their behalf.",
      ].join(" "),
      instructions: [
        "Each weekday morning, write one briefing for the workspace.",
        "",
        "Cover, in this order, and only from what the work streams actually say:",
        "",
        "1. Decisions with a date. Name the decision, who owns it, and the date.",
        "2. Anything waiting on a person, with who it is waiting on.",
        "3. What moved since the previous briefing.",
        "",
        "Keep it under 200 words. Every claim must come from a work stream you can read —",
        "if a number or a date is not written down somewhere, leave it out rather than",
        "estimating it. Say plainly when there is nothing to report.",
      ].join("\n"),
      schedule: {
        // Weekdays at 9am in the zone the demo is presented in.
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Every weekday at 9:00am Pacific",
      },
      // One briefing it has already written, so the demo shows a Sidekick that
      // has done something rather than one that is merely configured. It cites
      // only what the two rooms above hold, for the same reason their own
      // assistant turns do: a seeded run makes no tool call, so anything it
      // claims to have read has to be something the seeded history contains.
      firstRun: {
        kind: "say",
        text: [
          "**Two decisions have a date on them.**",
          "",
          "The Northgate renewal is the near one: the 60-day notice window opens in eleven",
          "days, and the room is split on what Insights costs at renewal — @{dana} would hold",
          "the line item and give up the 6% uplift, @{priya} would not pull Insights, and",
          "@{marcus} wants a number on the order form. It is waiting on a commercial call.",
          "",
          "Insights pricing itself is the other. The memo recommends folding Insights into",
          "Growth at a $4k uplift, which clears the $31k ARPA floor and reaches the Q4 target",
          "at 41 attached accounts against 18 for the add-on. TID-431 is the blocker, not the",
          "price: billing has no bundle SKU, so the first bundled deal is a manual invoice.",
          "",
          "Nothing else moved overnight.",
        ].join("\n"),
      },
    },
    {
      kind: "create_workstream",
      id: "press-open",
      room: "press-release",
      as: "marcus",
      title: "The going-public announcement",
      participants: ["priya", "dana"],
      scope: "workspace",
      openingMessage: [
        "We need the announcement written before the filing goes public. The bankers",
        "want a draft with the syndicate by Thursday, and the filing goes up the",
        "Tuesday after. Constraints I know about: legal has not cleared the ticker,",
        "and we are inside the quiet period from the day we file. What I want is a",
        "release that leads with the business rather than the raise. The numbers I",
        "would use: ARR crossed $140m last quarter, net revenue retention is 118%, and",
        "1,900 companies run on us. Draft it, and tell me which of those three I",
        "should expect to be argued about.",
      ].join(" "),
      assistant: {
        kind: "say",
        text: [
          "Here is the shape I would write, and the number I would expect trouble over.",
          "",
          "**Lead.** The business, as you asked: 1,900 companies, ARR over $140m,",
          "retention at 118%. That is a growth story that stands without the listing in",
          "it, and the listing is one line at the end of the first paragraph.",
          "",
          "**Then the filing, flatly.** What was filed, where it will list, and that the",
          "ticker is not final. Not the date it goes up, which is the bankers' to give",
          "out, and no price — a range in a press release is a claim about a number",
          "nobody has set yet.",
          "",
          "**The number to expect trouble over is 118%.** ARR and the customer count are",
          "facts as of a quarter you can name. Net revenue retention is a computed",
          "figure, and the release will be read against whatever definition the filing",
          "uses. If the two differ, the release is the one that looks wrong.",
          "",
          "One thing I cannot judge from this room: what the quiet period lets you say",
          "at all. @{dana} should read the draft before the syndicate does.",
        ].join("\n"),
      },
    },
    {
      kind: "upload",
      id: "press-v1",
      room: "press-release",
      as: "marcus",
      title: `${PRESS_RELEASE_TITLE} v1`,
      fileName: "announcement-v1.md",
      mimeType: "text/markdown",
      content: [
        "# Announcement — draft 1",
        "",
        "1,900 companies now run their work on our platform. Annual recurring revenue",
        "passed $140m last quarter, and net revenue retention stands at 118%.",
        "",
        "Today we filed to go public. We expect to list on the Nasdaq; the ticker is",
        "not yet final.",
        "",
        "This is a milestone for our customers more than for us. We are going to keep",
        "building the same product, on the same roadmap, for the same people.",
        "",
      ].join("\n"),
    },
    {
      kind: "message",
      id: "press-dana-1",
      room: "press-release",
      as: "dana",
      text: [
        "Three problems, one of them serious. \"We are going to keep building\" is a",
        "forward-looking statement with no safe-harbour language anywhere near it —",
        "either it goes or the release carries the disclaimer. \"A milestone for our",
        "customers\" is puffery and I do not care. The serious one is 118%: the filing",
        "computes retention on a trailing twelve-month basis and I do not know that",
        "this number does.",
      ].join(" "),
    },
    {
      kind: "message",
      id: "press-priya-1",
      room: "press-release",
      as: "priya",
      text: [
        "It does not. 118% is the quarterly cohort figure we report internally. On the",
        "trailing twelve-month basis the filing uses it is 112%. Both are true and they",
        "are not the same measurement, which is exactly the trap.",
      ].join(" "),
    },
    {
      kind: "message",
      id: "press-marcus-1",
      room: "press-release",
      as: "marcus",
      text: [
        "Rally, take @{dana}'s three and @{priya}'s correction and tell me what the",
        "second draft has to change. I would rather cut a sentence than carry a",
        "disclaimer.",
      ].join(" "),
      assistant: {
        kind: "say",
        text: [
          "Then cut the sentence. Three changes, in the order they matter.",
          "",
          "**Retention becomes 112%, on the trailing twelve months, and says so.** This",
          "is the only change that is about being wrong rather than about being careful.",
          "Two defensible numbers under one name is how a release ends up contradicting",
          "the filing it was written to accompany, and the filing is the one that",
          "governs.",
          "",
          "**The last paragraph goes.** \"We are going to keep building\" is the",
          "forward-looking statement; without it there is nothing in the draft that needs",
          "safe-harbour language, and you avoid the disclaimer you did not want.",
          "",
          "**\"A milestone for our customers\" goes with it.** Not because it is a legal",
          "problem — @{dana} said it is not — but because it is the sentence that was",
          "carrying the paragraph, and the paragraph is gone.",
          "",
          "That leaves the release ending on the filing itself, which is the fact you",
          "are announcing.",
        ].join("\n"),
      },
    },
    {
      kind: "upload",
      id: "press-v2",
      room: "press-release",
      as: "marcus",
      title: `${PRESS_RELEASE_TITLE} v2`,
      fileName: "announcement-v2.md",
      mimeType: "text/markdown",
      content: [
        "# Announcement — draft 2",
        "",
        "1,900 companies now run their work on our platform. Annual recurring revenue",
        "passed $140m last quarter, and net revenue retention over the trailing twelve",
        "months stands at 112%.",
        "",
        "Today we filed to go public. We expect to list on the Nasdaq; the ticker is",
        "not yet final.",
        "",
      ].join("\n"),
    },
    {
      kind: "message",
      id: "press-dana-2",
      room: "press-release",
      as: "dana",
      text: [
        "That clears everything I raised. One thing I did not: \"we expect to list\" is",
        "itself forward-looking. Say what was filed and where the application was made,",
        "and let the reader draw the conclusion.",
      ].join(" "),
    },
    {
      kind: "upload",
      id: "press-v3",
      room: "press-release",
      as: "marcus",
      title: `${PRESS_RELEASE_TITLE} v3`,
      fileName: "announcement-v3.md",
      mimeType: "text/markdown",
      content: [
        "# Announcement — draft 3",
        "",
        "1,900 companies now run their work on our platform. Annual recurring revenue",
        "passed $140m last quarter, and net revenue retention over the trailing twelve",
        "months stands at 112%.",
        "",
        "Today we filed a registration statement with the Securities and Exchange",
        "Commission and applied to list our common stock on the Nasdaq Global Select",
        "Market. The ticker is not yet final.",
        "",
      ].join("\n"),
    },
    {
      kind: "message",
      id: "press-marcus-2",
      room: "press-release",
      as: "marcus",
      text: "v3 is what goes to the syndicate. Thank you both.",
    },
    {
      kind: "create_substream",
      id: "press-placement-open",
      room: "press-release",
      substream: "placement",
      as: "marcus",
      title: "Who gets it first",
      participants: ["priya", "dana", "presenter"],
      startingContext: [
        "**Request.** Draft the announcement of the filing, leading with the business",
        "rather than the raise, before the draft goes to the syndicate on Thursday.",
        "",
        "**Decisions.** Retention is stated as 112% on a trailing twelve-month basis,",
        "matching the filing, rather than the 118% quarterly cohort figure reported",
        "internally. The closing paragraph was cut rather than carrying safe-harbour",
        "language. The release says what was filed and where the listing application",
        "was made, not what the company expects to happen.",
        "",
        "**Done.** Three drafts. v3 is the one going to the syndicate.",
        "",
        "**Facts.** 1,900 companies on the platform. ARR over $140m as of last",
        "quarter. Retention 112% trailing twelve months, 118% quarterly cohort. The",
        "ticker is not cleared. The quiet period runs from the filing.",
        "",
        "**Relevant attachments.** Announcement — listing v1, v2 and v3.",
        "",
        "**Open.** Where the announcement is placed, and in what order.",
      ].join("\n"),
    },
    {
      kind: "message",
      id: "press-placement-marcus-1",
      room: "press-release",
      substream: "placement",
      as: "marcus",
      text: [
        "Placement, away from the drafting. My instinct is one exclusive to a business",
        "desk an hour ahead of the wire, and everyone else off the wire. The Journal or",
        "Bloomberg — I would take either.",
      ].join(" "),
    },
    {
      kind: "message",
      id: "press-placement-priya-1",
      room: "press-release",
      substream: "placement",
      as: "priya",
      text: [
        "An exclusive to a general business desk gets us a story about the raise, which",
        "is the story we spent three drafts not writing. The trade press is where our",
        "buyers actually read, and they will cover the product because that is what",
        "they cover.",
      ].join(" "),
    },
    {
      kind: "message",
      id: "press-placement-dana-1",
      room: "press-release",
      substream: "placement",
      as: "dana",
      text: [
        "Whoever it is, they get the release and nothing else. An exclusive usually",
        "comes with a briefing call, and a briefing call inside the quiet period is how",
        "you end up explaining an unfiled number to a regulator. No call, no background,",
        "no colour.",
      ].join(" "),
    },
    {
      kind: "message",
      id: "press-placement-marcus-2",
      room: "press-release",
      substream: "placement",
      as: "marcus",
      text: "Rally, we are three for three on different answers. Sort it out.",
      assistant: {
        kind: "say",
        text: [
          "You are not disagreeing about the same question, which is why it will not",
          "settle.",
          "",
          "@{dana}'s constraint decides the format, not the outlet: no briefing call, no",
          "background, no colour. That holds whoever gets it. Once it holds, an exclusive",
          "is worth much less than it usually is — what you are offering is an hour's",
          "head start on a document, not access — so the case for spending one narrows to",
          "who you most want writing first.",
          "",
          "@{priya}'s point answers that. Your buyers read the trade press, and the trade",
          "press will write about the product because that is their beat. A general",
          "business desk will write about the raise, and you have removed everything from",
          "the release that would help them write anything else.",
          "",
          "So: the head start goes to a trade outlet, the wire carries it to everyone",
          "else at the same moment, and nobody gets a call. The one thing I would not",
          "decide from this room is which trade outlet — that turns on relationships",
          "none of you have described here.",
        ].join("\n"),
      },
    },
    {
      kind: "message",
      id: "press-placement-priya-2",
      room: "press-release",
      substream: "placement",
      as: "priya",
      text: "Agreed. I will put three trade outlets and who we know at each in here tomorrow.",
    },
  ],
  // The presenter's view, which is the demo. All three rooms are
  // workspace-scoped, so all three are offered; the presenter is seated in the
  // renewal room only, by Priya's mention, and has opened nothing — so that
  // room is unseen and mentioned, the other two are merely unread, and the home
  // screen says one thing is waiting on them, for the mention.
  //
  // The placement substream is deliberately absent, and its absence is the
  // point: a private child takes no directory row and contributes nothing to
  // attention, so the presenter's home screen still counts one. They find it by
  // opening the press-release room, where they are a participant of the child
  // without being a participant of its parent.
  expect: [{
    viewer: "presenter",
    attention: { waitingForYou: 1, waitingReason: "mentioned" },
    rooms: {
      "decision-memo": { unseen: false, hasUnread: true, mentioned: false },
      "northgate-renewal": { unseen: true, hasUnread: true, mentioned: true },
      "press-release": { unseen: false, hasUnread: true, mentioned: false },
    },
  }],
} satisfies z.input<typeof DemoPackSchema>;
