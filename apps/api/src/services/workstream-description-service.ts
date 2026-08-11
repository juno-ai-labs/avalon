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
import {
  MAXIMUM_DESCRIPTION_MESSAGE_CHARACTERS,
  OpenRouterClient,
  renderWorkstreamDescriptionMessages,
  type WorkstreamDescriptionMessageInput,
} from "@avalon/agent-harness";
import { z } from "zod";

import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { resolveAgentModelRouting } from "./agent-model-flags";

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
 * The same ceiling expressed in characters, and the one that actually binds the
 * request size.
 *
 * 600 messages bounded individually at 800 characters is a ~480,000-character
 * prompt — well past the context of a model this role could reasonably be
 * retargeted to, and `FEATURE_FLAGS.md` names it as the role most likely to be
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

interface WindowMessageRow {
  sequence_number: number;
  author_type: string;
  author_name: string | null;
  external_actor_json: string | null;
  text_content: string;
  created_at: string;
}

interface ClaimRow {
  version: number;
  consecutive_keeps: number;
}

interface PreviousRefreshRow {
  rest_until: string;
  consecutive_keeps: number;
  evaluated_through_sequence: number;
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
  const at = now.toISOString();

  // Cheapest first, and each gate is a reason not to read what the next one
  // needs. Two single-row lookups decide most terminal runs; only a work stream
  // that has both rested and changed pays for the window, and only one that has
  // changed in substance pays for inference.
  const [workstream, previous] = await Promise.all([
    env.DB.prepare(
      `SELECT title, objective, description_source, origin_type, archived_at
         FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId).first<WorkstreamDescriptionRow>(),
    env.DB.prepare(
      `SELECT rest_until, consecutive_keeps, evaluated_through_sequence
         FROM workstream_description_refreshes WHERE workstream_id = ? AND workspace_id = ?`,
    ).bind(input.workstreamId, input.workspaceId).first<PreviousRefreshRow>(),
  ]);
  if (!workstream) return { status: "skipped", reason: "workstream_missing" };
  if (workstream.archived_at != null) return { status: "skipped", reason: "archived" };
  // An automation's work stream describes one run of a saved configuration. Its
  // description belongs to that configuration, and rewriting it here would put
  // this loop in an argument with the automation that owns it.
  if (workstream.origin_type === "automation") return { status: "skipped", reason: "automation_origin" };

  // Gate 1: the clock. A work stream that has not rested is not looked at,
  // whatever happened in it.
  if (previous && String(previous.rest_until) > at) return { status: "skipped", reason: "resting" };

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

  const claim = await claimEvaluation(env, input, window, now);
  if (!claim) return { status: "skipped", reason: "resting" };

  const routing = await resolveAgentModelRouting(env, "workstream_description", {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
  });
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: routing.model,
    fallbackModels: routing.fallbackModels,
    appUrl: env.PUBLIC_API_BASE_URL,
    appName: "Avalon",
  });

  let proposal: z.infer<typeof DescriptionDecisionSchema>;
  try {
    proposal = await client.structured({
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
    });
  } catch (error) {
    await recordOutcome(env, input, claim, {
      decision: "failed",
      rejectionCode: "model_unavailable",
      model: routing.model,
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
    await recordOutcome(env, input, claim, {
      decision: "kept",
      rejectionCode: null,
      model: routing.model,
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
      model: routing.model,
    });
    await recordOutcome(env, input, claim, {
      decision: "rejected",
      rejectionCode: verdict.code,
      model: routing.model,
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
    await recordOutcome(env, input, claim, {
      decision: "rejected",
      rejectionCode: "description_changed_during_evaluation",
      model: routing.model,
      previousDescription: workstream.objective,
      description: inForce?.objective ?? null,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning.slice(0, 2_000),
      windowMessageCount: window.messages.length,
      now,
    });
    return { status: "rejected", code: "description_changed_during_evaluation" };
  }

  await recordOutcome(env, input, claim, {
    decision: "rewritten",
    rejectionCode: null,
    model: routing.model,
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
    model: routing.model,
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

  const description = (proposal.description ?? "").trim();
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
  const cutoff = new Date(now.getTime() - DESCRIPTION_WINDOW_HOURS * 60 * 60 * 1_000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS message_count
       FROM messages
      WHERE workspace_id = ? AND workstream_id = ?
        AND message_type <> 'tool' AND trim(text_content) <> ''
        AND created_at >= ?`,
  ).bind(workspaceId, workstreamId, cutoff).first<{ message_count: number }>();

  const requested = Math.max(DESCRIPTION_WINDOW_MINIMUM_MESSAGES, Number(recent?.message_count ?? 0));
  const limit = Math.min(requested, MAXIMUM_DESCRIPTION_WINDOW_MESSAGES);
  const rows = await env.DB.prepare(
    `SELECT m.sequence_number, m.author_type, m.external_actor_json, m.text_content, m.created_at,
            u.name AS author_name
       FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.workspace_id = ? AND m.workstream_id = ?
        AND m.message_type <> 'tool' AND trim(m.text_content) <> ''
      ORDER BY m.sequence_number DESC
      LIMIT ?`,
  ).bind(workspaceId, workstreamId, limit).all<WindowMessageRow>();

  const ordered = (rows.results ?? []).slice().reverse();
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
      authorName: external?.displayName ?? (row.author_name == null ? null : String(row.author_name)),
      occurredAt: String(row.created_at),
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
export function restUntil(now: Date, keeps: number): string {
  const seconds = Math.min(
    DESCRIPTION_REFRESH_MAXIMUM_INTERVAL_SECONDS,
    DESCRIPTION_REFRESH_MINIMUM_INTERVAL_SECONDS * 2 ** Math.max(0, keeps),
  );
  return new Date(now.getTime() + seconds * 1_000).toISOString();
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
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
  window: DescriptionWindow,
  now: Date,
): Promise<ClaimRow | null> {
  const at = now.toISOString();
  const claimed = await env.DB.prepare(
    `INSERT INTO workstream_description_refreshes
       (workstream_id, workspace_id, evaluated_at, rest_until, evaluated_through_sequence,
        window_message_count, decision, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 1, ?3, ?3)
     ON CONFLICT(workstream_id) DO UPDATE SET
       evaluated_at = ?3,
       rest_until = ?4,
       evaluated_through_sequence = ?5,
       window_message_count = ?6,
       decision = 'pending',
       rejection_code = NULL,
       version = workstream_description_refreshes.version + 1,
       updated_at = ?3
     WHERE workstream_description_refreshes.rest_until <= ?3`,
  ).bind(
    input.workstreamId,
    input.workspaceId,
    at,
    restUntil(now, 0),
    window.latestSequence,
    window.messages.length,
  ).run();
  if ((claimed.meta?.changes ?? 0) === 0) return null;

  return env.DB.prepare(
    `SELECT version, consecutive_keeps FROM workstream_description_refreshes
      WHERE workstream_id = ? AND workspace_id = ?`,
  ).bind(input.workstreamId, input.workspaceId).first<ClaimRow>();
}

/**
 * The write that records a person having authored this description themselves,
 * and rests the loop a full cycle on the strength of it.
 *
 * Returned as a statement rather than executed, because it has to land in the
 * same batch as the `workstreams.objective` write it belongs to. Two separate
 * statements leave a window between them in which an evaluation can read the
 * newly edited description, find no rest recorded yet, claim, and go on to
 * overwrite the text the person just wrote — its own guard would not catch that,
 * because the description it read *is* the one still in force. Batching closes
 * the window: an evaluation sees both writes or neither.
 *
 * The rest is at least the floor and never less than what the work stream had
 * already earned: `MAX` of the two. Writing the floor unconditionally would let
 * the most authoritative statement of intent a work stream ever receives make
 * the loop *more* eager to second-guess it, which is backwards. For the same
 * reason `consecutive_keeps` is left alone — an edit is not an evaluation, so
 * it is not a confirmation and not a refutation either.
 */
export async function describeAuthoredDescriptionStatement(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    description: string;
    previousDescription: string;
    now?: Date;
  },
): Promise<D1PreparedStatement> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  // Read outside the batch. A sequence that advances between this read and the
  // write only makes the next evaluation count a few extra messages as new,
  // which errs toward looking rather than toward skipping.
  const latest = await env.DB.prepare(
    `SELECT COALESCE(MAX(sequence_number), 0) AS latest_sequence
       FROM messages WHERE workspace_id = ? AND workstream_id = ?`,
  ).bind(input.workspaceId, input.workstreamId).first<{ latest_sequence: number }>();
  // `authored` is its own decision rather than a `kept`: the loop did not look,
  // a person settled it. Recording it as `kept` would make the one row that is
  // supposed to say whether anything has examined this description claim an
  // evaluation that never happened. Every field an evaluation would have filled
  // is cleared for the same reason — including `rejection_code`, which the
  // table's CHECK requires to be null for any decision but `rejected`/`failed`.
  return env.DB.prepare(
    `INSERT INTO workstream_description_refreshes
       (workstream_id, workspace_id, evaluated_at, rest_until, consecutive_keeps,
        evaluated_through_sequence, window_message_count, decision,
        previous_description, description, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, 0, 'authored', ?6, ?7, 1, ?3, ?3)
     ON CONFLICT(workstream_id) DO UPDATE SET
       evaluated_at = ?3,
       rest_until = MAX(workstream_description_refreshes.rest_until, ?4),
       evaluated_through_sequence = ?5,
       window_message_count = 0,
       decision = 'authored',
       rejection_code = NULL,
       confidence = NULL,
       model = NULL,
       previous_description = ?6,
       description = ?7,
       reasoning = NULL,
       -- Invalidates any evaluation already in flight. Its own guard protects
       -- the person's text, but not the rest and provenance this row just
       -- recorded, which its outcome write would otherwise overwrite.
       version = workstream_description_refreshes.version + 1,
       updated_at = ?3`,
  ).bind(
    input.workstreamId,
    input.workspaceId,
    at,
    restUntil(now, 0),
    Number(latest?.latest_sequence ?? 0),
    input.previousDescription,
    input.description,
  );
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
  claim: ClaimRow,
  outcome: RecordedOutcome,
): Promise<void> {
  const keeps = outcome.decision === "kept" ? Number(claim.consecutive_keeps ?? 0) + 1 : 0;
  const written = await env.DB.prepare(
    `UPDATE workstream_description_refreshes
        SET decision = ?, rejection_code = ?, confidence = ?, model = ?,
            previous_description = ?, description = ?, reasoning = ?,
            window_message_count = ?, consecutive_keeps = ?, rest_until = ?, updated_at = ?
      WHERE workstream_id = ? AND workspace_id = ? AND version = ?`,
  ).bind(
    outcome.decision,
    outcome.rejectionCode,
    outcome.confidence,
    outcome.model,
    outcome.previousDescription,
    outcome.description,
    outcome.reasoning,
    outcome.windowMessageCount,
    keeps,
    restUntil(outcome.now, keeps),
    outcome.now.toISOString(),
    input.workstreamId,
    input.workspaceId,
    claim.version,
  ).run();
  // The row moved on — a person edited the description while this evaluation
  // was running, and their write owns it. The decision is still worth knowing,
  // so it goes to the log rather than being lost with the discarded write.
  if ((written.meta?.changes ?? 0) === 0) {
    logStructuredEvent(env, "info", "workstream_description_outcome_superseded", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      decision: outcome.decision,
      rejection_code: outcome.rejectionCode,
      claim_version: claim.version,
    });
  }
}
