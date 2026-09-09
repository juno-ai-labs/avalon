/**
 * The conversation pack, and the plan the seeder plays from it.
 *
 * A pack is versioned data behind a schema: a cast of roles, and an ordered
 * list of steps that create rooms, say things in them as cast members, and
 * attach documents. Roles are bound to real accounts only when a demo is
 * prepared, so one pack serves every demo and the pack never names a user id.
 * What Rally says in a seeded room is part of the step that starts the run
 * (`assistant`) — prose that carries its findings itself, with no tool call
 * behind it, because a seeded transcript records nothing Rally did not do.
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
  DemoSeedTurnSchema,
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
 * The one role a real person plays. The presenter signs in and the demo is
 * their view of it, so their name is their account's; every other role is
 * played by a persona named when the demo is prepared, which is why the pack
 * carries a default name for those and none for this one. A pack without this
 * role is cast entirely from personas.
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

const MessageStepSchema = z.strictObject({
  kind: z.literal("message"),
  id: StepIdSchema,
  room: RoomKeySchema,
  as: DemoPackRoleSchema,
  text: MessageTextSchema,
  /** What Rally says when this message starts a run. Absent: it starts none. */
  assistant: DemoSeedTurnSchema.optional(),
});

const UploadStepSchema = z.strictObject({
  kind: z.literal("upload"),
  id: StepIdSchema,
  room: RoomKeySchema,
  as: DemoPackRoleSchema,
  title: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.enum(["text/markdown", "text/plain"]),
  content: z.string().min(1),
});

export const DemoPackStepSchema = z.discriminatedUnion("kind", [
  CreateWorkstreamStepSchema,
  MessageStepSchema,
  UploadStepSchema,
]);
export type DemoPackStep = z.infer<typeof DemoPackStepSchema>;

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
 */
export function packRoomFacts(steps: readonly DemoPackStep[]): Map<string, DemoPackRoomFacts> {
  const rooms = new Map<string, DemoPackRoomFacts>();
  steps.forEach((step, index) => {
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
   * The name each cast role is offered under in the New demo form. A
   * suggestion the operator types over, not a binding: the pack's prose names
   * people by role token and reads the same whoever plays them.
   */
  castDefaults: z.record(DemoPackRoleSchema, z.string().trim().min(1).max(80)).default({}),
}).superRefine((pack, context) => {
  const roles = new Set(pack.roles);
  // Every role the operator has to name, and only those: a form field with no
  // default would open empty, and a default for a role nobody plays is dead
  // data that would read as a fourth person in the demo.
  const named = new Set(demoCastRoles(pack.roles));
  for (const role of named) {
    if (!pack.castDefaults[role]) {
      context.addIssue({ code: "custom", path: ["castDefaults"], message: `Role "${role}" has no default name` });
    }
  }
  for (const role of Object.keys(pack.castDefaults)) {
    if (!named.has(role)) {
      context.addIssue({ code: "custom", path: ["castDefaults", role], message: `"${role}" is not a role the operator names` });
    }
  }
  // Two people under one name is refused when a demo is started, so a pack
  // whose defaults collide would open a form that cannot be submitted.
  const defaults = Object.values(pack.castDefaults).map((name) => name.toLowerCase());
  if (new Set(defaults).size !== defaults.length) {
    context.addIssue({ code: "custom", path: ["castDefaults"], message: "Default names must differ" });
  }
  if (roles.size !== pack.roles.length) {
    context.addIssue({ code: "custom", path: ["roles"], message: "Roles must be unique" });
  }
  const ids = new Set<string>();
  /** Who is in each room so far: the creator, the seated, and the mentioned. */
  const seated = new Map<string, Set<string>>();
  const asked = new Set<string>();
  pack.steps.forEach((step, index) => {
    const path = ["steps", index];
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: [...path, "id"], message: `Step id "${step.id}" is used twice` });
    }
    ids.add(step.id);
    const named = [step.as, ...(step.kind === "create_workstream" ? step.participants : [])];
    for (const role of named) {
      if (!roles.has(role)) {
        context.addIssue({ code: "custom", path, message: `Role "${role}" is not in the cast` });
      }
    }
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
    if (step.kind === "create_workstream") {
      if (seated.has(step.room)) {
        context.addIssue({ code: "custom", path: [...path, "room"], message: `Room "${step.room}" is created twice` });
      }
      if (step.participants.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "participants"], message: "The author is seated already" });
      }
      seated.set(step.room, new Set([step.as, ...step.participants, ...mentions]));
      return;
    }
    const room = seated.get(step.room);
    if (!room) {
      context.addIssue({ code: "custom", path: [...path, "room"], message: `Room "${step.room}" is used before it is created` });
      return;
    }
    if (asked.has(step.room)) {
      // The `ask` parked its run on a real open elicitation. Anything said in
      // the room after that is said into a question nobody has answered, and
      // the presenter is the one who is meant to answer it.
      context.addIssue({ code: "custom", path, message: `Room "${step.room}" continues after its question` });
    }
    if (!room.has(step.as)) {
      // The production path admits a message from a workspace member who is
      // not in the room only by seating them, which is a fact the pack would
      // be relying on by accident. Say who is in the room instead.
      context.addIssue({ code: "custom", path: [...path, "as"], message: `Role "${step.as}" is not in room "${step.room}"` });
    }
    for (const role of mentions) room.add(role);
    if (step.kind === "message" && step.assistant?.kind === "ask") asked.add(step.room);
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
  room: string;
  /** The cast member who does this, by user id. */
  actorUserId: string;
}

export type DemoSeedAction =
  | (ActionBase & {
      kind: "create_workstream";
      title: string;
      scope: "workspace" | "personal";
      participantUserIds: string[];
      openingMessage: string;
      mentions: Mention[];
      seed: DemoSeed;
    })
  | (ActionBase & {
      kind: "message";
      text: string;
      mentions: Mention[];
      confirmedParticipantUserIds: string[];
      seed: DemoSeed;
    })
  | (ActionBase & {
      kind: "upload";
      title: string;
      fileName: string;
      mimeType: "text/markdown" | "text/plain";
      content: string;
    });

/**
 * The actions a pack plays as, once its roles are bound.
 *
 * Every role the pack names must be bound: a pack that plays a role nobody is
 * cast in is not playable, and that is found here rather than at the message
 * that needed them.
 */
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
      case "message": {
        const resolved = resolveMentions(step.text, cast);
        return {
          kind: "message",
          actionId: step.id,
          room: step.room,
          actorUserId: actor.userId,
          text: resolved.text,
          mentions: resolved.mentions,
          confirmedParticipantUserIds: resolved.mentionedUserIds,
          seed: seed(step, step.assistant ?? null),
        };
      }
      case "upload":
        return {
          kind: "upload",
          actionId: step.id,
          room: step.room,
          actorUserId: actor.userId,
          title: step.title,
          fileName: step.fileName,
          mimeType: step.mimeType,
          content: step.content,
        };
    }
  });
}

const DECISION_MEMO_TITLE = "Insights pricing — decision memo";

/**
 * The pack the feature is built and proved against.
 *
 * It carries the two scenarios the spike settled — the decision memo and the
 * multiplayer renewal — and nothing else: the spike's onboarding-email room was
 * invented to test a third directory row and is not approved copy. The cast
 * roles, their names, and the third scenario are open inputs the PRD hands to
 * the team; this pack is what runs until they arrive, and swapping it is a
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
  roles: ["presenter", "priya", "marcus", "dana"],
  // What the form opens with, in the order the operator meets them: product,
  // sales and legal. Deliberately not the role keys the pack was written
  // around — the cast is invented for whoever is being presented to, and a
  // default that reads as a person is easier to type over than one that reads
  // as this pack's own character.
  castDefaults: { priya: "Emma Shipman", marcus: "Sam Burton", dana: "Ben Diaz" },
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
  ],
  // The presenter's view, which is the demo. Both rooms are workspace-scoped,
  // so both are offered; the presenter is in the renewal room only, by Priya's
  // mention, and has opened nothing — so that room is unseen and mentioned,
  // the memo room is merely unread, and the home screen says one thing is
  // waiting on them, for the mention.
  expect: [{
    viewer: "presenter",
    attention: { waitingForYou: 1, waitingReason: "mentioned" },
    rooms: {
      "decision-memo": { unseen: false, hasUnread: true, mentioned: false },
      "northgate-renewal": { unseen: true, hasUnread: true, mentioned: true },
    },
  }],
} satisfies z.input<typeof DemoPackSchema>;
