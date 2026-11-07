/**
 * The conversation pack, and the plan the seeder plays from it.
 *
 * A pack is versioned data behind a schema: a cast of roles, and an ordered
 * list of steps in the product's two modes. A **Canvas** step makes a Canvas,
 * says something in its Chat as a cast member (and, when the pack says so, has
 * Rally answer), attaches a document to it, or has Rally publish a version of
 * one of its artifacts. A **Sidekick** step publishes a Sidekick, shared with
 * the people or the Organization the pack names, with a run that has already
 * happened and, optionally, the Canvas that run wrote; a Sidekick message is
 * something a cast member says in its shared conversation. Roles are bound to
 * real accounts only when a demo is prepared, so one pack serves every demo
 * and the pack never names a user id.
 *
 * What Rally says is part of the step that starts its run (`assistant`), prose
 * that carries its findings itself, because a seeded transcript records
 * nothing Rally did not do. A `canvas_artifact` is therefore authored by the
 * Canvas's most recent seeded run: Rally said it in that run, and the version
 * is recorded as that run's.
 *
 * `planDemoSeed` turns a pack and a cast binding into the actions the seeder
 * applies one at a time: names resolved, audiences resolved to user ids, every
 * step carrying the seed the object reads addressing from. The plan is pure —
 * it reads nothing and writes nothing — which is what lets a test prove a pack
 * is playable before anything is written.
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
} from "@rally/contracts";

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
/** The pack's own name for a Canvas or a Sidekick, which later steps address it by. */
const KeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
const MessageTextSchema = z.string().min(1).max(MESSAGE_MAX_CHARACTERS);

/**
 * `@{role}` in prose names a cast member, and the planner writes the bound
 * account's display name in its place. It records no mention: a Canvas or a
 * Sidekick admits its readers by its audience, and a mention seats nobody in
 * either, so the name is all the token is for.
 */
const NAME_TOKEN = /@\{([a-z][a-z0-9-]{0,39})\}/gu;

/**
 * Who a Canvas or a Sidekick is shared with: `"organization"`, or the people
 * besides its creator. An empty list is its creator alone. One spelling for
 * both modes because both are one audience rule (`audienceAdmits`); the
 * planner turns it into each one's own vocabulary.
 */
const SharedWithSchema = z.union([z.literal("organization"), z.array(DemoPackRoleSchema)]);
export type DemoPackSharedWith = z.infer<typeof SharedWithSchema>;

/**
 * Make a Canvas, through `CanvasService.create` as its creator, and share it.
 * `prompt` is the "Start from a prompt" card's first message; `assistant` is
 * what Rally answers it with, and is refused without a prompt to answer.
 */
const CreateCanvasStepSchema = z.strictObject({
  kind: z.literal("create_canvas"),
  id: StepIdSchema,
  canvas: KeySchema,
  as: DemoPackRoleSchema,
  title: z.string().trim().min(1).max(300),
  sharedWith: SharedWithSchema,
  prompt: MessageTextSchema.optional(),
  assistant: DemoSeedTurnSchema.optional(),
});

/** A cast member's message in a Canvas's Chat, and what Rally answers when it starts a run. */
const CanvasMessageStepSchema = z.strictObject({
  kind: z.literal("canvas_message"),
  id: StepIdSchema,
  canvas: KeySchema,
  as: DemoPackRoleSchema,
  text: MessageTextSchema,
  /** What Rally says when this message starts a run. Absent: it starts none. */
  assistant: DemoSeedTurnSchema.optional(),
});

/**
 * A version of one of a Canvas's artifacts, published by Rally through the
 * Terminal's resource bridge the Chat's `publish_resource` uses. The first
 * publish of a `path` is a new artifact at version 1; a later one of the same
 * path is its next version. It is the Canvas's latest seeded run's, which the
 * schema requires to exist: Rally said it in that run.
 *
 * A document only. A site publish needs a served version and a hostname, which
 * no seed has proved end to end yet; `docs/demo-workspaces.md` says so.
 */
const CanvasArtifactStepSchema = z.strictObject({
  kind: z.literal("canvas_artifact"),
  id: StepIdSchema,
  canvas: KeySchema,
  /** The path Rally published from; its identity across versions. */
  path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u),
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1),
});

/** A document a cast member attaches to a message in a Canvas's Chat. */
const UploadStepSchema = z.strictObject({
  kind: z.literal("upload"),
  id: StepIdSchema,
  canvas: KeySchema,
  as: DemoPackRoleSchema,
  title: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.enum(["text/markdown", "text/plain"]),
  content: z.string().min(1),
});

/**
 * A Sidekick the demo already has: published, on a schedule, shared with the
 * people the pack names, and — with `firstRun` — one run behind it, whose row
 * sits in its shared conversation like every run's. With `canvas` that run
 * also wrote a Canvas: made the way a run's first publish makes one, with the
 * run's principal as its creator and the Sidekick as its writer, and holding
 * the document as its first artifact.
 *
 * The definition's four prose fields are the ones a drafting conversation would
 * have produced, written here instead so a demo does not depend on a live model
 * to have a Sidekick in it. `schedule.timezone` is always named: a demo is
 * presented in a zone somebody chose, and leaving it null would resolve it
 * against whichever colleague happens to be cast as the author.
 */
const SidekickStepSchema = z.strictObject({
  kind: z.literal("sidekick"),
  id: StepIdSchema,
  sidekick: KeySchema,
  as: DemoPackRoleSchema,
  sharedWith: SharedWithSchema,
  name: z.string().min(1).max(140),
  description: z.string().min(1).max(1200),
  overview: z.string().min(1).max(3000),
  instructions: z.string().min(1).max(12000),
  schedule: z.strictObject({
    rrule: z.string().min(1),
    timezone: IanaTimezoneSchema,
    summary: z.string().min(1),
  }),
  /** Only a `say`: a run that ended in a question would park on it with nobody asked. */
  firstRun: DemoSeedSayTurnSchema.optional(),
  canvas: z.strictObject({
    title: z.string().trim().min(1).max(300),
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u),
    content: z.string().min(1),
  }).optional(),
});

/**
 * Something a cast member says in a Sidekick's shared conversation, to the
 * people there. It starts no run: a Sidekick's answer is a run, and a demo's
 * one run is the Sidekick step's `firstRun`.
 */
const SidekickMessageStepSchema = z.strictObject({
  kind: z.literal("sidekick_message"),
  id: StepIdSchema,
  sidekick: KeySchema,
  as: DemoPackRoleSchema,
  text: MessageTextSchema,
});

export const DemoPackStepSchema = z.discriminatedUnion("kind", [
  CreateCanvasStepSchema,
  CanvasMessageStepSchema,
  CanvasArtifactStepSchema,
  UploadStepSchema,
  SidekickStepSchema,
  SidekickMessageStepSchema,
]);
export type DemoPackStep = z.infer<typeof DemoPackStepSchema>;

type CanvasStep = Extract<DemoPackStep, { kind: "create_canvas" | "canvas_message" | "canvas_artifact" | "upload" }>;
function isCanvasStep(step: DemoPackStep): step is CanvasStep {
  return step.kind === "create_canvas" || step.kind === "canvas_message"
    || step.kind === "canvas_artifact" || step.kind === "upload";
}

function namedRoles(text: string): string[] {
  return [...text.matchAll(NAME_TOKEN)].map((match) => match[1]!);
}

/** Whether an audience admits a role, given who made the thing. The one rule, `audienceAdmits`, read over pack facts. */
function admits(sharedWith: DemoPackSharedWith, creator: DemoPackRole, role: DemoPackRole): boolean {
  return role === creator || sharedWith === "organization" || sharedWith.includes(role);
}

/** What the steps say about one Canvas, once every step has been applied. */
export interface DemoPackCanvasFacts {
  canvas: string;
  title: string;
  creator: DemoPackRole;
  sharedWith: DemoPackSharedWith;
  /** The Sidekick key whose run wrote it; null for a Canvas a person made. */
  writer: string | null;
  /** Each artifact path, and how many versions the pack publishes of it. */
  artifacts: Map<string, number>;
  /** Step ids of the Chat's uploads. */
  uploads: string[];
  /** Roles who wrote in the Chat, the creator among them. */
  actors: DemoPackRole[];
  /** Index of the Canvas's last step; recency order follows it. */
  lastStepIndex: number;
  /** How the Chat's loop ends: never run, parked on a question, or completed. */
  finalState: "idle" | "needs_input" | "completed";
}

/** What the steps say about one Sidekick. */
export interface DemoPackSidekickFacts {
  sidekick: string;
  /** The step's id, which is also its action id on the receipt. */
  stepId: string;
  name: string;
  author: DemoPackRole;
  sharedWith: DemoPackSharedWith;
  hasFirstRun: boolean;
  /** The Canvas its run wrote, as a Canvas fact keyed by the Sidekick's key. */
  writesCanvas: boolean;
}

/** The Sidekicks a pack publishes, in pack order. */
export function packSidekickFacts(steps: readonly DemoPackStep[]): DemoPackSidekickFacts[] {
  return steps.flatMap((step) => step.kind !== "sidekick" ? [] : [{
    sidekick: step.sidekick,
    stepId: step.id,
    name: step.name,
    author: step.as,
    sharedWith: step.sharedWith,
    hasFirstRun: step.firstRun !== undefined,
    writesCanvas: step.canvas !== undefined,
  }]);
}

/**
 * The Canvases a pack makes, from its steps alone, keyed by the pack's name
 * for each. A Sidekick's Canvas is keyed by the Sidekick's key, which the
 * schema keeps distinct from every Canvas key. Assumes a pack the schema
 * accepted.
 */
export function packCanvasFacts(steps: readonly DemoPackStep[]): Map<string, DemoPackCanvasFacts> {
  const canvases = new Map<string, DemoPackCanvasFacts>();
  steps.forEach((step, index) => {
    if (step.kind === "sidekick") {
      if (!step.canvas) return;
      canvases.set(step.sidekick, {
        canvas: step.sidekick, title: step.canvas.title, creator: step.as, sharedWith: step.sharedWith,
        writer: step.sidekick, artifacts: new Map([[step.canvas.path, 1]]), uploads: [], actors: [],
        lastStepIndex: index, finalState: "idle",
      });
      return;
    }
    if (!isCanvasStep(step)) return;
    if (step.kind === "create_canvas") {
      canvases.set(step.canvas, {
        canvas: step.canvas, title: step.title, creator: step.as, sharedWith: step.sharedWith, writer: null,
        artifacts: new Map(), uploads: [], actors: [step.as], lastStepIndex: index,
        finalState: step.assistant === undefined ? "idle" : step.assistant.kind === "ask" ? "needs_input" : "completed",
      });
      return;
    }
    const facts = canvases.get(step.canvas);
    if (!facts) return;
    facts.lastStepIndex = index;
    if (step.kind === "canvas_artifact") {
      facts.artifacts.set(step.path, (facts.artifacts.get(step.path) ?? 0) + 1);
      return;
    }
    if (!facts.actors.includes(step.as)) facts.actors.push(step.as);
    if (step.kind === "upload") facts.uploads.push(step.id);
    if (step.kind === "canvas_message" && step.assistant) {
      facts.finalState = step.assistant.kind === "ask" ? "needs_input" : "completed";
    }
  });
  return canvases;
}

/**
 * The Canvases one viewer is offered. A person's Canvas by its own audience; a
 * Sidekick's by the Sidekick's, read live, which is the rule `canvasAdmits`
 * applies to a writer Sidekick.
 */
export function visibleCanvasesFor(
  role: DemoPackRole,
  canvases: Iterable<DemoPackCanvasFacts>,
): DemoPackCanvasFacts[] {
  return [...canvases].filter((facts) => admits(facts.sharedWith, facts.creator, role));
}

/** The Sidekicks one viewer is offered: its author, and whoever it is shared with. */
export function visibleSidekicksFor(
  role: DemoPackRole,
  sidekicks: readonly DemoPackSidekickFacts[],
): DemoPackSidekickFacts[] {
  return sidekicks.filter((facts) => admits(facts.sharedWith, facts.author, role));
}

export const DemoPackSchema = z.strictObject({
  version: z.string().min(1),
  roles: z.array(DemoPackRoleSchema).min(1),
  steps: z.array(DemoPackStepSchema).min(1),
  /**
   * The viewers the readiness barrier reads the demo as. Each one's Canvas and
   * Sidekick lists must hold exactly what the steps make visible to them; the
   * steps say what that is, so a pack names only who is checked.
   */
  verify: z.array(DemoPackRoleSchema).min(1),
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
  const keys = new Set<string>();
  /** Per Canvas: who made it, its audience, whether a seeded run is behind it, and whether it parked on a question. */
  const canvases = new Map<string, { creator: string; sharedWith: DemoPackSharedWith; ran: boolean; asked: boolean }>();
  const sidekicks = new Map<string, { author: string; sharedWith: DemoPackSharedWith }>();
  const sidekickNames = new Set<string>();
  const role = (name: string, path: (string | number)[], what: string) => {
    if (!roles.has(name)) context.addIssue({ code: "custom", path, message: `${what} "${name}" is not in the cast` });
  };
  pack.steps.forEach((step, index) => {
    const path = ["steps", index];
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: [...path, "id"], message: `Step id "${step.id}" is used twice` });
    }
    ids.add(step.id);
    if ("as" in step) role(step.as, [...path, "as"], "Role");
    if ("sharedWith" in step && step.sharedWith !== "organization") {
      for (const person of step.sharedWith) role(person, [...path, "sharedWith"], "Shared-with role");
      if (step.sharedWith.includes(step.as)) {
        context.addIssue({ code: "custom", path: [...path, "sharedWith"], message: "The creator is in it already" });
      }
    }
    // Prose names people by token, expanded when the cast is bound. An unbound
    // one is dereferenced mid-seeding, long after the last point at which
    // refusing costs nothing, so it is refused here.
    const assistant = "assistant" in step ? step.assistant : undefined;
    const prose = [
      ...("text" in step ? [step.text] : []),
      ...(step.kind === "create_canvas" && step.prompt ? [step.prompt] : []),
      ...(assistant === undefined ? [] : assistant.kind === "say" ? [assistant.text] : [assistant.prompt, ...assistant.options]),
      ...(step.kind === "sidekick" ? [step.description, step.overview, step.instructions, step.firstRun?.text ?? "", step.canvas?.content ?? ""] : []),
      ...(step.kind === "canvas_artifact" || step.kind === "upload" ? [step.content] : []),
    ];
    for (const named of prose.flatMap(namedRoles)) role(named, path, "Named role");

    if (step.kind === "create_canvas" || step.kind === "sidekick") {
      const key = step.kind === "create_canvas" ? step.canvas : step.sidekick;
      if (keys.has(key)) {
        context.addIssue({ code: "custom", path, message: `"${key}" names two Canvases or Sidekicks` });
      }
      keys.add(key);
    }
    if (step.kind === "create_canvas") {
      if (step.assistant && !step.prompt) {
        context.addIssue({ code: "custom", path: [...path, "assistant"], message: "Rally answers a prompt, and there is none" });
      }
      canvases.set(step.canvas, {
        creator: step.as, sharedWith: step.sharedWith, ran: step.assistant !== undefined,
        asked: step.assistant?.kind === "ask",
      });
      return;
    }
    if (step.kind === "sidekick") {
      const name = step.name.trim().toLowerCase();
      if (sidekickNames.has(name)) {
        // The list shows Sidekicks by name and the barrier names one in a gap
        // by it, so two under one name would make one of them unverifiable.
        context.addIssue({ code: "custom", path: [...path, "name"], message: `Two Sidekicks are named "${step.name}"` });
      }
      sidekickNames.add(name);
      if (step.canvas && !step.firstRun) {
        context.addIssue({ code: "custom", path: [...path, "canvas"], message: "A Sidekick's Canvas is written by a run, and it has none" });
      }
      sidekicks.set(step.sidekick, { author: step.as, sharedWith: step.sharedWith });
      return;
    }
    if (step.kind === "sidekick_message") {
      const sidekick = sidekicks.get(step.sidekick);
      if (!sidekick) {
        context.addIssue({ code: "custom", path: [...path, "sidekick"], message: `Sidekick "${step.sidekick}" is used before it is published` });
      } else if (!admits(sidekick.sharedWith, sidekick.author, step.as)) {
        context.addIssue({ code: "custom", path: [...path, "as"], message: `Role "${step.as}" cannot open Sidekick "${step.sidekick}"` });
      }
      return;
    }
    const canvas = canvases.get(step.canvas);
    if (!canvas) {
      context.addIssue({ code: "custom", path: [...path, "canvas"], message: `Canvas "${step.canvas}" is used before it is made` });
      return;
    }
    if (canvas.asked) {
      // The `ask` parked its run on a real open elicitation. Anything after it
      // is said into a question nobody has answered, and the presenter is the
      // one who is meant to answer it.
      context.addIssue({ code: "custom", path, message: `Canvas "${step.canvas}" continues after its question` });
    }
    if (step.kind === "canvas_artifact") {
      if (!canvas.ran) {
        context.addIssue({ code: "custom", path, message: `Rally has not run in Canvas "${step.canvas}" to publish this` });
      }
      return;
    }
    if (!admits(canvas.sharedWith, canvas.creator, step.as)) {
      context.addIssue({ code: "custom", path: [...path, "as"], message: `Role "${step.as}" cannot open Canvas "${step.canvas}"` });
    }
    if (step.kind === "canvas_message" && step.assistant) {
      canvas.ran = true;
      canvas.asked = step.assistant.kind === "ask";
    }
  });
  const verified = new Set<string>();
  pack.verify.forEach((viewer, index) => {
    if (verified.has(viewer)) context.addIssue({ code: "custom", path: ["verify", index], message: `Viewer "${viewer}" is verified twice` });
    verified.add(viewer);
    role(viewer, ["verify", index], "Viewer");
  });
});
export type DemoPack = z.infer<typeof DemoPackSchema>;

export interface DemoCastMember {
  userId: string;
  displayName: string;
}
export type DemoCast = Readonly<Record<DemoPackRole, DemoCastMember>>;

function resolveNames(text: string, cast: DemoCast): string {
  return text.replaceAll(NAME_TOKEN, (_token, role: string) => {
    const member = cast[role];
    if (!member) throw new Error(`demo_pack_role_unbound:${role}`);
    return member.displayName;
  });
}

function resolveTurn(turn: DemoSeedTurn, cast: DemoCast): DemoSeedTurn {
  return turn.kind === "say"
    ? { kind: "say", text: resolveNames(turn.text, cast) }
    : {
        kind: "ask",
        prompt: resolveNames(turn.prompt, cast),
        options: turn.options.map((option) => resolveNames(option, cast)),
      };
}

/** An audience in user ids: Organization-wide, or the people named besides the creator. */
export type DemoSeedAudience = "organization" | { userIds: string[] };

interface ActionBase {
  actionId: string;
  actorUserId: string;
}

export type DemoSeedAction =
  | (ActionBase & {
      kind: "create_canvas";
      canvas: string;
      title: string;
      audience: DemoSeedAudience;
      /** The first message and its seed; null for a Canvas made empty. */
      prompt: { text: string; seed: DemoSeed } | null;
    })
  | (ActionBase & { kind: "canvas_message"; canvas: string; text: string; seed: DemoSeed })
  | (ActionBase & {
      /** `actorUserId` is who asked for the run that publishes it: its execution principal. */
      kind: "canvas_artifact";
      canvas: string;
      path: string;
      title: string;
      content: string;
    })
  | (ActionBase & {
      kind: "upload";
      canvas: string;
      title: string;
      fileName: string;
      mimeType: "text/markdown" | "text/plain";
      content: string;
    })
  | (ActionBase & {
      kind: "sidekick";
      sidekick: string;
      audience: DemoSeedAudience;
      definition: { name: string; description: string; overview: string; instructions: string };
      schedule: { rrule: string; timezone: string; summary: string };
      firstRun: DemoSeed | null;
      canvas: { title: string; path: string; content: string } | null;
    })
  | (ActionBase & { kind: "sidekick_message"; sidekick: string; text: string; seed: DemoSeed });

export function planDemoSeed(pack: DemoPack, cast: DemoCast): DemoSeedAction[] {
  for (const role of pack.roles) {
    if (!(role in cast)) throw new Error(`demo_pack_role_unbound:${role}`);
  }
  const seed = (step: DemoPackStep, assistant: DemoSeedTurn | null): DemoSeed => ({
    packVersion: pack.version,
    actionId: step.id,
    assistant: assistant ? resolveTurn(assistant, cast) : null,
  });
  const audience = (sharedWith: DemoPackSharedWith): DemoSeedAudience => sharedWith === "organization"
    ? "organization"
    : { userIds: [...new Set(sharedWith.map((role) => cast[role]!.userId))] };
  // Who asked for each Canvas's latest seeded run, which is the run a
  // `canvas_artifact` publishes from; the schema has proved there is one.
  const runner = new Map<string, string>();
  return pack.steps.map((step): DemoSeedAction => {
    if ((step.kind === "create_canvas" || step.kind === "canvas_message") && step.assistant) {
      runner.set(step.canvas, cast[step.as]!.userId);
    }
    switch (step.kind) {
      case "create_canvas":
        return {
          kind: "create_canvas",
          actionId: step.id,
          actorUserId: cast[step.as]!.userId,
          canvas: step.canvas,
          title: resolveNames(step.title, cast),
          audience: audience(step.sharedWith),
          prompt: step.prompt === undefined
            ? null
            : { text: resolveNames(step.prompt, cast), seed: seed(step, step.assistant ?? null) },
        };
      case "canvas_message":
        return {
          kind: "canvas_message",
          actionId: step.id,
          actorUserId: cast[step.as]!.userId,
          canvas: step.canvas,
          text: resolveNames(step.text, cast),
          seed: seed(step, step.assistant ?? null),
        };
      case "canvas_artifact":
        return {
          kind: "canvas_artifact",
          actionId: step.id,
          actorUserId: runner.get(step.canvas)!,
          canvas: step.canvas,
          path: step.path,
          title: resolveNames(step.title, cast),
          content: resolveNames(step.content, cast),
        };
      case "upload":
        return {
          kind: "upload",
          actionId: step.id,
          actorUserId: cast[step.as]!.userId,
          canvas: step.canvas,
          title: step.title,
          fileName: step.fileName,
          mimeType: step.mimeType,
          content: resolveNames(step.content, cast),
        };
      case "sidekick":
        return {
          kind: "sidekick",
          actionId: step.id,
          actorUserId: cast[step.as]!.userId,
          sidekick: step.sidekick,
          audience: audience(step.sharedWith),
          definition: {
            name: step.name,
            description: resolveNames(step.description, cast),
            overview: resolveNames(step.overview, cast),
            instructions: resolveNames(step.instructions, cast),
          },
          schedule: step.schedule,
          firstRun: step.firstRun ? seed(step, step.firstRun) : null,
          canvas: step.canvas
            ? { title: resolveNames(step.canvas.title, cast), path: step.canvas.path, content: resolveNames(step.canvas.content, cast) }
            : null,
        };
      case "sidekick_message":
        return {
          kind: "sidekick_message",
          actionId: step.id,
          actorUserId: cast[step.as]!.userId,
          sidekick: step.sidekick,
          text: resolveNames(step.text, cast),
          seed: seed(step, null),
        };
    }
  });
}

const Q4_REVIEW_V1 = [
  "# Q4 revenue review",
  "",
  "Draft for Monday's board prep.",
  "",
  "| Metric | Q4 | Change |",
  "| --- | ---: | --- |",
  "| Net revenue | $4.82M | +18% QoQ |",
  "| Gross margin | 71.4% | +2.1 pts |",
  "| Net retention | 118% | +4 pts |",
  "",
  "## What moved",
  "",
  "Enterprise expansion drove most of the quarter, led by three accounts that moved to annual plans in October. Self-serve held flat after the September price change.",
  "",
  "## Open questions",
  "",
  "Do we restate the September cohort, or footnote the price change?",
].join("\n");

const Q4_REVIEW_V2 = Q4_REVIEW_V1.replace(
  "Self-serve held flat after the September price change.",
  "Self-serve held flat after the September price change.\n\nChurn fell to 1.9% in the October cohort, the lowest since launch, with two of three lost accounts citing budget rather than product.",
);

/**
 * The placeholder pack: the mockup's Organization. Maya (the presenter) and
 * Theo are working on the board's Q4 revenue review with Rally; Theo's launch
 * plan is open to the whole Organization, where Priya has attached the
 * checklist; the Weekly changelog Sidekick has already run once and written
 * this week's changelog Canvas; and Incident triage, shared with the three of
 * them, has made its morning pass, which Priya answers in its conversation.
 * `docs/demo-workspaces.md#the-placeholder-pack` says why each piece is there.
 */
export const PLACEHOLDER_DEMO_PACK = {
  version: "canvases-2026-11",
  roles: ["presenter", "theo", "priya"],
  roleLabels: {
    theo: "Finance lead",
    priya: "Engineering lead",
  },
  steps: [
    {
      kind: "create_canvas",
      id: "q4-open",
      canvas: "q4-review",
      as: "presenter",
      title: "Q4 revenue review",
      sharedWith: ["theo"],
      prompt: "Draft the Q4 revenue review for Monday's board prep: revenue, margin and retention against Q3, what moved, and what is still open.",
      assistant: {
        kind: "say",
        text: "Here is a first draft. Net revenue was $4.82M, up 18% on Q3, with gross margin at 71.4% and net retention at 118%. Enterprise expansion carried the quarter; self-serve held flat after the September price change.",
      },
    },
    { kind: "canvas_artifact", id: "q4-v1", canvas: "q4-review", path: "q4-revenue-review.md", title: "Q4 revenue review", content: Q4_REVIEW_V1 },
    {
      kind: "canvas_message",
      id: "q4-churn",
      canvas: "q4-review",
      as: "theo",
      text: "Rally, add churn to \"What moved\". Use the October cohort, not the blended number.",
      assistant: { kind: "say", text: "Adding it after the expansion line. The October cohort churned 1.9%." },
    },
    { kind: "canvas_artifact", id: "q4-v2", canvas: "q4-review", path: "q4-revenue-review.md", title: "Q4 revenue review", content: Q4_REVIEW_V2 },
    {
      kind: "canvas_message",
      id: "q4-accounts",
      canvas: "q4-review",
      as: "theo",
      text: "The three accounts stay board-only. Keep them out of this one.",
    },
    {
      kind: "create_canvas",
      id: "launch-open",
      canvas: "launch-plan",
      as: "theo",
      title: "Launch plan",
      sharedWith: "organization",
      prompt: "Turn the pricing launch into a plan: the date, who owns each step, and what has to be true before we announce.",
      assistant: {
        kind: "say",
        text: "The launch is set for December 3. Three things gate the announcement: billing migrates existing annual plans, the help center pages are live, and support has the new macros. I have put owners against each.",
      },
    },
    {
      kind: "canvas_artifact",
      id: "launch-v1",
      canvas: "launch-plan",
      path: "launch-plan.md",
      title: "Launch plan",
      content: "# Launch plan\n\nLaunch: December 3.\n\n| Step | Owner | Due |\n| --- | --- | --- |\n| Migrate annual plans in billing | @{priya} | Nov 26 |\n| Publish the help center pages | @{theo} | Nov 28 |\n| Support macros and training | @{theo} | Dec 1 |\n\nAnnounce only when all three are done.",
    },
    {
      kind: "upload",
      id: "launch-checklist",
      canvas: "launch-plan",
      as: "priya",
      title: "Billing migration checklist",
      fileName: "billing-migration-checklist.md",
      mimeType: "text/markdown",
      content: "# Billing migration checklist\n\n1. Freeze plan edits on Nov 25.\n2. Migrate annual plans in batches of 200.\n3. Reconcile invoices against the old plans.\n4. Lift the freeze.",
    },
    {
      kind: "canvas_message",
      id: "launch-billing",
      canvas: "launch-plan",
      as: "priya",
      text: "Billing can migrate annual plans by the 26th; the checklist is attached. Rally, does that still leave room before the announcement?",
      assistant: {
        kind: "say",
        text: "Yes. The 26th leaves a week before December 3, and the help center pages are the later dependency now.",
      },
    },
    {
      kind: "sidekick",
      id: "changelog-sidekick",
      sidekick: "weekly-changelog",
      as: "theo",
      sharedWith: "organization",
      name: "Weekly changelog",
      description: "Prepares a concise changelog Canvas from completed work every Friday.",
      overview: "Every Friday afternoon it reads what shipped that week and writes one changelog the whole Organization can read.",
      instructions: "Each Friday, write a changelog of the work completed this week: what shipped, what it changes for customers, and anything held back. Keep it to one page.",
      schedule: {
        rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Every Friday at 2:00 PM",
      },
      firstRun: { kind: "say", text: "This week's changelog is up: annual plan pricing, faster Canvas loading, and two fixes to email delivery." },
      canvas: {
        title: "Weekly changelog · Nov 6",
        path: "weekly-changelog.md",
        content: "# Weekly changelog · Nov 6\n\n## Shipped\n\n- Annual plan pricing on the billing page.\n- Canvases open faster on a slow connection.\n- Two fixes to email delivery for long email conversations.\n\n## Held back\n\n- The new invoice layout waits on the billing migration.",
      },
    },
    {
      kind: "sidekick",
      id: "triage-sidekick",
      sidekick: "incident-triage",
      as: "priya",
      sharedWith: ["presenter", "theo"],
      name: "Incident triage",
      description: "Watches deploys and alerts, and keeps the team current on anything that breaks.",
      overview: "Each weekday morning it reviews the night's alerts and deploys and says what needs a person.",
      instructions: "Each weekday morning, review the alerts and deploys since the last run. Say what broke, what was rolled back, and what still needs an owner. Say plainly when nothing did.",
      schedule: {
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Every weekday at 8:00 AM",
      },
      firstRun: { kind: "say", text: "One alert overnight: checkout latency rose after the 11:40 PM deploy, and the deploy was rolled back at 11:52. Latency is normal again. The fix needs an owner before it ships again." },
    },
    {
      kind: "sidekick_message",
      id: "triage-owner",
      sidekick: "incident-triage",
      as: "priya",
      text: "I'll take the checkout fix. @{theo}, nothing customer-facing to announce; it was twelve minutes.",
    },
  ],
  verify: ["presenter"],
} satisfies z.input<typeof DemoPackSchema>;
