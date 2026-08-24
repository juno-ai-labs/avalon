/**
 * The loop that keeps a work stream's description true.
 *
 * A description is written once — from the opening message, a suggested-work
 * prompt, or a person's one-line summary — and then stops tracking reality. The
 * work stream keeps its name while what people actually do in it moves, and by
 * the second week the sidebar is describing work that finished.
 *
 * After every run in a work stream, this module re-reads the recent transcript
 * and asks a model one question: does the saved description still describe this
 * work stream? Almost always it does, and the answer is recorded and nothing
 * changes. When it does not, the description is replaced with the smallest
 * wording that does.
 *
 * Two failure modes are worse than a stale description, and both are held off in
 * code rather than left to the prompt:
 *
 * - **Generalization.** A model asked repeatedly to describe a varied transcript
 *   drifts toward "general discussion", which is true of every work stream and
 *   therefore useless in the one place descriptions are read — a list of them.
 *   `isTooGenericDescription` refuses those outright.
 * - **Churn.** A description that changes every few hours is one nobody can rely
 *   on. The throttle, the new-message floor, and the confidence floor together
 *   mean a rewrite costs a clear, sustained divergence rather than one busy
 *   afternoon.
 *
 * The window, the throttle, and the guards live here; the judgment lives in
 * `renderWorkstreamDescriptionMessages`. See `docs/workstream-descriptions.md`.
 */
import { normalizeModelText } from "@avalon/contracts/model-markdown";
import {
  MAXIMUM_DESCRIPTION_MESSAGE_CHARACTERS,
  renderWorkstreamDescriptionMessages,
  type WorkstreamDescriptionMessageInput,
} from "@avalon/agent-harness";
import { z } from "zod";

import { WORKSTREAM_DESCRIPTION_MAX_CHARACTERS } from "@avalon/contracts";

import type { Env } from "../env";
import { firstNonEmptyLine, truncateUtf16Safe } from "../lib/text";
import { logStructuredEvent } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import type { SchedulingObjectPort } from "../durable-objects/workstream-scheduling-protocol";
import { runStructuredInference } from "./structured-inference";

/**
 * The description a work stream carries between being created and this loop's
 * first pass over it.
 *
 * The opening line, not the opening message. Those were the same thing while a
 * message was bounded at 4,000 characters and a description at the same 4,000,
 * and taking the whole message was free. Raising the message ceiling to
 * `MESSAGE_MAX_CHARACTERS` separates them: a description is the line the sidebar
 * shows, the text the routing classifier reads, and the context every run starts
 * from, and none of those wanted a 100,000-character paste even when the schema
 * would have held one.
 *
 * Nothing a person typed is lost here — the message itself is stored whole, as
 * the work stream's first message — and this value is the shortest-lived one in
 * the work stream: the loop below replaces it after the first run, at a quarter
 * of even this length. The bound is the storage ceiling rather than
 * {@link MAXIMUM_DESCRIPTION_CHARACTERS} because this is the fallback that
 * stands when naming and the loop both fail, and truncating a person's own
 * first line further than the column requires would be inventing a summary.
 */
export function provisionalWorkstreamDescription(openingMessage: string, fallback: string): string {
  const firstLine = firstNonEmptyLine(openingMessage);
  return firstLine
    ? truncateUtf16Safe(firstLine, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS)
    : fallback;
}

/**
 * The recency half of the window. Long enough that a work stream worked on
 * across a normal week is judged on more than the current sitting.
 */
export const DESCRIPTION_WINDOW_HOURS = 72;
/**
 * The volume half. A busy work stream that turns over 200 messages in an hour
 * is judged on all of them; a quiet one that sees three a day is judged on
 * three days. Whichever window is larger wins, because the risk being managed
 * is deciding a work stream's purpose from too little of it.
 */
export const DESCRIPTION_WINDOW_MINIMUM_MESSAGES = 200;
/**
 * The ceiling on the larger of the two. A single Worker request has to render
 * and send this window, so an unbounded 72 hours is a request that fails rather
 * than a description that improves. When it binds, the newest messages are kept
 * and the prompt says so — a window silently missing its older half reads as a
 * work stream that only ever discussed today.
 */
export const MAXIMUM_DESCRIPTION_WINDOW_MESSAGES = 600;
/**
 * What counts as a turn this window is judged on.
 *
 * Everything but a tool card, which is how the work was done rather than what
 * the work stream is for. Stated as an exclusion rather than a list, because
 * that is what the retired predicate said: a host notice counts, and so would a
 * message type added after this was written. Naming's window asks the opposite
 * question about the same column, which is why neither caller shares a
 * predicate with the other.
 */
const DESCRIPTION_WINDOW_MESSAGE_TYPES = { exclude: ["tool"] } as const;
/**
 * The same ceiling expressed in characters, and the one that actually binds the
 * request size.
 *
 * 600 messages bounded individually at 800 characters is a ~480,000-character
 * prompt — well past the context of a model this role could reasonably be
 * retargeted to, and `feature-flags.md` names it as the role most likely to be
 * retargeted. A row cap alone therefore makes the ceiling depend on which model
 * the flag happens to point at, and the failure mode is a hard rejection on the
 * largest windows rather than a smaller one. Budgeting characters too keeps the
 * ceiling a property of this loop.
 *
 * Oldest messages are dropped first, so the window stays the most recent thing
 * the work stream said, and the prompt is told it was truncated either way.
 */
export const MAXIMUM_DESCRIPTION_WINDOW_CHARACTERS = 120_000;

/**
 * The floor on how long a work stream rests between evaluations. Descriptions
 * are read in lists and remembered; one that moves faster than a person checks
 * in is worse than one that lags.
 */
export const DESCRIPTION_REFRESH_MINIMUM_INTERVAL_SECONDS = 6 * 60 * 60;
/**
 * The ceiling the doubling below climbs to. A description confirmed several
 * times running is not one an extra look is likely to change, so the loop stops
 * paying to hear the same answer — but never stops entirely, because the
 * confirmations were about a work stream that has since kept moving.
 */
export const DESCRIPTION_REFRESH_MAXIMUM_INTERVAL_SECONDS = 48 * 60 * 60;

/**
 * What a work stream has to have *said* since the last evaluation, not merely
 * how many rows it wrote.
 *
 * Only messages a person authored count. An agent's own turns restate the ask
 * it was given and a system notice is the host talking to itself; neither is
 * evidence that the work moved, and counting them would let a single request
 * that provoked a long agent transcript buy a fresh evaluation. The character
 * floor is the difference between a conversation and a row of acknowledgements.
 */
export const DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES = 10;
export const DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_CHARACTERS = 600;

/**
 * Who counts as a person for the gate above.
 *
 * A work stream run from Slack has no messages authored by an Avalon account at
 * all: every person in it speaks as an external actor. Counting only `human`
 * would mean the descriptions most in need of this loop — the ones derived from
 * whichever message happened to mention Avalon — were the only ones it could
 * never reach.
 */
function isPerson(authorType: WindowMessage["authorType"]): boolean {
  return authorType === "human" || authorType === "external";
}
/**
 * How much of what was said has to be *about* something the description does
 * not already cover.
 *
 * This is the gate that separates a busy work stream from a changed one. Ten
 * more messages elaborating the subject already named are not drift, and paying
 * a model to confirm that is the waste this loop is most likely to fall into:
 * an active work stream produces the volume for a fresh evaluation every few
 * hours forever. Drift, by contrast, is definitionally vocabulary the
 * description lacks.
 */
export const DESCRIPTION_REFRESH_MINIMUM_NOVEL_TERMS = 5;

/** The same bar the activity classifiers use, and for the same reason: an uncertain rewrite is a keep. */
export const DESCRIPTION_REWRITE_MINIMUM_CONFIDENCE = 0.8;

/** Matches the prompt's stated shape. A description longer than this is a summary, and belongs in the transcript. */
export const MAXIMUM_DESCRIPTION_CHARACTERS = 280;
/** Below these a proposal cannot be naming a subject, so it cannot be an improvement on one that does. */
export const MINIMUM_DESCRIPTION_CHARACTERS = 16;
export const MINIMUM_DESCRIPTION_WORDS = 3;

/**
 * Descriptions that are true of almost any work stream.
 *
 * This is a floor, not a definition of genericness — the prompt carries that.
 * It exists because this specific failure is the one that destroys the feature:
 * a list where every row reads "ongoing work" is strictly worse than a list of
 * stale but distinct descriptions, and it is the exact attractor a model falls
 * into when a transcript resists summary. Anything landing here is refused and
 * the existing description stands.
 */
const GENERIC_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "chat",
  "conversation",
  "discussion",
  "general",
  "general chat",
  "general discussion",
  "general work",
  "misc",
  "miscellaneous",
  "notes",
  "ongoing conversation",
  "ongoing discussion",
  "ongoing work",
  "random",
  "team chat",
  "team discussion",
  "updates",
  "various topics",
  "work",
  "work stream",
  "workstream",
]);

/** Strips punctuation and case so "General discussion." and "general discussion" are one value. */
function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isTooGenericDescription(value: string): boolean {
  return GENERIC_DESCRIPTIONS.has(normalizeDescription(value));
}

/**
 * Words carried by any sentence regardless of subject, and therefore no
 * evidence about what a work stream is for.
 *
 * The list is English-only and deliberately short. It is not doing linguistics:
 * it is stopping "the", "we", and "should" from being counted as new subject
 * matter. A work stream held in another language simply finds more of its terms
 * distinctive, which admits an evaluation rather than suppressing one — the
 * safe direction for a gate whose failure mode is skipping.
 */
const NON_SUBJECT_TERMS: ReadonlySet<string> = new Set([
  "about", "after", "again", "all", "also", "and", "any", "are", "back", "because", "been", "before",
  "being", "both", "but", "can", "could", "did", "does", "doing", "done", "down", "each", "even",
  "every", "for", "from", "get", "going", "got", "had", "has", "have", "her", "here", "him", "his",
  "how", "into", "its", "just", "know", "let", "like", "look", "made", "make", "many", "may", "might",
  "more", "most", "much", "need", "new", "not", "now", "off", "once", "one", "only", "other", "our",
  "out", "over", "own", "please", "put", "really", "right", "said", "same", "say", "see", "she",
  "should", "since", "some", "still", "such", "sure", "take", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "thing", "things", "think", "this", "those", "through", "too",
  "two", "under", "until", "use", "used", "very", "want", "was", "way", "well", "were", "what",
  "when", "where", "which", "while", "who", "why", "will", "with", "would", "yes", "yet", "you",
  "your",
]);

/** The display name off a stored external actor, or null when the row has none. */
function parseExternalActor(value: string | null): { displayName: string } | null {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const displayName = (parsed as { displayName?: unknown } | null)?.displayName;
    return { displayName: typeof displayName === "string" ? displayName : "" };
  } catch {
    // The row is still external even when its actor blob will not parse; only
    // the name is lost, and losing the name must not silently demote a person.
    return { displayName: "" };
  }
}

/** Terms long enough and ordinary enough to carry subject matter. */
function subjectTerms(value: string): string[] {
  return normalizeDescription(value)
    .split(" ")
    .filter((term) => term.length >= 3 && !NON_SUBJECT_TERMS.has(term));
}

/**
 * How many distinct subjects the new messages raise that the description and
 * title do not already name.
 *
 * A term counts only if it appears at least twice across the new messages. One
 * mention is an aside; a work stream whose purpose has moved returns to the new
 * subject. That threshold is also what keeps a single long pasted document from
 * clearing the gate on vocabulary nobody discussed.
 */
export function countNovelSubjectTerms(input: {
  newText: string;
  description: string;
  title: string;
}): number {
  const known = new Set([...subjectTerms(input.description), ...subjectTerms(input.title)]);
  const occurrences = new Map<string, number>();
  for (const term of subjectTerms(input.newText)) {
    occurrences.set(term, (occurrences.get(term) ?? 0) + 1);
  }
  let novel = 0;
  for (const [term, count] of occurrences) {
    if (count >= 2 && !known.has(term)) novel += 1;
  }
  return novel;
}

const DescriptionDecisionSchema = z.object({
  decision: z.enum(["keep", "rewrite"]),
  description: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const descriptionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["keep", "rewrite"] },
    description: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
  },
  required: ["decision", "description", "confidence", "reasoning"],
};

interface WorkstreamDescriptionRow {
  title: string;
  objective: string;
  description_source: string;
  origin_type: string;
  archived_at: string | null;
}

interface ClaimRow {
  version: number;
  consecutive_keeps: number;
}

/** What one model proposal resolves to once the guards have run. */
export type DescriptionVerdict =
  | { status: "kept" }
  | { status: "rewritten"; description: string }
  | { status: "rejected"; code: string };

export type DescriptionRefreshOutcome =
  | DescriptionVerdict
  | { status: "skipped"; reason: string }
  | { status: "failed"; code: string };

export interface RefreshWorkstreamDescriptionInput {
  workspaceId: string;
  workstreamId: string;
  /** Injectable for tests; production reads the wall clock. */
  now?: Date;
}

/**
 * Re-evaluate one work stream's description, applying a rewrite only when the
 * transcript, the model, and every guard agree it has veered.
 *
 * Never throws. This runs behind finished work as a best-effort step: a work
 * stream whose description could not be re-evaluated is in exactly the state it
 * was already in, and no run should fail over it.
 */
export async function refreshWorkstreamDescription(
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
): Promise<DescriptionRefreshOutcome> {
  try {
    return await evaluate(env, input);
  } catch (error) {
    logStructuredEvent(env, "warn", "workstream_description_refresh_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { status: "failed", code: "refresh_threw" };
  }
}

async function evaluate(
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
): Promise<DescriptionRefreshOutcome> {
  if (!env.OPENROUTER_API_KEY) return { status: "skipped", reason: "no_model_access" };
  const now = input.now ?? new Date();
  const scheduling = createSchedulingObjectPort(env, input.workspaceId, input.workstreamId);

  // Cheapest first, and each gate is a reason not to read what the next one
  // needs. Two single-row lookups decide most terminal runs; only a work stream
  // that has both rested and changed pays for the window, and only one that has
  // changed in substance pays for inference.
  const [workstream, previous] = await Promise.all([
    env.DB.prepare(
      `SELECT title, objective, description_source, origin_type, archived_at
         FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId).first<WorkstreamDescriptionRow>(),
    scheduling.descriptionRefreshState(),
  ]);
  if (!workstream) return { status: "skipped", reason: "workstream_missing" };
  if (workstream.archived_at != null) return { status: "skipped", reason: "archived" };
  // An automation's work stream describes one run of a saved configuration. Its
  // description belongs to that configuration, and rewriting it here would put
  // this loop in an argument with the automation that owns it.
  if (workstream.origin_type === "automation") return { status: "skipped", reason: "automation_origin" };

  // Gate 1: the clock. A work stream that has not rested is not looked at,
  // whatever happened in it.
  // Unix milliseconds against a parsed instant, where the routed read compared
  // ISO-8601 strings lexically. The two orderings agree for this format, which
  // is why the string comparison was safe; the object simply stores the
  // instant, so there is nothing to compare lexically any more.
  if (previous && previous.rest_until > now.getTime()) return { status: "skipped", reason: "resting" };

  const window = await loadWindow(env, input.workspaceId, input.workstreamId, now);
  if (window.messages.length === 0) return { status: "skipped", reason: "empty_window" };

  // Gate 2: the channel. Both conditions have to hold — enough was said, and
  // enough of it was about something the description does not already name.
  const evaluatedThrough = Number(previous?.evaluated_through_sequence ?? 0);
  const spoken = window.messages.filter(
    (message) => message.sequenceNumber > evaluatedThrough && isPerson(message.authorType),
  );
  const spokenText = spoken.map((message) => message.text).join("\n");
  if (
    spoken.length < DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES
    || spokenText.length < DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_CHARACTERS
  ) {
    return { status: "skipped", reason: "insufficient_new_conversation" };
  }
  const novelTerms = countNovelSubjectTerms({
    newText: spokenText,
    description: workstream.objective,
    title: workstream.title,
  });
  if (novelTerms < DESCRIPTION_REFRESH_MINIMUM_NOVEL_TERMS) {
    // The threshold is a guess until there is data behind it, and this is the
    // only place that data can come from: a work stream that talked enough to
    // clear every other gate and was turned away here is exactly the near-miss
    // worth counting. A rewrite the loop is deferring shows up as a run of
    // these on one work stream with the count sitting just below the floor.
    logStructuredEvent(env, "info", "workstream_description_change_below_threshold", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      novel_terms: novelTerms,
      required_novel_terms: DESCRIPTION_REFRESH_MINIMUM_NOVEL_TERMS,
      new_person_messages: spoken.length,
    });
    return { status: "skipped", reason: "nothing_new_discussed" };
  }

  const claim = await claimEvaluation(scheduling, window, now);
  if (!claim) return { status: "skipped", reason: "resting" };

  let proposal: z.infer<typeof DescriptionDecisionSchema>;
  let evaluatedModel = "unknown";
  try {
    const inference = await runStructuredInference(env, {
      role: "workstream_description",
      context: {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
      },
      messages: renderWorkstreamDescriptionMessages({
        title: workstream.title,
        currentDescription: workstream.objective,
        descriptionSource: workstream.description_source === "authored" ? "authored" : "derived",
        windowTruncated: window.truncated,
        messages: window.messages,
      }),
      schemaName: "workstream_description_review",
      jsonSchema: descriptionJsonSchema,
      parse: (value) => DescriptionDecisionSchema.parse(value),
      onModelResolved: (model) => {
        evaluatedModel = model;
      },
    });
    proposal = inference.result;
    evaluatedModel = inference.model;
  } catch (error) {
    await recordOutcome(env, input, scheduling, claim, {
      decision: "failed",
      rejectionCode: "model_unavailable",
      model: evaluatedModel,
      previousDescription: workstream.objective,
      description: null,
      confidence: null,
      reasoning: error instanceof Error ? error.message.slice(0, 500) : "unknown",
      windowMessageCount: window.messages.length,
      now,
    });
    return { status: "failed", code: "model_unavailable" };
  }

  const verdict = judgeDescriptionProposal(proposal, workstream.objective);
  if (verdict.status === "kept") {
    await recordOutcome(env, input, scheduling, claim, {
      decision: "kept",
      rejectionCode: null,
      model: evaluatedModel,
      previousDescription: workstream.objective,
      description: workstream.objective,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning.slice(0, 2_000),
      windowMessageCount: window.messages.length,
      now,
    });
    return verdict;
  }
  if (verdict.status === "rejected") {
    logStructuredEvent(env, "info", "workstream_description_rewrite_rejected", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      rejection_code: verdict.code,
      model: evaluatedModel,
    });
    await recordOutcome(env, input, scheduling, claim, {
      decision: "rejected",
      rejectionCode: verdict.code,
      model: evaluatedModel,
      previousDescription: workstream.objective,
      description: workstream.objective,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning.slice(0, 2_000),
      windowMessageCount: window.messages.length,
      now,
    });
    return verdict;
  }

  // Guarded on the description the evaluation actually read. A person who
  // retitled the work stream while the model was thinking wins: theirs is the
  // more recent statement of intent, and silently overwriting it is the one
  // outcome that would make this loop untrustworthy.
  const applied = await env.DB.prepare(
    `UPDATE workstreams
        SET objective = ?, description_source = 'derived', updated_at = ?
      WHERE id = ? AND workspace_id = ? AND objective = ?`,
  ).bind(
    verdict.description,
    now.toISOString(),
    input.workstreamId,
    input.workspaceId,
    workstream.objective,
  ).run();
  if ((applied.meta?.changes ?? 0) === 0) {
    // `description` is what is in force after this evaluation, and after a
    // refusal that is whatever the other writer put there — not the text this
    // evaluation read. Re-read it rather than record the superseded value.
    const inForce = await env.DB.prepare(
      "SELECT objective FROM workstreams WHERE id = ? AND workspace_id = ?",
    ).bind(input.workstreamId, input.workspaceId).first<{ objective: string }>();
    await recordOutcome(env, input, scheduling, claim, {
      decision: "rejected",
      rejectionCode: "description_changed_during_evaluation",
      model: evaluatedModel,
      previousDescription: workstream.objective,
      description: inForce?.objective ?? null,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning.slice(0, 2_000),
      windowMessageCount: window.messages.length,
      now,
    });
    return { status: "rejected", code: "description_changed_during_evaluation" };
  }

  await recordOutcome(env, input, scheduling, claim, {
    decision: "rewritten",
    rejectionCode: null,
    model: evaluatedModel,
    previousDescription: workstream.objective,
    description: verdict.description,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning.slice(0, 2_000),
    windowMessageCount: window.messages.length,
    now,
  });
  logStructuredEvent(env, "info", "workstream_description_rewritten", {
    workspace_id: input.workspaceId,
    workstream_id: input.workstreamId,
    model: evaluatedModel,
    confidence: proposal.confidence,
    window_message_count: window.messages.length,
  });
  return verdict;
}

/**
 * Turn one model proposal into an outcome. Every rule here is deterministic, so
 * the same proposal always resolves the same way and a rejection is explainable
 * without re-reading the transcript.
 */
export function judgeDescriptionProposal(
  proposal: z.infer<typeof DescriptionDecisionSchema>,
  currentDescription: string,
): DescriptionVerdict {
  if (proposal.decision === "keep") return { status: "kept" };
  if (proposal.confidence < DESCRIPTION_REWRITE_MINIMUM_CONFIDENCE) return { status: "kept" };

  // Repaired before it is judged, so the length and genericness rules below
  // measure the sentence a reader will see rather than the TeX around it.
  const description = normalizeModelText((proposal.description ?? "").trim());
  if (description.length === 0) return { status: "rejected", code: "empty_description" };
  if (description.length > MAXIMUM_DESCRIPTION_CHARACTERS) {
    return { status: "rejected", code: "description_too_long" };
  }
  // Genericness is checked before the length floor: a catch-all is usually
  // short, and "too short" would report the symptom while hiding the failure
  // this loop most needs to see in its logs.
  if (isTooGenericDescription(description)) return { status: "rejected", code: "description_too_generic" };
  if (description.length < MINIMUM_DESCRIPTION_CHARACTERS) {
    return { status: "rejected", code: "description_too_short" };
  }
  if (normalizeDescription(description).split(" ").filter(Boolean).length < MINIMUM_DESCRIPTION_WORDS) {
    return { status: "rejected", code: "description_too_short" };
  }
  // A restyling of the same sentence is not a divergence, and applying it would
  // spend a description change on nothing a reader can act on.
  if (normalizeDescription(description) === normalizeDescription(currentDescription)) {
    return { status: "kept" };
  }
  return { status: "rewritten", description };
}

type WindowMessage = WorkstreamDescriptionMessageInput & { sequenceNumber: number };

interface DescriptionWindow {
  messages: WindowMessage[];
  latestSequence: number;
  truncated: boolean;
}

/**
 * The last 72 hours or the last 200 messages, whichever is bigger, capped.
 *
 * Tool rows and empty messages are excluded: they are how the work was done,
 * not what the work stream is for, and they would crowd out the human turns
 * that actually say why it exists.
 */
async function loadWindow(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  now: Date,
): Promise<DescriptionWindow> {
  const cutoff = now.getTime() - DESCRIPTION_WINDOW_HOURS * 60 * 60 * 1_000;
  // One call, not three. The count only exists to size the page and the authors
  // are read from the page, so asking them separately would be three round
  // trips describing one transcript — on a path that runs at the end of every
  // harness run. The retired version got the first two in one statement each
  // and the third from a `LEFT JOIN users`.
  const window = await createMessageObjectPort(env, workspaceId, workstreamId).saidWindow({
    messageTypes: DESCRIPTION_WINDOW_MESSAGE_TYPES,
    since: cutoff,
    minimum: DESCRIPTION_WINDOW_MINIMUM_MESSAGES,
    maximum: MAXIMUM_DESCRIPTION_WINDOW_MESSAGES,
  });
  const ordered = window.rows;
  const requested = window.requested;
  const limit = Math.min(requested, MAXIMUM_DESCRIPTION_WINDOW_MESSAGES);
  // The author's name, which the retired `LEFT JOIN users` took from a view
  // that answered with the member's own id. It still does — this prompt has
  // been reading UUIDs where it means names since the cutover — but the
  // fabrication is now in one place rather than inside a join, and the identity
  // slice is where every reader of it starts seeing the real profile at once.
  const authors = new Map(window.authors.map((author) => [author.user_id, author.user_id]));
  const messages = ordered.map((row) => {
    // A message from a connected surface is stored as `system` carrying an
    // external actor, because it has no Avalon account behind it. Reading the
    // column alone would file a whole Slack conversation as host notices — and
    // then exclude every one of its people from the admission gate below.
    const external = parseExternalActor(row.external_actor_json);
    const authorType = external
      ? "external" as const
      : row.author_type === "agent"
        ? "agent" as const
        : row.author_type === "system" ? "system" as const : "human" as const;
    return {
      sequenceNumber: Number(row.sequence_number),
      authorType,
      authorName: external?.displayName
        ?? (row.author_user_id == null ? null : authors.get(row.author_user_id) ?? null),
      occurredAt: new Date(row.created_at).toISOString(),
      text: String(row.text_content),
    } satisfies WindowMessage;
  });
  // Drop from the oldest end until the window fits its character budget. Each
  // message is measured as the prompt will render it, so the budget bounds the
  // request rather than approximating it.
  let budget = MAXIMUM_DESCRIPTION_WINDOW_CHARACTERS;
  let firstKept = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = Math.min(messages[index]!.text.length, MAXIMUM_DESCRIPTION_MESSAGE_CHARACTERS);
    if (cost > budget) break;
    budget -= cost;
    firstKept = index;
  }
  const kept = messages.slice(firstKept);
  return {
    messages: kept,
    latestSequence: kept.at(-1)?.sequenceNumber ?? messages.at(-1)?.sequenceNumber ?? 0,
    truncated: requested > limit || kept.length < messages.length,
  };
}

/**
 * The rest a work stream has earned, as an instant.
 *
 * The floor doubles once per consecutive confirmation, so the loop's cost on a
 * settled description decays while a description that keeps being corrected
 * stays on the floor. `keeps` is the count *after* the evaluation being
 * recorded, so the first confirmation already buys more than the floor.
 */
export function restUntil(now: Date, keeps: number): number {
  const seconds = Math.min(
    DESCRIPTION_REFRESH_MAXIMUM_INTERVAL_SECONDS,
    DESCRIPTION_REFRESH_MINIMUM_INTERVAL_SECONDS * 2 ** Math.max(0, keeps),
  );
  return now.getTime() + seconds * 1_000;
}

/**
 * Take the work stream's evaluation window, or report that it is not this run's
 * to take.
 *
 * Pushing `rest_until` forward before the model call rather than after is what
 * stops two runs terminalizing together from both spending one, and what stops
 * a model that is failing from being retried by every run behind it. The rest
 * is re-checked here, inside the write, because the read that admitted this
 * evaluation is not atomic with it. The claim holds the floor; the outcome
 * write below replaces it with whatever the decision earned.
 */
async function claimEvaluation(
  scheduling: SchedulingObjectPort,
  window: DescriptionWindow,
  now: Date,
): Promise<ClaimRow | null> {
  // One operation where there were two. The routed upsert decided whether the
  // claim landed inside a `WHERE rest_until <= ?3`, reported it as a `changes`
  // count, and then had to re-select the row to learn the version it had just
  // written — a read the claim could not hold on to because a routed statement
  // has no transaction to hold it in.
  const claimed = await scheduling.claimDescriptionEvaluation({
    evaluatedAt: now.getTime(),
    restUntil: restUntil(now, 0),
    evaluatedThroughSequence: window.latestSequence,
    windowMessageCount: window.messages.length,
  });
  return claimed
    ? { version: claimed.version, consecutive_keeps: claimed.consecutiveKeeps }
    : null;
}


interface RecordedOutcome {
  decision: "kept" | "rewritten" | "rejected" | "failed";
  rejectionCode: string | null;
  model: string;
  previousDescription: string;
  description: string | null;
  confidence: number | null;
  reasoning: string;
  windowMessageCount: number;
  now: Date;
}

/**
 * Close the claim with what it decided, and set the rest that decision earned.
 *
 * Only a confirmation extends the rest. A rewrite means the description was
 * wrong and the work stream is moving, so it returns to the floor and starts
 * the count again; a rejection or a model failure decided nothing, so it does
 * not get to buy quiet on the strength of having been asked.
 *
 * Guarded on the claim's version so a slow evaluation cannot overwrite the
 * result — or the rest — of the one that superseded it.
 */
async function recordOutcome(
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
  scheduling: SchedulingObjectPort,
  claim: ClaimRow,
  outcome: RecordedOutcome,
): Promise<void> {
  const keeps = outcome.decision === "kept" ? Number(claim.consecutive_keeps ?? 0) + 1 : 0;
  const written = await scheduling.recordDescriptionOutcome({
    expectedVersion: claim.version,
    decision: outcome.decision,
    rejectionCode: outcome.rejectionCode,
    confidence: outcome.confidence,
    model: outcome.model,
    previousDescription: outcome.previousDescription,
    description: outcome.description,
    reasoning: outcome.reasoning,
    windowMessageCount: outcome.windowMessageCount,
    consecutiveKeeps: keeps,
    restUntil: restUntil(outcome.now, keeps),
    now: outcome.now.getTime(),
  });
  // The row moved on — a person edited the description while this evaluation
  // was running, and their write owns it. The decision is still worth knowing,
  // so it goes to the log rather than being lost with the discarded write.
  if (!written) {
    logStructuredEvent(env, "info", "workstream_description_outcome_superseded", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      decision: outcome.decision,
      rejection_code: outcome.rejectionCode,
      claim_version: claim.version,
    });
  }
}
