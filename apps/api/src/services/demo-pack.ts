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
import type { z } from "zod";

import {
  type DemoSeed,
  type DemoSeedTurn,
  type Message,
} from "@rally/contracts";
import {
  DEMO_PACK_MENTION_TOKEN,
  DemoPackShapeSchema,
  type DemoPackRole,
  type DemoPackStep,
  type DemoViewerExpectation,
} from "@rally/contracts/demo-pack";

export {
  DemoPackRoleSchema,
  DemoPackStepSchema,
  type DemoPackRole,
  type DemoPackStep,
  type DemoViewerExpectation,
} from "@rally/contracts/demo-pack";

const MENTION_TOKEN = DEMO_PACK_MENTION_TOKEN;

type Mention = Message["mentions"][number];


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
  finalState: "idle" | "needs_input" | "completed";
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
        finalState: step.execution === "history" ? "idle" : step.assistant.kind === "ask" ? "needs_input" : "completed",
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
 * the third. Each issue names its rule in `params.rule`, which is the stable
 * code the Demo MCP's check reports in place of the message: a message here
 * quotes the pack's own values, and the check must not echo them back.
 */
export const DemoPackSchema = DemoPackShapeSchema.superRefine((pack, context) => {
  const roles = new Set(pack.roles);
  // Every role the operator casts, and only those: an unlabelled dropdown
  // says nothing about the part, and a label for a role nobody plays would
  // read as one more person in the demo.
  const cast = new Set(demoCastRoles(pack.roles));
  for (const role of cast) {
    if (!pack.roleLabels[role]) {
      context.addIssue({ code: "custom", path: ["roleLabels"], params: { rule: "demo_pack_role_label_missing" }, message: `Role "${role}" has no label` });
    }
  }
  for (const role of Object.keys(pack.roleLabels)) {
    if (!cast.has(role)) {
      context.addIssue({ code: "custom", path: ["roleLabels", role], params: { rule: "demo_pack_role_label_unused" }, message: `"${role}" is not a role the operator casts` });
    }
  }
  if (roles.size !== pack.roles.length) {
    context.addIssue({ code: "custom", path: ["roles"], params: { rule: "demo_pack_role_duplicate" }, message: "Roles must be unique" });
  }
  for (const [key, space] of Object.entries(pack.spaces ?? {})) {
    if (!roles.has(space.as)) context.addIssue({ code: "custom", path: ["spaces", key, "as"], params: { rule: "demo_pack_role_not_in_cast" }, message: "Space creator is not in the cast" });
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
    if (step.kind === "create_workstream" && step.space && !pack.spaces?.[step.space]) {
      context.addIssue({ code: "custom", path: [...path, "space"], params: { rule: "demo_pack_space_not_declared" }, message: "Space is not declared in the pack" });
    }
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: [...path, "id"], params: { rule: "demo_pack_step_id_duplicate" }, message: `Step id "${step.id}" is used twice` });
    }
    ids.add(step.id);
    const named = [step.as, ...(step.kind === "create_workstream" || step.kind === "create_substream" ? step.participants : [])];
    for (const role of named) {
      if (!roles.has(role)) {
        context.addIssue({ code: "custom", path, params: { rule: "demo_pack_role_not_in_cast" }, message: `Role "${role}" is not in the cast` });
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
          context.addIssue({ code: "custom", path, params: { rule: "demo_pack_role_not_in_cast" }, message: `The Sidekick's prose names role "${role}", which is not in the cast` });
        }
      }
      const name = step.name.trim().toLowerCase();
      if (sidekickNames.has(name)) {
        // The directory lists Sidekicks by title and the barrier matches a
        // viewer's row by name, so two under one name would make one of them
        // unverifiable.
        context.addIssue({ code: "custom", path: [...path, "name"], params: { rule: "demo_pack_sidekick_name_duplicate" }, message: `Two Sidekicks are named "${step.name}"` });
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
        context.addIssue({ code: "custom", path, params: { rule: "demo_pack_role_not_in_cast" }, message: `Mentioned role "${role}" is not in the cast` });
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
        context.addIssue({ code: "custom", path: [...path, "assistant"], params: { rule: "demo_pack_role_not_in_cast" }, message: `Rally's turn names role "${role}", which is not in the cast` });
      }
    }
    // A substream's starting context is Rally's prose too, and it names people
    // with the same tokens. Unbound there it would throw mid-seed, after the
    // work stream it hangs off already exists.
    if (step.kind === "create_substream") {
      for (const role of mentionedRoles(step.startingContext)) {
        if (!roles.has(role)) {
          context.addIssue({ code: "custom", path: [...path, "startingContext"], params: { rule: "demo_pack_role_not_in_cast" }, message: `The starting context names role "${role}", which is not in the cast` });
        }
      }
    }
    if (step.kind === "create_workstream") {
      if (step.execution === "history" && (step.assistant.kind !== "say" || mentions.length)) {
        context.addIssue({ code: "custom", path, params: { rule: "demo_pack_history_live_effects" }, message: "Prepared history requires prose without live mention effects" });
      }
      if (seated.has(step.room)) {
        context.addIssue({ code: "custom", path: [...path, "room"], params: { rule: "demo_pack_room_created_twice" }, message: `Room "${step.room}" is created twice` });
      }
      if (step.participants.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "participants"], params: { rule: "demo_pack_already_seated" }, message: "The author is seated already" });
      }
      roomScope.set(step.room, step.scope);
      seated.set(step.room, new Set([step.as, ...step.participants, ...mentions]));
      return;
    }
    if (step.kind === "create_substream") {
      const parent = seated.get(step.room);
      if (!parent) {
        context.addIssue({ code: "custom", path: [...path, "room"], params: { rule: "demo_pack_room_not_created" }, message: `Room "${step.room}" is used before it is created` });
        return;
      }
      const owner = substreams.get(step.substream);
      if (owner !== undefined) {
        context.addIssue({ code: "custom", path: [...path, "substream"], params: { rule: "demo_pack_substream_created_twice" }, message: `Substream "${step.substream}" is created twice` });
      }
      if (step.participants.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "participants"], params: { rule: "demo_pack_already_seated" }, message: "The creator is in it already" });
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
            params: { rule: "demo_pack_personal_substream_outsider" }, message: `Role "${role}" cannot be put in a substream of personal room "${step.room}" without being in it`,
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
        context.addIssue({ code: "custom", path: [...path, "substream"], params: { rule: "demo_pack_substream_wrong_room" }, message: `Substream "${step.substream}" is not a substream of room "${step.room}"` });
      } else {
        context.addIssue({ code: "custom", path: [...path, "room"], params: { rule: "demo_pack_room_not_created" }, message: `Room "${conversation}" is used before it is created` });
      }
      return;
    }
    if (asked.has(conversation)) {
      // The `ask` parked its run on a real open elicitation. Anything said in
      // the room after that is said into a question nobody has answered, and
      // the presenter is the one who is meant to answer it.
      context.addIssue({ code: "custom", path, params: { rule: "demo_pack_after_question" }, message: `Room "${conversation}" continues after its question` });
    }
    if (!room.has(step.as)) {
      // The production path admits a message from a workspace member who is
      // not in the room only by seating them, which is a fact the pack would
      // be relying on by accident. Say who is in the room instead.
      context.addIssue({ code: "custom", path: [...path, "as"], params: { rule: "demo_pack_speaker_not_seated" }, message: `Role "${step.as}" is not in room "${conversation}"` });
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
          params: { rule: "demo_pack_substream_mention_not_member" }, message: `Role "${role}" is mentioned in substream "${conversation}" without being in it`,
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
      context.addIssue({ code: "custom", path, params: { rule: "demo_pack_viewer_duplicate" }, message: `Viewer "${expectation.viewer}" is expected twice` });
    }
    viewers.add(expectation.viewer);
    if (!roles.has(expectation.viewer)) {
      context.addIssue({ code: "custom", path, params: { rule: "demo_pack_viewer_not_in_cast" }, message: `Viewer "${expectation.viewer}" is not in the cast` });
      return;
    }
    const visible = new Set(visibleRoomsFor(expectation.viewer, facts.values()).map((room) => room.room));
    const listed = new Set(Object.keys(expectation.rooms));
    for (const room of visible) {
      if (!listed.has(room)) {
        context.addIssue({ code: "custom", path: [...path, "rooms"], params: { rule: "demo_pack_expect_rooms_mismatch" }, message: `Viewer "${expectation.viewer}" will see room "${room}", which is not expected` });
      }
    }
    for (const room of listed) {
      if (!visible.has(room)) {
        context.addIssue({ code: "custom", path: [...path, "rooms", room], params: { rule: "demo_pack_expect_rooms_mismatch" }, message: `Viewer "${expectation.viewer}" will not see room "${room}"` });
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
      execution: "run" | "history";
      space?: string;
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
          execution: step.execution ?? "run",
          ...(step.space ? { space: step.space } : {}),
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

/**
 * Three independent collaboration stories: teammate expertise changes an Acme
 * proposal, an approver changes vendor criteria and decides, and a demo review
 * becomes owned follow-up. The last main-channel beat makes Acme proposal the
 * default entry. Prepared history is illustrative, and no seeded connector
 * delivery is claimed. Version changes require a fresh demo Organization.
 * Every assistant turn uses only facts explicitly shared in its conversation;
 * seeded runs make no tool calls and cannot fetch private or external context.
 * Keep this literal unparsed at module load: a bad pack must not stop the API.
 */
export const PLACEHOLDER_DEMO_PACK = {
  version: "multiplayer-2026-09",
  // Stable role tokens identify parts; roleLabels describes their current jobs.
  roles: ["presenter", "priya", "marcus", "dana"],
  roleLabels: {
    priya: "Solutions engineer / IT",
    marcus: "Sales lead / business owner",
    dana: "Manager / finance approver",
  },
  spaces: {
    acme: { as: "marcus", name: "Customer: Acme", iconKey: "handshake", colorKey: "blue" },
    vendors: { as: "marcus", name: "Vendor selection: Customer support platform", iconKey: "list-checks", colorKey: "purple" },
    sales: { as: "marcus", name: "Sales", iconKey: "chart-no-axes-combined", colorKey: "green" },
  },
  steps: [
    {
      kind: "create_workstream",
      id: "vendor-open",
      room: "vendor-selection",
      as: "marcus",
      title: "Evaluation & decision",
      space: "vendors",
      participants: ["priya"],
      scope: "workspace",
      openingMessage: "We need a support platform for 25 agents: SSO, EU data hosting and migration included. Budget is $45k in year one. ClearDesk: $24k + $6k setup, eight weeks. HelpHarbor: $30k + $9k, three weeks. SupportLane: $27k + $15k, six weeks. All meet the requirements. Start with cost.",
      assistant: {
        kind: "say",
        text: "**Provisional choice: ClearDesk.** $30k in year one, versus HelpHarbor at $39k and SupportLane at $42k. The trade-off is eight weeks to launch.",
      },
    },
    {
      kind: "upload",
      id: "vendor-requirements",
      room: "vendor-selection",
      as: "marcus",
      title: "Requirements & budget",
      fileName: "vendor-requirements.md",
      mimeType: "text/markdown",
      content: "# Requirements & budget\n\nFictional evaluation. 25 support agents. Required: SSO, EU data hosting, existing-ticket migration. First-year cash budget: $45,000 including setup. Initial preference: lowest qualifying first-year cost. No deadline agreed yet.",
    },
    {
      kind: "upload",
      id: "vendor-cleardesk",
      room: "vendor-selection",
      as: "marcus",
      title: "ClearDesk — sample proposal",
      fileName: "vendor-cleardesk.md",
      mimeType: "text/markdown",
      content: "# ClearDesk — sample proposal\n\nFictional quote for 25 agents. Annual subscription: $24,000. One-time implementation: $6,000. Year-one total: $30,000. Implementation: 8 weeks from approval. Includes SSO, EU data hosting and ticket migration. Taxes excluded consistently; internal staff time excluded.",
    },
    {
      kind: "upload",
      id: "vendor-helpharbor",
      room: "vendor-selection",
      as: "marcus",
      title: "HelpHarbor — sample proposal",
      fileName: "vendor-helpharbor.md",
      mimeType: "text/markdown",
      content: "# HelpHarbor — sample proposal\n\nFictional quote for 25 agents. Annual subscription: $30,000. One-time implementation: $9,000. Year-one total: $39,000. Implementation: 3 weeks from approval. Includes SSO, EU data hosting and ticket migration. Taxes excluded consistently; internal staff time excluded.",
    },
    {
      kind: "upload",
      id: "vendor-supportlane",
      room: "vendor-selection",
      as: "marcus",
      title: "SupportLane — sample proposal",
      fileName: "vendor-supportlane.md",
      mimeType: "text/markdown",
      content: "# SupportLane — sample proposal\n\nFictional quote for 25 agents. Annual subscription: $27,000. One-time implementation: $15,000. Year-one total: $42,000. Implementation: 6 weeks from approval. Includes SSO, EU data hosting and ticket migration. Taxes excluded consistently; internal staff time excluded.",
    },
    {
      kind: "upload",
      id: "vendor-comparison-v1",
      room: "vendor-selection",
      as: "marcus",
      title: "Vendor comparison — v1",
      fileName: "vendor-comparison-v1.md",
      mimeType: "text/markdown",
      content: "# Vendor comparison — v1\n\nProvisional: ClearDesk, lowest qualifying cost.\n\n| Vendor | Annual | Setup | Year one | Launch |\n| --- | ---: | ---: | ---: | --- |\n| ClearDesk | $24,000 | $6,000 | $30,000 | 8 weeks |\n| HelpHarbor | $30,000 | $9,000 | $39,000 | 3 weeks |\n| SupportLane | $27,000 | $15,000 | $42,000 | 6 weeks |\n\nDecision pending reviewer criteria.",
    },
    {
      kind: "message",
      id: "vendor-invite",
      room: "vendor-selection",
      as: "marcus",
      text: "@{dana}, can you make the call? The cheapest option takes eight weeks.",
    },
    {
      kind: "message",
      id: "vendor-criteria",
      room: "vendor-selection",
      as: "dana",
      text: "We must launch within four weeks. Speed matters more than the $9k difference. Keep the $45k ceiling.",
      assistant: {
        kind: "say",
        text: "**Recommendation changes to HelpHarbor.** Three weeks and $39k meet both constraints, leaving $6k. ClearDesk saves $9k but misses the deadline; SupportLane is slower and costs $3k more. Confirm setup is included before approval.",
      },
    },
    {
      kind: "create_substream",
      id: "vendor-costs-open",
      room: "vendor-selection",
      as: "dana",
      substream: "implementation-costs",
      title: "Implementation costs",
      participants: ["priya", "presenter"],
      startingContext: "HelpHarbor is the only quote within four weeks. Confirm the $39k first-year total includes migration before approval.",
    },
    {
      kind: "message",
      id: "vendor-it",
      room: "vendor-selection",
      as: "priya",
      text: "The $9k setup includes ticket migration and SSO. IT can staff the three-week plan; internal time is outside the cash budget.",
      substream: "implementation-costs",
    },
    {
      kind: "message",
      id: "vendor-finance",
      room: "vendor-selection",
      as: "dana",
      text: "$30k + $9k = $39k. That leaves $6k against our $45k cash ceiling.",
      substream: "implementation-costs",
    },
    {
      kind: "message",
      id: "vendor-costs-shared",
      room: "vendor-selection",
      as: "priya",
      text: "Sharing the cost check: setup includes SSO and migration. IT can staff three weeks. $39k is the full first-year cash quote; internal time is separate.",
    },
    {
      kind: "upload",
      id: "vendor-comparison-v2",
      room: "vendor-selection",
      as: "marcus",
      title: "Vendor comparison — v2",
      fileName: "vendor-comparison-v2.md",
      mimeType: "text/markdown",
      content: "# Vendor comparison — v2\n\nUpdated criteria: required capabilities first, launch within four weeks, then first-year cash cost at or below $45,000.\n\n| Vendor | Year one | Launch | Result |\n| --- | ---: | --- | --- |\n| ClearDesk | $30,000 | 8 weeks | Misses deadline |\n| HelpHarbor | $39,000 | 3 weeks | Recommended; $6,000 headroom |\n| SupportLane | $42,000 | 6 weeks | Misses deadline |\n\nChanged from v1: speed is now a hard constraint. HelpHarbor costs $9,000 more than ClearDesk and launches five weeks sooner. Setup includes SSO and migration; IT confirmed staffing. Pending human approval in the Channel.",
    },
    {
      kind: "message",
      id: "vendor-approval",
      room: "vendor-selection",
      as: "dana",
      text: "Approved: HelpHarbor at $39k in year one. @{marcus}, own procurement; @{priya}, own the migration kickoff. This approves the choice, not a signed contract.",
    },
    {
      kind: "create_workstream",
      id: "review-open",
      room: "acme-review",
      as: "marcus",
      title: "Demo & follow-up",
      space: "acme",
      participants: ["priya", "dana"],
      scope: "workspace",
      openingMessage: "Acme demo recap, from a sample Granola-style note: Maya Chen liked the workflow but asked whether NetSuite orders sync automatically. We left that unresolved on the call. Review guide: evidence, open concern, owner, next step.",
      assistant: {
        kind: "say",
        text: "**Needs follow-up:** NetSuite sync is unresolved in this call record. Name a technical owner and a validation step before calling the demo a success.",
      },
    },
    {
      kind: "upload",
      id: "review-transcript",
      room: "acme-review",
      as: "marcus",
      title: "Acme demo call — sample transcript",
      fileName: "review-transcript.md",
      mimeType: "text/markdown",
      content: "# Acme demo call — sample transcript\n\nFictional Granola-style note; no live Granola import. Folder example: Demo Calls.\n\nMaya Chen, Acme operations: The handoff looks useful. Do NetSuite orders sync automatically?\nSales: Let us verify the connector and get back to you.\nMaya: We need order updates without CSV exports.\nSales: Understood. We will follow up.\n\nCall ends with connector availability unresolved. Off-call conversations are not in this note.",
    },
    {
      kind: "upload",
      id: "review-guide",
      room: "acme-review",
      as: "marcus",
      title: "Demo Call Review Guide",
      fileName: "review-guide.md",
      mimeType: "text/markdown",
      content: "# Demo Call Review Guide\n\nEvaluate only supplied evidence. Separate facts, unknowns and decisions. State the customer concern, evidence, owner and next action. Accept explicitly shared off-call context as an attributed correction. Never infer agreement from silence. Draft follow-up; do not send it. Distinguish a sample distribution record from a successful connector receipt.",
    },
    {
      kind: "sidekick",
      id: "demo-call-review",
      as: "marcus",
      scope: "workspace",
      name: "Demo Call Review",
      description: "Reviews supplied demo notes and surfaces the next team action.",
      overview: "Review new demo notes with the Demo Call Review Guide. Keep concerns, evidence and ownership together. The seeded example is illustrative; no external distribution occurred.",
      instructions: "Review supplied demo-call notes against the attached Demo Call Review Guide when those sources are available. Report evidence, unresolved concern, owner and next step. Do not infer private context. If no new note is available, say so. Prepare a review and a short distribution draft; do not send or write to external services. Example intended workflow: Granola Demo Calls → review → Drive Demo Reviews → Slack #demos. Those destinations require actual authorized connector configuration; the seeded sample is not a delivery receipt.",
      schedule: {
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Weekdays at 9:00am Pacific",
      },
      firstRun: {
        kind: "say",
        text: "**Sample review — Acme:** NetSuite sync was unresolved in the supplied call excerpt. Technical validation needs an owner.\n\n**Distribution draft:** Acme needs a connector check before follow-up. No Drive file or Slack message was sent.",
      },
    },
    {
      kind: "message",
      id: "review-sample-share",
      room: "acme-review",
      as: "marcus",
      text: "Sample Sidekick review: “NetSuite sync unresolved; technical owner needed.” Distribution preview: Drive / Demo Reviews and Slack #demos. Nothing was delivered externally.",
    },
    {
      kind: "upload",
      id: "review-v1",
      room: "acme-review",
      as: "marcus",
      title: "Acme demo review — v1",
      fileName: "review-v1.md",
      mimeType: "text/markdown",
      content: "# Acme demo review — v1\n\nSample Sidekick output.\n\nConcern: automatic NetSuite order sync.\nEvidence: unresolved in the demo transcript.\nStatus: technical owner and validation step needed.\nDistribution: preview only; no Drive write or Slack post.",
    },
    {
      kind: "message",
      id: "review-context",
      room: "acme-review",
      as: "marcus",
      text: "After the call, Maya confirmed NetSuite is mandatory. @{priya} already verified the connector needs our Integration package. That context was missing from the transcript.",
      assistant: {
        kind: "say",
        text: "**Correction:** package availability is now known; customer validation is still open. Replace “research connector availability” with “validate Acme’s order flow.” The proposal needs the Integration package.",
      },
    },
    {
      kind: "message",
      id: "review-manager",
      room: "acme-review",
      as: "dana",
      text: "Change one thing: do not promise a launch date yet. @{marcus}, own the customer reply tomorrow; @{priya}, validate the order flow first.",
    },
    {
      kind: "upload",
      id: "review-v2",
      room: "acme-review",
      as: "marcus",
      title: "Acme demo review — v2",
      fileName: "review-v2.md",
      mimeType: "text/markdown",
      content: "# Acme demo review — v2\n\nCorrected from v1 using explicitly shared off-call context: NetSuite is mandatory and the connector requires the Integration package.\n\nResolved: package availability. Still open: Acme order-flow validation. Sales owns tomorrow’s reply; solutions engineering owns the validation. Manager requested no launch-date promise. Draft only; no external distribution.",
    },
    {
      kind: "create_substream",
      id: "review-response-open",
      room: "acme-review",
      as: "marcus",
      substream: "customer-response",
      title: "Customer response",
      participants: ["priya", "dana", "presenter"],
      startingContext: "Draft the Acme reply. NetSuite needs the Integration package; order-flow validation is open. Do not promise a launch date or send the message.",
    },
    {
      kind: "message",
      id: "review-draft",
      room: "acme-review",
      as: "marcus",
      text: "Draft the reply with the package correction and a validation step.",
      assistant: {
        kind: "say",
        text: "Hi Maya — NetSuite order sync requires the Integration package, so we are updating the proposal. Could you share one example order flow for our solutions engineer to validate? We will confirm scope and timing after that check.",
      },
      substream: "customer-response",
    },
    {
      kind: "message",
      id: "review-draft-check",
      room: "acme-review",
      as: "priya",
      text: "Yes. Ask for an order update as well as a new order; both paths need validation.",
      substream: "customer-response",
    },
    {
      kind: "upload",
      id: "review-follow-up-draft",
      room: "acme-review",
      as: "marcus",
      title: "Acme follow-up — draft",
      fileName: "review-follow-up-draft.md",
      mimeType: "text/markdown",
      content: "# Acme follow-up — draft\n\nHi Maya,\n\nNetSuite order sync requires the Integration package, so we are updating the proposal. Could you share an example new order and an order update for our solutions engineer to validate? We will confirm scope and timing after that check.\n\nStatus: draft, not sent. Sales owns the reply; solutions engineering owns validation.",
      substream: "customer-response",
    },
    {
      kind: "message",
      id: "review-next-step",
      room: "acme-review",
      as: "marcus",
      text: "I will send the reviewed draft tomorrow after the order-flow check. It is still a draft.",
      substream: "customer-response",
    },
    {
      kind: "create_workstream",
      id: "sales-open",
      room: "sales-reviews",
      as: "marcus",
      title: "Demo reviews",
      space: "sales",
      participants: [],
      scope: "workspace",
      openingMessage: "Acme review is in Customer: Acme → Demo & follow-up. Correction: NetSuite needs the Integration package. I own tomorrow’s reply; solutions engineering owns validation. Draft is in Customer response. No launch date promised.",
      assistant: {
        kind: "say",
        text: "**Next action:** finish the Acme order-flow check, then use the customer-response draft. The detailed review stays with the account.",
      },
    },
    {
      kind: "create_workstream",
      id: "proposal-open",
      room: "acme-proposal",
      as: "marcus",
      title: "Proposal & solution design",
      space: "acme",
      participants: [],
      scope: "workspace",
      openingMessage: "Continuing my earlier proposal work here (sample history). Acme needs order handoffs for 40 staff. The brief says CRM sync; Growth is $24k/year and includes CRM sync. Draft a Growth proposal.",
      assistant: {
        kind: "say",
        text: "**Draft v1:** Growth at $24k/year, assuming CRM sync covers Acme’s order handoff. Confirm the system of record before sending.",
      },
      execution: "history",
    },
    {
      kind: "upload",
      id: "proposal-brief",
      room: "acme-proposal",
      as: "marcus",
      title: "Acme customer brief",
      fileName: "proposal-brief.md",
      mimeType: "text/markdown",
      content: "# Acme customer brief\n\nFictional customer. Maya Chen, Operations Lead. 40 staff need order handoffs without CSV exports. Initial brief says “CRM sync”; order system not specified. Proposed Growth package: $24,000/year, CRM connector included. Internal working material; no customer guest has access.",
    },
    {
      kind: "upload",
      id: "proposal-v1",
      room: "acme-proposal",
      as: "marcus",
      title: "Acme proposal — v1",
      fileName: "proposal-v1.md",
      mimeType: "text/markdown",
      content: "# Acme proposal — v1\n\nProvisional recommendation: Growth, $24,000/year. CRM sync included. Assumption: CRM is the order system of record. Integration scope and timing require confirmation. Internal draft; not sent.",
    },
    {
      kind: "message",
      id: "proposal-invite",
      room: "acme-proposal",
      as: "marcus",
      text: "@{priya}, joining you to the proposal. Does Growth cover their integration?",
    },
    {
      kind: "message",
      id: "proposal-expert",
      room: "acme-proposal",
      as: "priya",
      text: "Maya told me separately that orders live in NetSuite, not the CRM. Sharing my technical note now: the NetSuite connector needs the $6k/year Integration package. Growth alone will not cover it.",
    },
    {
      kind: "upload",
      id: "proposal-technical-note",
      room: "acme-proposal",
      as: "priya",
      title: "Acme integration note",
      fileName: "proposal-technical-note.md",
      mimeType: "text/markdown",
      content: "# Acme integration note\n\nExplicitly shared technical context. Maya confirmed NetSuite is the order system of record. Growth covers CRM only. NetSuite connector requires Integration at $6,000/year in addition to Growth at $24,000/year. Validate new-order and order-update flows before committing scope or timing. This note was contributed by the solutions engineer; joining alone did not disclose it.",
    },
    {
      kind: "create_substream",
      id: "proposal-integration-open",
      room: "acme-proposal",
      as: "priya",
      substream: "integration-requirements",
      title: "Integration requirements",
      participants: ["marcus", "presenter"],
      startingContext: "Validate Acme’s NetSuite order integration. Growth alone is insufficient; Integration is $6k/year. New-order and order-update flows still need validation.",
    },
    {
      kind: "message",
      id: "proposal-integration-check",
      room: "acme-proposal",
      as: "priya",
      text: "We need a sample new order and an update. No custom connector promised; use the supported NetSuite connector.",
      substream: "integration-requirements",
    },
    {
      kind: "message",
      id: "proposal-integration-share",
      room: "acme-proposal",
      as: "priya",
      text: "Sharing the breakout conclusion here: use the supported NetSuite connector; validate a new order and an update. We have not confirmed timing.",
    },
    {
      kind: "message",
      id: "proposal-revise",
      room: "acme-proposal",
      as: "marcus",
      text: "Revise the proposal using the technical note. Make the changed assumption clear.",
      assistant: {
        kind: "say",
        text: "**Changed assumption:** orders live in NetSuite, not the CRM.\n\n**Draft v2:** Growth $24k + Integration $6k = $30k/year. Growth alone is insufficient. Validate both order flows before committing timing.",
      },
    },
    {
      kind: "upload",
      id: "proposal-v2",
      room: "acme-proposal",
      as: "marcus",
      title: "Acme proposal — v2",
      fileName: "proposal-v2.md",
      mimeType: "text/markdown",
      content: "# Acme proposal — v2\n\nReplaces v1 for internal review.\n\nRecommendation: Growth ($24,000/year) plus Integration ($6,000/year), totaling $30,000/year. Increase from v1: $6,000/year.\n\nChanged assumption: NetSuite is the order system of record; CRM sync alone does not satisfy the requirement. Source: explicitly shared Acme integration note.\n\nNext: validate a new order and an order update with the solutions engineer. Scope and launch timing remain uncommitted. Internal draft; not sent.",
    },
    {
      kind: "message",
      id: "proposal-presenter",
      room: "acme-proposal",
      as: "marcus",
      text: "@{presenter}, v2 now covers NetSuite at $30k/year. The customer draft is ready for review; technical validation is the remaining step.",
    },
  ],
  expect: [
    {
      viewer: "presenter",
      attention: {
        waitingForYou: 1,
        waitingReason: "mentioned",
      },
      rooms: {
        "vendor-selection": {
          unseen: false,
          hasUnread: true,
          mentioned: false,
        },
        "acme-review": {
          unseen: false,
          hasUnread: true,
          mentioned: false,
        },
        "sales-reviews": {
          unseen: false,
          hasUnread: true,
          mentioned: false,
        },
        "acme-proposal": {
          unseen: true,
          hasUnread: true,
          mentioned: true,
        },
      },
    },
  ],
} satisfies z.input<typeof DemoPackSchema>;
