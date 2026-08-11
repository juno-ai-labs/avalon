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
 * How long a work stream rests between evaluations. Descriptions are read in
 * lists and remembered; one that moves faster than a person checks in is worse
 * than one that lags.
 */
export const DESCRIPTION_REFRESH_MINIMUM_INTERVAL_SECONDS = 6 * 60 * 60;
/**
 * How much has to be new before the loop looks again. Below this the window is
 * substantially the one that produced the current description, so the model
 * would be re-deciding the same question at the same cost.
 */
export const DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES = 15;

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
  text_content: string;
  created_at: string;
}

interface ClaimRow {
  version: number;
}

interface PreviousRefreshRow {
  evaluated_at: string;
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

  const workstream = await env.DB.prepare(
    `SELECT title, objective, description_source, origin_type, archived_at
       FROM workstreams WHERE id = ? AND workspace_id = ?`,
  ).bind(input.workstreamId, input.workspaceId).first<WorkstreamDescriptionRow>();
  if (!workstream) return { status: "skipped", reason: "workstream_missing" };
  if (workstream.archived_at != null) return { status: "skipped", reason: "archived" };
  // An automation's work stream describes one run of a saved configuration. Its
  // description belongs to that configuration, and rewriting it here would put
  // this loop in an argument with the automation that owns it.
  if (workstream.origin_type === "automation") return { status: "skipped", reason: "automation_origin" };

  const previous = await env.DB.prepare(
    `SELECT evaluated_at, evaluated_through_sequence
       FROM workstream_description_refreshes WHERE workstream_id = ? AND workspace_id = ?`,
  ).bind(input.workstreamId, input.workspaceId).first<PreviousRefreshRow>();
  const dueBefore = new Date(
    now.getTime() - DESCRIPTION_REFRESH_MINIMUM_INTERVAL_SECONDS * 1_000,
  ).toISOString();
  if (previous && String(previous.evaluated_at) > dueBefore) return { status: "skipped", reason: "not_due" };

  const window = await loadWindow(env, input.workspaceId, input.workstreamId, now);
  if (window.messages.length === 0) return { status: "skipped", reason: "empty_window" };
  const evaluatedThrough = Number(previous?.evaluated_through_sequence ?? 0);
  const newMessages = window.messages.filter((message) => message.sequenceNumber > evaluatedThrough).length;
  if (newMessages < DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES) {
    return { status: "skipped", reason: "insufficient_new_messages" };
  }

  const claim = await claimEvaluation(env, input, window, dueBefore, now);
  if (!claim) return { status: "skipped", reason: "not_due" };

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
    await recordOutcome(env, input, claim, {
      decision: "rejected",
      rejectionCode: "description_changed_during_evaluation",
      model: routing.model,
      previousDescription: workstream.objective,
      description: workstream.objective,
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
    `SELECT m.sequence_number, m.author_type, m.text_content, m.created_at, u.name AS author_name
       FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.workspace_id = ? AND m.workstream_id = ?
        AND m.message_type <> 'tool' AND trim(m.text_content) <> ''
      ORDER BY m.sequence_number DESC
      LIMIT ?`,
  ).bind(workspaceId, workstreamId, limit).all<WindowMessageRow>();

  const ordered = (rows.results ?? []).slice().reverse();
  const messages = ordered.map((row) => ({
    sequenceNumber: Number(row.sequence_number),
    authorType: row.author_type === "agent" ? "agent" : row.author_type === "system" ? "system" : "human",
    authorName: row.author_name == null ? null : String(row.author_name),
    occurredAt: String(row.created_at),
    text: String(row.text_content),
  } satisfies WindowMessage));
  return {
    messages,
    latestSequence: messages.at(-1)?.sequenceNumber ?? 0,
    truncated: requested > limit,
  };
}

/**
 * Take the work stream's evaluation window, or report that it is not this run's
 * to take.
 *
 * Stamping `evaluated_at` before the model call rather than after is what stops
 * two runs terminalizing together from both spending one, and what stops a model
 * that is failing from being retried by every run behind it. The interval is
 * re-checked here, inside the write, because the read that admitted this
 * evaluation is not atomic with it.
 */
async function claimEvaluation(
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
  window: DescriptionWindow,
  dueBefore: string,
  now: Date,
): Promise<ClaimRow | null> {
  const at = now.toISOString();
  const claimed = await env.DB.prepare(
    `INSERT INTO workstream_description_refreshes
       (workstream_id, workspace_id, evaluated_at, evaluated_through_sequence,
        window_message_count, decision, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 1, ?3, ?3)
     ON CONFLICT(workstream_id) DO UPDATE SET
       evaluated_at = ?3,
       evaluated_through_sequence = ?4,
       window_message_count = ?5,
       decision = 'pending',
       rejection_code = NULL,
       version = workstream_description_refreshes.version + 1,
       updated_at = ?3
     WHERE workstream_description_refreshes.evaluated_at <= ?6`,
  ).bind(
    input.workstreamId,
    input.workspaceId,
    at,
    window.latestSequence,
    window.messages.length,
    dueBefore,
  ).run();
  if ((claimed.meta?.changes ?? 0) === 0) return null;

  return env.DB.prepare(
    `SELECT version FROM workstream_description_refreshes
      WHERE workstream_id = ? AND workspace_id = ?`,
  ).bind(input.workstreamId, input.workspaceId).first<ClaimRow>();
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
 * Close the claim with what it decided. Guarded on the claim's version so a
 * slow evaluation cannot overwrite the result of the one that superseded it.
 */
async function recordOutcome(
  env: Env,
  input: RefreshWorkstreamDescriptionInput,
  claim: ClaimRow,
  outcome: RecordedOutcome,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workstream_description_refreshes
        SET decision = ?, rejection_code = ?, confidence = ?, model = ?,
            previous_description = ?, description = ?, reasoning = ?,
            window_message_count = ?, updated_at = ?
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
    outcome.now.toISOString(),
    input.workstreamId,
    input.workspaceId,
    claim.version,
  ).run();
}
