/**
 * Scenarios: checking a pack an operator wrote, reading it back as the
 * presenter will, and storing the exact bytes a demo is made from.
 *
 * A scenario is a pack. The built-in one is compiled into the Worker
 * (`PLACEHOLDER_DEMO_PACK`); any other is passed whole by the Demo MCP. Either
 * way, the operation that prepares a demo stores the pack it starts with as an
 * immutable revision and every phase reads that copy, so a deploy that changes
 * the built-in pack cannot change a demo in flight.
 *
 * The check is the pack schema plus three things the schema cannot do for an
 * author: it derives the presenter's `expect` entry when the presenter never
 * acts (the one block whose mistakes cost a demo rather than a test), it
 * refuses a `personal` room before anything is written rather than partway
 * through seeding, and it reports every problem by a stable code with a fixed
 * sentence and a path that withholds record keys. The schema's own messages
 * quote the pack's values, and a check must never echo submitted data back
 * (`docs/naming-a-schema-failure.md`).
 *
 * `docs/demo-mcp.md` owns this module.
 */
import type { z } from "zod";

import { DemoPackShapeSchema } from "@rally/contracts/demo-pack";

import {
  DEMO_PRESENTER_ROLE,
  DemoPackSchema,
  PLACEHOLDER_DEMO_PACK,
  demoCastRoles,
  demoIdleViewerExpectation,
  packRoomFacts,
  type DemoPack,
  type DemoPackStep,
  type DemoViewerExpectation,
} from "./demo-pack";
import { uuidV7 } from "../lib/uuid-v7";

/** The one built-in scenario, `builtin:multiplayer`: the pack compiled into this Worker. */
export const BUILTIN_SCENARIO_NAME = "Multiplayer";
export const BUILTIN_SCENARIO_DESCRIPTION =
  "Acme proposal, vendor selection, Acme demo follow-up, and Sales demo reviews, in three Spaces with a review Sidekick.";

/** One problem with a pack, in the shape a model can act on. */
export interface DemoPackIssue {
  /** Where, as a JSON path with array indexes; a record key is shown as its position, `{n}`. */
  path: string;
  code: string;
  /** A fixed sentence per code that says what to change. Never contains pack text. */
  message: string;
}

export interface DemoPackSummary {
  spaces: number;
  channels: number;
  breakouts: number;
  sidekicks: number;
  uploads: number;
  parts: string[];
  /** Runs preparation starts and waits on, one at a time. */
  seededRuns: number;
}

export type DemoPackCheck =
  | { ok: true; pack: DemoPack; contentHash: string; summary: DemoPackSummary; derived: string[] }
  | { ok: false; issues: DemoPackIssue[] };

/**
 * The fixed sentence for each pack rule. Keyed by the `params.rule` the
 * schema's refinement sets, and by the Zod issue codes a shape failure can
 * carry. A code without an entry falls back to a sentence that still says what
 * to do, so an unmapped rule cannot surface the schema's own message.
 */
const ISSUE_MESSAGES: Record<string, string> = {
  demo_pack_role_not_in_cast: "This role is not in the pack's roles. Add it to roles and roleLabels, or name a role that is.",
  demo_pack_role_label_missing: "Every role except presenter needs a label in roleLabels. Add one for each role.",
  demo_pack_role_label_unused: "This label is for a role the operator does not cast. Remove it, or add the role to roles.",
  demo_pack_role_duplicate: "A role is listed twice in roles. List each role once.",
  demo_pack_step_id_duplicate: "This step id is already used by an earlier step. Give every step a unique id.",
  demo_pack_space_not_declared: "This room names a Space that is not in spaces. Declare it in spaces, or remove space from the room.",
  demo_pack_room_created_twice: "This room is created by an earlier step. Create each room once, with one create_workstream step.",
  demo_pack_substream_created_twice: "This Breakout is created by an earlier step. Create each Breakout once.",
  demo_pack_room_not_created: "This step uses a room or Breakout before the step that creates it. Move the creating step earlier.",
  demo_pack_substream_wrong_room: "This step names a Breakout under a room it does not belong to. Use the room the Breakout was created in.",
  demo_pack_already_seated: "participants lists the person who creates the room or Breakout. Remove them from participants.",
  demo_pack_speaker_not_seated: "The speaker is not in this conversation. Add them to the room's participants or mention them earlier, or choose someone who is in it.",
  demo_pack_substream_mention_not_member: "A mention in a Breakout names someone not in it. Add them to the Breakout's participants.",
  demo_pack_personal_substream_outsider: "A Breakout of a personal room can only include people in that room. Add them to the room first.",
  demo_pack_after_question: "A step follows a question (assistant kind ask) in the same conversation. End that conversation with the question, or move the question to its last step.",
  demo_pack_history_live_effects: "A room with execution history must open with a say turn and no mentions. Change the turn to say and remove the mentions, or drop execution history.",
  demo_pack_sidekick_name_duplicate: "Another Sidekick has the same name. Give every Sidekick a different name.",
  demo_pack_viewer_duplicate: "This viewer appears more than once in expect. List each viewer once.",
  demo_pack_viewer_not_in_cast: "This expect entry is for a role not in roles. Remove it or add the role.",
  demo_pack_expect_rooms_mismatch: "This viewer's expected rooms do not match the rooms they will see. List exactly the workspace rooms plus the rooms they are seated in.",
  demo_pack_personal_room_unsupported: "Rooms must have scope workspace; seeding refuses a personal room. Change the scope to workspace.",
  demo_pack_presenter_expect_required: "The presenter speaks or acts in a room, so their view cannot be derived. Add an expect entry for presenter.",
  invalid_type: "This field has the wrong type or is missing. Compare it with the shape get_demo_scenario returns.",
  invalid_value: "This value is not one of the allowed options. Use one of the values the schema lists.",
  invalid_format: "This value does not match the required format (lower-case letters, digits and hyphens for keys and ids). Fix its format.",
  too_small: "This value is too short or has too few items. Make it longer or add items.",
  too_big: "This value is too long or has too many items. Shorten it.",
  unrecognized_keys: "This object has a field the schema does not define. Remove fields that are not in the shape.",
  invalid_union: "This step does not match any step kind. Check its kind and the fields that kind takes.",
  custom: "This value is not valid here. Compare it with the shape get_demo_scenario returns.",
};

const FALLBACK_MESSAGE = "This part of the pack is not valid. Compare it with the shape get_demo_scenario returns.";

/** Fields whose keys are pack data rather than schema: shown by position, never by name. */
const RECORD_FIELDS = new Set(["spaces", "rooms", "roleLabels"]);

/**
 * A JSON path into the submitted value. Array indexes and declared field names
 * are schema shape; a key inside one of the record fields is the author's data,
 * so it is shown by its position among that object's keys instead.
 */
function issuePath(path: readonly PropertyKey[], value: unknown): string {
  let out = "";
  let current: unknown = value;
  let parent: PropertyKey | null = null;
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (parent !== null && typeof parent === "string" && RECORD_FIELDS.has(parent)) {
      const keys = current !== null && typeof current === "object" ? Object.keys(current) : [];
      out += `{${keys.indexOf(String(segment))}}`;
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`;
    }
    current = current !== null && typeof current === "object"
      ? (current as Record<PropertyKey, unknown>)[segment as string]
      : undefined;
    parent = segment;
  }
  return out === "" ? "(pack)" : out;
}

function issueCode(issue: z.core.$ZodIssue): string {
  if (issue.code === "custom") {
    const rule = (issue.params as { rule?: unknown } | undefined)?.rule;
    if (typeof rule === "string") return rule;
  }
  return issue.code;
}

function issuesOf(error: z.ZodError, value: unknown): DemoPackIssue[] {
  return error.issues.map((issue) => {
    const code = issueCode(issue);
    return { path: issuePath(issue.path, value), code, message: ISSUE_MESSAGES[code] ?? FALLBACK_MESSAGE };
  });
}

function issue(path: string, code: string): DemoPackIssue {
  return { path, code, message: ISSUE_MESSAGES[code] ?? FALLBACK_MESSAGE };
}

/** Whether the presenter authors a step in a room's main conversation, which opens it for them. */
function presenterActs(steps: readonly DemoPackStep[]): boolean {
  try {
    demoIdleViewerExpectation(steps, DEMO_PRESENTER_ROLE);
    return false;
  } catch {
    return true;
  }
}

function summarize(pack: DemoPack): DemoPackSummary {
  const count = (kind: DemoPackStep["kind"]) => pack.steps.filter((step) => step.kind === kind).length;
  const seededRuns = pack.steps.filter((step) =>
    (step.kind === "create_workstream" && step.execution !== "history")
    || (step.kind === "message" && step.assistant !== undefined)
    || (step.kind === "sidekick" && step.firstRun !== undefined)).length;
  return {
    spaces: Object.keys(pack.spaces ?? {}).length,
    channels: count("create_workstream"),
    breakouts: count("create_substream"),
    sidekicks: count("sidekick"),
    uploads: count("upload"),
    parts: demoCastRoles(pack.roles),
    seededRuns,
  };
}

/** The canonical bytes of a parsed pack, and their SHA-256. */
export async function demoPackContent(pack: DemoPack): Promise<{ json: string; contentHash: string }> {
  const json = JSON.stringify(pack);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { json, contentHash };
}

/**
 * Check a pack without writing anything.
 *
 * The presenter's `expect` entry is derived and put in place whenever the
 * presenter never acts in a room's main conversation; when they do act, their
 * flags depend on what they did and the pack must state them. A cast member's
 * entry is always kept as written.
 */
export async function checkDemoPack(value: unknown): Promise<DemoPackCheck> {
  const shape = DemoPackShapeSchema.safeParse(value);
  if (!shape.success) return { ok: false, issues: issuesOf(shape.error, value) };
  const issues: DemoPackIssue[] = [];
  const derived: string[] = [];
  let expect: DemoViewerExpectation[] = shape.data.expect;
  if (shape.data.roles.includes(DEMO_PRESENTER_ROLE)) {
    const index = expect.findIndex((entry) => entry.viewer === DEMO_PRESENTER_ROLE);
    if (!presenterActs(shape.data.steps)) {
      const entry = demoIdleViewerExpectation(shape.data.steps, DEMO_PRESENTER_ROLE);
      const at = index === -1 ? expect.length : index;
      expect = index === -1 ? [...expect, entry] : expect.map((existing, i) => i === index ? entry : existing);
      derived.push(`expect[${at}]`);
    } else if (index === -1) {
      issues.push(issue("expect", "demo_pack_presenter_expect_required"));
    }
  }
  shape.data.steps.forEach((step, index) => {
    if (step.kind === "create_workstream" && step.scope === "personal") {
      issues.push(issue(`steps[${index}].scope`, "demo_pack_personal_room_unsupported"));
    }
  });
  const candidate = { ...shape.data, expect };
  const parsed = DemoPackSchema.safeParse(candidate);
  if (!parsed.success) issues.push(...issuesOf(parsed.error, candidate));
  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  const { contentHash } = await demoPackContent(parsed.data);
  return { ok: true, pack: parsed.data, contentHash, summary: summarize(parsed.data), derived };
}

/** The built-in scenario, parsed. */
export function builtinDemoPack(): DemoPack {
  return DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
}

export function builtinScenarioSummary(pack: DemoPack): DemoPackSummary {
  return summarize(pack);
}

/**
 * Store a pack as an unnamed revision, or find the one that already holds the
 * same bytes. Answers the revision's id.
 */
export async function storeDemoPackRevision(
  db: D1Database,
  pack: DemoPack,
  savedBy: { subject: string; email: string | null } | null,
  now: string,
): Promise<{ revisionId: string; contentHash: string }> {
  const { json, contentHash } = await demoPackContent(pack);
  await db.prepare(
    `INSERT INTO demo_scenario_revisions
       (id, scenario_id, revision, pack_json, content_hash, saved_by_subject, saved_by_email, created_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT (content_hash) WHERE scenario_id IS NULL DO NOTHING`,
  ).bind(uuidV7(), json, contentHash, savedBy?.subject ?? null, savedBy?.email ?? null, now).run();
  const row = await db.prepare(
    "SELECT id FROM demo_scenario_revisions WHERE content_hash = ? AND scenario_id IS NULL",
  ).bind(contentHash).first<{ id: string }>();
  if (!row) throw new Error("demo_scenario_revision_unwritten");
  return { revisionId: row.id, contentHash };
}

/** A stored revision's pack, re-parsed rather than trusted. */
export async function readDemoPackRevision(
  db: D1Database,
  revisionId: string,
): Promise<{ pack: DemoPack; contentHash: string } | null> {
  const row = await db.prepare(
    "SELECT pack_json, content_hash FROM demo_scenario_revisions WHERE id = ?",
  ).bind(revisionId).first<{ pack_json: string; content_hash: string }>();
  if (!row) return null;
  return { pack: DemoPackSchema.parse(JSON.parse(row.pack_json)), contentHash: row.content_hash };
}

/**
 * The scenario as the presenter will read it, as Markdown: one section per
 * Space, each room in the order the presenter's sidebar lists it (most recent
 * last step first) with what the presenter finds there, then each Sidekick.
 * `@{role}` becomes the name of the person cast, or the part's label in
 * brackets when nobody is cast yet.
 */
export function previewDemoPack(pack: DemoPack, names: Readonly<Record<string, string>> = {}): string {
  const label = (role: string) => names[role]
    ?? (role === DEMO_PRESENTER_ROLE ? "[Presenter]" : `[${pack.roleLabels[role] ?? role}]`);
  const prose = (text: string) => text.replace(/@\{([a-z][a-z0-9-]{0,39})\}/gu, (_token, role: string) => `@${label(role)}`);
  const facts = packRoomFacts(pack.steps);
  const presenterView = pack.expect.find((entry) => entry.viewer === DEMO_PRESENTER_ROLE);
  const rooms = [...facts.values()].sort((a, b) => b.lastStepIndex - a.lastStepIndex);
  const spaceOf = new Map<string, string>();
  for (const step of pack.steps) {
    if (step.kind === "create_workstream") spaceOf.set(step.room, step.space ? pack.spaces?.[step.space]?.name ?? step.space : "General");
  }
  const order: string[] = [];
  for (const room of rooms) {
    const space = spaceOf.get(room.room) ?? "General";
    if (!order.includes(space)) order.push(space);
  }
  const lines: string[] = [];
  const turn = (step: DemoPackStep): string[] => {
    const assistant = "assistant" in step ? step.assistant : undefined;
    if (!assistant) return [];
    return assistant.kind === "say"
      ? [`**Rally:** ${prose(assistant.text)}`]
      : [`**Rally asks:** ${prose(assistant.prompt)}`, ...assistant.options.map((option) => `- ${prose(option)}`)];
  };
  for (const space of order) {
    lines.push(`## ${space}`, "");
    for (const room of rooms.filter((candidate) => (spaceOf.get(candidate.room) ?? "General") === space)) {
      const view = presenterView?.rooms[room.room];
      const flags = [
        room.seated.includes(DEMO_PRESENTER_ROLE) ? "seated" : "visible",
        ...(view?.unseen ? ["new"] : []),
        ...(view?.mentioned ? ["mentioned"] : []),
        ...(room.finalState === "needs_input" ? ["waiting on a question"] : []),
      ];
      lines.push(`### ${room.title} · ${flags.join(", ")}`, "");
      const breakouts = new Map<string, string[]>();
      for (const step of pack.steps) {
        if (step.kind === "sidekick" || step.room !== room.room) continue;
        if (step.kind === "create_substream") {
          breakouts.set(step.substream, [
            `#### Breakout: ${step.title} (${[step.as, ...step.participants].map(label).join(", ")})`,
            "",
            `_Starting context:_ ${prose(step.startingContext)}`,
            "",
          ]);
          continue;
        }
        const target = step.kind !== "create_workstream" && step.substream !== undefined
          ? breakouts.get(step.substream) ?? []
          : lines;
        if (step.kind === "create_workstream") {
          target.push(`**${label(step.as)}:** ${prose(step.openingMessage)}${step.execution === "history" ? " _(prepared history)_" : ""}`, "", ...turn(step), "");
        } else if (step.kind === "message") {
          target.push(`**${label(step.as)}:** ${prose(step.text)}`, "", ...turn(step), ...(step.assistant ? [""] : []));
        } else {
          target.push(`_${label(step.as)} attached ${step.title} (${step.fileName})_`, "");
        }
      }
      for (const breakout of breakouts.values()) lines.push(...breakout);
    }
  }
  const sidekicks = pack.steps.filter((step) => step.kind === "sidekick");
  if (sidekicks.length > 0) {
    lines.push("## Sidekicks", "");
    for (const step of sidekicks) {
      lines.push(
        `### ${step.name} · ${step.scope} · ${step.schedule.summary} (${step.schedule.timezone})`,
        "",
        prose(step.description),
        "",
        ...(step.firstRun ? [`**First run:** ${prose(step.firstRun.text)}`, ""] : []),
      );
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Exposed for the check's own tests. */
export const __demoScenariosTesting = { issuePath, ISSUE_MESSAGES };
