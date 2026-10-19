import {
  ConversationMergeV1Schema,
  SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS,
  type ConversationSuggestion,
  type ConversationSuggestionKind,
  type ConversationSuggestionStatus,
} from "@rally/contracts";
import {
  judgeTurnDisposition,
  suggestionForTurnDisposition,
  TURN_DISPOSITION_CONFIDENCE_THRESHOLD,
  TURN_DISPOSITION_MAX_RECENT_MESSAGES,
  type StructuredModelDiagnostic,
  type TurnDispositionDecision,
  type TurnDispositionState,
} from "@rally/agent-harness";

/**
 * The conversation suggestion slot and the settlement observer that fills it.
 *
 * A suggestion is one quiet line under a settled result: carry this result
 * up to the parent (`merge_up`), or break this side question out
 * (`start_breakout`). It is conversation state keyed to the judged turn, one
 * row per turn, resolved in place; never a transcript row, never in the
 * model's history, never an Activity row. The observer runs after
 * `settleAgentRun`'s description loop and from a merged result's durable alarm.
 * It runs the deterministic gates cheapest first, asks JEV once, records every decision, and writes a
 * row only for a confident positive. `docs/conversation-suggestions.md` owns
 * the lifecycle; `docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md`
 * holds the contract and the evidence behind each gate.
 */

/**
 * Pacing, defined open per `docs/adding-security-defensive-and-other-limits.md`:
 * the mechanism is built and tested at a finite value, and the number is the
 * team's to set from the slot's own record of dismissals. At `0` a dismissal
 * buys no quiet period; at `Infinity` a conversation is never capped per day.
 */
export const SUGGESTION_DISMISS_COOLDOWN_MS = 0;
/**
 * How many readable messages before the judged turn feed `earlier_outputs`
 * and `first_time_here`: a window, because every settlement pays this read
 * and a long Thread must not pay for its whole history each turn. An artifact
 * first embedded before the window reads as new to the classifier; the number
 * is a guess handed back to the team per
 * `docs/adding-security-defensive-and-other-limits.md`.
 */
export const TURN_DISPOSITION_EARLIER_OUTPUT_WINDOW = 200;
export const SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY = Number.POSITIVE_INFINITY;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared by live merge alarms and the backfill's candidate query. */
export const MERGE_JUDGEMENT_KEY_PREFIX = "merge:";

/** What counts as a message for the newest-three rule: what people and Rally said, not tool cards or system rows. */
const READABLE_TURN = `substream_id = '0'
  AND message_type IN ('text', 'automation_activation')
  AND author_type IN ('member', 'agent', 'external')
  AND trim(COALESCE(content, '')) <> ''`;

export interface SuggestionRow extends Record<string, SqlStorageValue> {
  suggestion_id: string;
  kind: ConversationSuggestionKind;
  judged_turn_id: string;
  judged_turn_sequence: number;
  run_id: string;
  status: ConversationSuggestionStatus;
  draft_status: "pending" | "ready" | "failed";
  draft_text: string | null;
  draft_subject: string | null;
  target_kind: "thread" | "channel" | null;
  target_id: string | null;
  target_title: string | null;
  decision_choice: string;
  decision_confidence: number;
  decision_model: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by_user_id: string | null;
  resolution: "accepted" | "dismissed" | "ignored" | null;
}

interface TurnRow extends Record<string, SqlStorageValue> {
  id: string;
  sequence_number: number;
  author_type: string;
  message_type: string;
  content: string | null;
  structured_content_json: string | null;
}

const SUGGESTION_COLUMNS = `suggestion_id, kind, judged_turn_id, judged_turn_sequence, run_id, status, draft_status,
  draft_text, draft_subject, target_kind, target_id, target_title, decision_choice, decision_confidence,
  decision_model, created_at, resolved_at, resolved_by_user_id, resolution`;

/** The row as the client sees it. */
export function suggestionForClient(row: SuggestionRow): ConversationSuggestion {
  return {
    suggestionId: row.suggestion_id,
    kind: row.kind,
    judgedTurnId: row.judged_turn_id,
    status: row.status,
    draft: { status: row.draft_status, text: row.draft_text, subject: row.draft_subject },
    target: row.target_kind !== null && row.target_id !== null
      ? { kind: row.target_kind, id: row.target_id, title: row.target_title ?? "" }
      : null,
  };
}

export class ConversationSuggestionStorage {
  constructor(private readonly sql: SqlStorage) {}

  byRun(runId: string): SuggestionRow | null {
    return this.sql.exec<SuggestionRow>(
      `SELECT ${SUGGESTION_COLUMNS} FROM conversation_suggestions WHERE run_id = ?`, runId,
    ).toArray()[0] ?? null;
  }

  byId(suggestionId: string): SuggestionRow | null {
    return this.sql.exec<SuggestionRow>(
      `SELECT ${SUGGESTION_COLUMNS} FROM conversation_suggestions WHERE suggestion_id = ?`, suggestionId,
    ).toArray()[0] ?? null;
  }

  /** The open rows, newest judged turn first: what a snapshot carries. */
  open(): SuggestionRow[] {
    return this.sql.exec<SuggestionRow>(
      `SELECT ${SUGGESTION_COLUMNS} FROM conversation_suggestions WHERE status = 'open' ORDER BY judged_turn_sequence DESC`,
    ).toArray();
  }

  judgementForRun(runId: string): { code: string; failure_kind: string | null; suggestion_id: string | null } | null {
    return this.sql.exec<{ code: string; failure_kind: string | null; suggestion_id: string | null } & Record<string, SqlStorageValue>>(
      `SELECT code, failure_kind, suggestion_id FROM turn_disposition_judgements WHERE run_id = ?`, runId,
    ).toArray()[0] ?? null;
  }

  recordJudgement(input: {
    runId: string; judgedTurnId: string; code: string; choice: string | null; confidence: number | null;
    carriedItemKind: string | null; model: string | null; failureKind: string | null; suggestionId: string | null; now: number;
  }): void {
    this.sql.exec(
      `INSERT INTO turn_disposition_judgements
         (run_id, judged_turn_id, code, choice, confidence, carried_item_kind, model, failure_kind, suggestion_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET code = excluded.code, choice = excluded.choice,
         confidence = excluded.confidence, carried_item_kind = excluded.carried_item_kind,
         model = excluded.model, failure_kind = excluded.failure_kind, suggestion_id = excluded.suggestion_id`,
      input.runId, input.judgedTurnId, input.code, input.choice, input.confidence,
      input.carriedItemKind, input.model, input.failureKind, input.suggestionId, input.now,
    );
  }

  insertOpen(input: {
    suggestionId: string; kind: ConversationSuggestionKind; judgedTurnId: string; judgedTurnSequence: number;
    runId: string; target: { kind: "thread" | "channel"; id: string; title: string } | null;
    decision: { choice: string; confidence: number; model: string }; now: number;
  }): SuggestionRow {
    return this.sql.exec<SuggestionRow>(
      `INSERT INTO conversation_suggestions
         (suggestion_id, kind, judged_turn_id, judged_turn_sequence, run_id, status, draft_status,
          target_kind, target_id, target_title, decision_choice, decision_confidence, decision_model, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', 'pending', ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SUGGESTION_COLUMNS}`,
      input.suggestionId, input.kind, input.judgedTurnId, input.judgedTurnSequence, input.runId,
      input.target?.kind ?? null, input.target?.id ?? null, input.target?.title ?? null,
      input.decision.choice, input.decision.confidence, input.decision.model, input.now,
    ).one();
  }

  /** The draft landed: the row fills in place. A failed draft withdraws the row, since a suggestion without its words is not shown. */
  setDraft(suggestionId: string, draft: { text: string; subject: string | null } | null): SuggestionRow | null {
    return (draft
      ? this.sql.exec<SuggestionRow>(
        `UPDATE conversation_suggestions SET draft_status = 'ready', draft_text = ?, draft_subject = ?
          WHERE suggestion_id = ? AND draft_status = 'pending' RETURNING ${SUGGESTION_COLUMNS}`,
        draft.text, draft.subject, suggestionId)
      : this.sql.exec<SuggestionRow>(
        `UPDATE conversation_suggestions SET draft_status = 'failed',
             status = CASE WHEN status = 'open' THEN 'withdrawn' ELSE status END
          WHERE suggestion_id = ? AND draft_status = 'pending' RETURNING ${SUGGESTION_COLUMNS}`,
        suggestionId)
    ).toArray()[0] ?? null;
  }

  /** A person dismissed it: gone for everyone, and recorded against the decision. */
  dismiss(suggestionId: string, userId: string, now: number): SuggestionRow | null {
    return this.sql.exec<SuggestionRow>(
      `UPDATE conversation_suggestions
          SET status = 'dismissed', resolution = 'dismissed', resolved_at = ?, resolved_by_user_id = ?
        WHERE suggestion_id = ? AND status = 'open' RETURNING ${SUGGESTION_COLUMNS}`,
      now, userId, suggestionId,
    ).toArray()[0] ?? null;
  }

  /** A merge landed from this conversation: every open merge suggestion on a turn at or before it was taken. */
  resolveMergedThrough(sequence: number, userId: string | null, now: number): SuggestionRow[] {
    return this.sql.exec<SuggestionRow>(
      `UPDATE conversation_suggestions
          SET status = 'accepted', resolution = 'accepted', resolved_at = ?, resolved_by_user_id = ?
        WHERE status = 'open' AND kind = 'merge_up' AND judged_turn_sequence <= ? RETURNING ${SUGGESTION_COLUMNS}`,
      now, userId, sequence,
    ).toArray();
  }

  /** A Breakout was cut at this turn: the open breakout suggestion on it was taken. */
  resolveBreakoutAt(judgedTurnId: string, userId: string, now: number): SuggestionRow | null {
    return this.sql.exec<SuggestionRow>(
      `UPDATE conversation_suggestions
          SET status = 'accepted', resolution = 'accepted', resolved_at = ?, resolved_by_user_id = ?
        WHERE status = 'open' AND kind = 'start_breakout' AND judged_turn_id = ? RETURNING ${SUGGESTION_COLUMNS}`,
      now, userId, judgedTurnId,
    ).toArray()[0] ?? null;
  }

  /**
   * The newest-three rule, written down: an open row whose turn now has
   * {@link SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS} newer readable messages is
   * closed as ignored. The client hides the line by the same count on what it
   * holds; this is the record of the outcome.
   */
  expireBehindNewest(now: number): SuggestionRow[] {
    return this.sql.exec<SuggestionRow>(
      `UPDATE conversation_suggestions
          SET status = 'expired', resolution = 'ignored', resolved_at = ?
        WHERE status = 'open'
          AND (SELECT COUNT(*) FROM canonical_conversation_turn_details turn
                WHERE ${READABLE_TURN.replaceAll(/\b(substream_id|message_type|author_type|content)\b/g, "turn.$1")}
                  AND turn.sequence_number > conversation_suggestions.judged_turn_sequence) >= ?
        RETURNING ${SUGGESTION_COLUMNS}`,
      now, SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS,
    ).toArray();
  }

  /** Gate 6: the newest dismissal of a kind, and how many suggestions this conversation showed in the last day. */
  pacing(kind: ConversationSuggestionKind, now: number): { lastDismissedAt: number | null; shownToday: number } {
    const dismissed = this.sql.exec<{ at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MAX(resolved_at) AS at FROM conversation_suggestions WHERE kind = ? AND status = 'dismissed'`, kind,
    ).one().at;
    const shown = this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM conversation_suggestions WHERE created_at > ? AND status <> 'withdrawn'`, now - DAY_MS,
    ).one().count;
    return { lastDismissedAt: dismissed, shownToday: Number(shown) };
  }

  // The reads the observer needs from the transcript, kept here so the gates
  // and the state are built from one definition of "a readable message".

  turn(turnId: string): TurnRow | null {
    return this.sql.exec<TurnRow>(
      `SELECT id, sequence_number, author_type, message_type, content, structured_content_json
         FROM canonical_conversation_turn_details WHERE substream_id = '0' AND id = ?`, turnId,
    ).toArray()[0] ?? null;
  }

  /**
   * The backfill's candidate: the newest completed final output or incoming
   * merge among the newest {@link SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS}
   * readable messages. A merge's stable key is merge:<turnId>, since it starts
   * no run. Older than that, a chip
   * could not be shown, and the judgement would only record `late`.
   */
  newestSettledTurn(): { runId: string; turnId: string } | null {
    const row = this.sql.exec<{ run_id: string; turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT CASE WHEN json_extract(turn.structured_content_json, '$.type') = 'conversation_merge'
                   THEN ? || turn.id ELSE run.run_id END AS run_id, turn.id AS turn_id
         FROM (SELECT id, sequence_number, author_type, structured_content_json FROM canonical_conversation_turn_details
                WHERE ${READABLE_TURN} ORDER BY sequence_number DESC LIMIT ?) turn
         LEFT JOIN runs run ON run.final_turn_id = turn.id AND run.status = 'completed'
        WHERE (turn.author_type = 'agent' AND run.run_id IS NOT NULL)
           OR json_extract(turn.structured_content_json, '$.type') = 'conversation_merge'
        ORDER BY turn.sequence_number DESC LIMIT 1`,
      MERGE_JUDGEMENT_KEY_PREFIX, SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS,
    ).toArray()[0];
    return row ? { runId: row.run_id, turnId: row.turn_id } : null;
  }

  /** Readable messages before a sequence, newest first, bounded. */
  readableBefore(sequence: number, limit: number): TurnRow[] {
    return this.sql.exec<TurnRow>(
      `SELECT id, sequence_number, author_type, message_type, content, structured_content_json
         FROM canonical_conversation_turn_details WHERE ${READABLE_TURN} AND sequence_number < ?
        ORDER BY sequence_number DESC LIMIT ?`, sequence, limit,
    ).toArray();
  }

  readableCountBefore(sequence: number): number {
    return Number(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE ${READABLE_TURN} AND sequence_number < ?`, sequence,
    ).one().count);
  }

  readableCountAfter(sequence: number): number {
    return Number(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE ${READABLE_TURN} AND sequence_number > ?`, sequence,
    ).one().count);
  }

  /** The opening request: the first thing a person said here. */
  openingRequest(): string | null {
    const row = this.sql.exec<TurnRow>(
      `SELECT id, sequence_number, author_type, message_type, content, structured_content_json
         FROM canonical_conversation_turn_details WHERE ${READABLE_TURN} AND author_type IN ('member', 'external')
        ORDER BY sequence_number ASC LIMIT 1`,
    ).toArray()[0];
    return row?.content ?? null;
  }

  /** How many merge markers sit before and after a sequence: what was carried up already, and whether this turn was. */
  mergeMarkers(sequence: number): { before: number; after: number } {
    const row = this.sql.exec<{ before: number; after: number } & Record<string, SqlStorageValue>>(
      `SELECT SUM(CASE WHEN sequence_number < ? THEN 1 ELSE 0 END) AS before,
              SUM(CASE WHEN sequence_number > ? THEN 1 ELSE 0 END) AS after
         FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND json_extract(structured_content_json, '$.type') = 'conversation_merged_into'`,
      sequence, sequence,
    ).one();
    return { before: Number(row.before ?? 0), after: Number(row.after ?? 0) };
  }

  /** The newest compaction summary that covers the transcript before a sequence, if any. */
  compactionSummaryBefore(sequence: number): string | null {
    const row = this.sql.exec<{ summary: string | null } & Record<string, SqlStorageValue>>(
      `SELECT json_extract(payload.payload_json, '$.summary') AS summary
         FROM transcript_compaction_checkpoints checkpoint
         JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE checkpoint.compacted_through_sequence < ?
        ORDER BY checkpoint.compacted_through_sequence DESC LIMIT 1`,
      sequence,
    ).toArray()[0];
    return typeof row?.summary === "string" && row.summary.trim().length > 0 ? row.summary : null;
  }
}

/** `resource://` embeds a message carries, in order, each once, with the link's own text as its title. */
export function resourceEmbeds(text: string): Array<{ id: string; title: string }> {
  const seen = new Set<string>();
  const embeds: Array<{ id: string; title: string }> = [];
  for (const match of text.matchAll(/!?\[([^\]\n]*)\]\(resource:\/\/([A-Za-z0-9._~:-]+)\)/g)) {
    const id = match[2]!;
    if (seen.has(id)) continue;
    seen.add(id);
    embeds.push({ id, title: match[1]!.trim() || id });
  }
  return embeds;
}

/** The parent as the classifier names it: the Thread above a Breakout, the Channel a Thread would merge into. */
export interface SuggestionParent {
  kind: "thread" | "channel";
  id: string;
  title: string;
  purpose: string | undefined;
}

export interface TurnDispositionObservationInput {
  env: { TYPESAFE_API_KEY?: string | undefined; AVALON_REGION?: string; APP_ENV?: string; BUILD_SHA?: string | undefined };
  /** The provider transport; a test passes a double. */
  fetch?: typeof globalThis.fetch | undefined;
  storage: ConversationSuggestionStorage;
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
  runId: string;
  finalTurnId: string | null;
  completed: boolean;
  backgroundAgent: boolean;
  /** The conversation's own row: null when it has none to read. */
  identity: { title: string; description: string; scope: string; archived_at: number | null; system_kind: string | null } | null;
  /** The parent, read over RPC after the cheap gates pass; null when none can be named. */
  readParent: () => Promise<SuggestionParent | null>;
  onDiagnostic: (diagnostic: StructuredModelDiagnostic) => void;
  traceId: string;
  now: () => number;
  newId: () => string;
  /** Runs the row and judgement writes as one transaction; the agent passes `transactionSync`. */
  commit: <T>(mutate: () => T) => T;
  /**
   * Whether this object is drafting the row right now. A `pending` row is
   * resumed only when nobody is: a settlement and the backfill judging one run
   * at once would otherwise both draft it, and the first to fail would
   * withdraw the other's words.
   */
  draftInFlight?: (suggestionId: string) => boolean;
  threshold?: number;
  cooldownMs?: number;
  maximumPerDay?: number;
}

export type TurnDispositionObservation =
  | { outcome: "skipped"; gate: string }
  | { outcome: "judged"; code: string; confidence: number | null; model: string | null; failureKind: string | null; suggestion: SuggestionRow | null }
  | { outcome: "resumed"; suggestion: SuggestionRow };

/**
 * The settlement observer. Gates in order, each the reason not to pay for the
 * next; one JEV call; every decision recorded; a row only for a confident
 * positive of an offerable kind. Pure over its storage and the two callbacks,
 * so a workerd test can drive it with a fetch double and a Node test with a
 * database, and the agent's step is one call that never throws.
 */
export async function observeTurnDisposition(input: TurnDispositionObservationInput): Promise<TurnDispositionObservation> {
  const threshold = input.threshold ?? TURN_DISPOSITION_CONFIDENCE_THRESHOLD;
  // Gate 1: a completed run's final output, or an admitted merged result. Merges
  // start no run; their stable merge:<turnId> key uses the same judgement slot.
  if (!input.completed || !input.finalTurnId) return { outcome: "skipped", gate: "run_not_completed" };
  const judged = input.storage.turn(input.finalTurnId);
  const merge = judged?.structured_content_json != null
    ? ConversationMergeV1Schema.safeParse(JSON.parse(judged.structured_content_json)) : null;
  const mergedResult = merge?.success === true;
  if (!judged || judged.message_type !== "text" || (judged.author_type !== "agent" && !mergedResult) || !(judged.content ?? "").trim()) {
    return { outcome: "skipped", gate: "final_turn_not_text" };
  }
  // Gate 2: a conversation people read.
  if (input.backgroundAgent) return { outcome: "skipped", gate: "background_agent" };
  if (!input.identity || input.identity.archived_at !== null) return { outcome: "skipped", gate: "archived" };
  if (input.identity.system_kind !== null) return { outcome: "skipped", gate: "system_conversation" };
  // Gate 3: judged once per run. A judgement that records a classifier
  // failure is not an answer, so a later attempt (a replayed settlement, the
  // backfill's retry) asks again and overwrites it.
  const earlier = input.storage.judgementForRun(input.runId);
  if (earlier && earlier.failure_kind === null) {
    const row = earlier.suggestion_id ? input.storage.byId(earlier.suggestion_id) : null;
    if (row && row.status === "open" && row.draft_status === "pending") {
      if (input.draftInFlight?.(row.suggestion_id)) return { outcome: "skipped", gate: "draft_in_flight" };
      return { outcome: "resumed", suggestion: row };
    }
    return { outcome: "skipped", gate: "already_judged" };
  }
  const now = input.now();
  const conversationKind = input.substreamId === "0" ? "thread" : "breakout";
  // Gate 4: at least one kind this conversation can offer. A Breakout offers
  // only merge_up, as does an incoming merged result. Other Thread outputs
  // also offer start_breakout, even when there is no eligible Channel.
  const parent = await input.readParent();
  const mergeOfferable = parent !== null;
  if ((conversationKind === "breakout" || mergedResult) && !mergeOfferable) return { outcome: "skipped", gate: "nothing_offerable" };
  // Gate 5: not already carried up.
  const markers = input.storage.mergeMarkers(judged.sequence_number);
  if (markers.after > 0) return { outcome: "skipped", gate: "already_carried_up" };

  const state = buildTurnDispositionState({
    storage: input.storage, judged, parent, conversationKind,
    identity: input.identity,
    carriedUpBefore: markers.before,
    ...(merge?.success ? { mergedFrom: merge.data.mergedFrom } : {}),
  });
  const decision = input.env.TYPESAFE_API_KEY
    ? await judgeTurnDisposition({
      typesafeApiKey: input.env.TYPESAFE_API_KEY,
      state,
      onDiagnostic: input.onDiagnostic,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      traceContext: {
        source: "turn_disposition_classifier",
        feature: "turn-disposition",
        workspaceId: input.workspaceId,
        requestId: input.traceId,
        ...(input.env.AVALON_REGION ? { region: input.env.AVALON_REGION } : {}),
        ...(input.env.APP_ENV ? { environment: input.env.APP_ENV } : {}),
        ...(input.env.BUILD_SHA ? { buildSha: input.env.BUILD_SHA } : {}),
      },
    })
    : unavailable("typesafe_key_missing");

  const offered = suggestionForTurnDisposition(decision, conversationKind, threshold);
  const kind: ConversationSuggestionKind | null = offered === "merge_up" && mergeOfferable ? "merge_up"
    : offered === "start_breakout" && !mergedResult ? "start_breakout"
    : null;
  let code: string = decision.code;
  if (decision.disposition !== null && decision.confidence !== null && decision.disposition !== "continue_here" && kind === null) {
    // Below threshold is about the confidence alone; a confident side question
    // in a Breakout, or a confident carry-up with no parent to offer, is a
    // positive the host could not offer, and the record says so.
    code = !(decision.confidence > threshold) ? "confidence_below_threshold" : "not_offerable";
  }
  const written = input.commit(() => {
  // Gate 3 again, inside the write: the classifier call yielded, and another
  // caller judging the same run meanwhile (its settlement and the backfill)
  // must not have its decision overwritten, nor its row collided with.
  const meanwhile = input.storage.judgementForRun(input.runId);
  if (meanwhile && meanwhile.failure_kind === null) return null;
  let suggestion: SuggestionRow | null = null;
  if (kind !== null) {
    // Gate 5 again, inside the write: the classifier call yielded, and a merge
    // that landed meanwhile resolved no row because there was none yet
    // (docs/durable-object-sqlite.md, re-check a fence after an await).
    if (input.storage.mergeMarkers(judged.sequence_number).after > 0) {
      code = "already_carried_up";
    // Gate 3b: a settlement that lands behind three newer messages has
    // nothing to show; the decision is still recorded.
    } else if (input.storage.readableCountAfter(judged.sequence_number) >= SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS) {
      code = "late";
    } else {
      const pacing = input.storage.pacing(kind, now);
      const cooldown = input.cooldownMs ?? SUGGESTION_DISMISS_COOLDOWN_MS;
      const maximum = input.maximumPerDay ?? SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY;
      if ((pacing.lastDismissedAt !== null && now - pacing.lastDismissedAt < cooldown) || pacing.shownToday >= maximum) {
        code = "paced";
      } else {
        suggestion = input.storage.insertOpen({
          suggestionId: input.newId(),
          kind,
          judgedTurnId: judged.id,
          judgedTurnSequence: judged.sequence_number,
          runId: input.runId,
          target: kind === "merge_up" && parent ? { kind: parent.kind, id: parent.id, title: parent.title } : null,
          decision: { choice: decision.disposition!, confidence: decision.confidence!, model: decision.model ?? "unknown" },
          now,
        });
      }
    }
  }
  input.storage.recordJudgement({
    runId: input.runId,
    judgedTurnId: judged.id,
    code,
    choice: decision.disposition,
    confidence: decision.confidence,
    carriedItemKind: decision.kind,
    model: decision.model,
    failureKind: decision.failureKind ?? null,
    suggestionId: suggestion?.suggestion_id ?? null,
    now,
  });
  return { code, suggestion };
  });
  if (written === null) return { outcome: "skipped", gate: "already_judged" };
  return { outcome: "judged", code: written.code, confidence: decision.confidence, model: decision.model, failureKind: decision.failureKind ?? null, suggestion: written.suggestion };
}

function unavailable(failureKind: string): TurnDispositionDecision {
  return { code: "classifier_unavailable", disposition: null, confidence: null, kind: null, kindConfidence: null, model: null, failureKind };
}

/** The state exactly as `design.md`'s "What the classifier is shown, and why" lays it out, before the request's bounds. */
export function buildTurnDispositionState(input: {
  storage: ConversationSuggestionStorage;
  judged: TurnRow;
  parent: SuggestionParent | null;
  conversationKind: "thread" | "breakout";
  identity: { title: string; description: string };
  carriedUpBefore: number;
  mergedFrom?: { title: string };
}): TurnDispositionState {
  const earlier = input.storage.readableBefore(input.judged.sequence_number, TURN_DISPOSITION_EARLIER_OUTPUT_WINDOW);
  const messagesBefore = input.storage.readableCountBefore(input.judged.sequence_number);
  const opening = input.storage.openingRequest();
  const judgedText = input.judged.content ?? "";
  const judgedEmbeds = resourceEmbeds(judgedText);
  const earlierOutputs: Array<{ title: string; messages_ago: number; id: string }> = [];
  const seen = new Set<string>();
  earlier.forEach((row, index) => {
    for (const embed of resourceEmbeds(row.content ?? "")) {
      if (seen.has(embed.id)) continue;
      seen.add(embed.id);
      earlierOutputs.push({ id: embed.id, title: embed.title, messages_ago: index + 1 });
    }
  });
  const summary = input.storage.compactionSummaryBefore(input.judged.sequence_number);
  const purpose = input.identity.description.trim() || firstLine(opening ?? input.identity.title);
  return {
    parent: input.parent
      ? { kind: input.parent.kind, title: input.parent.title, ...(input.parent.purpose ? { purpose: input.parent.purpose } : {}) }
      : { kind: input.conversationKind === "breakout" ? "thread" : "channel", title: "" },
    conversation: {
      kind: input.conversationKind,
      title: input.identity.title,
      purpose,
      ...(opening ? { opening_request: opening } : {}),
      messages_before: messagesBefore,
    },
    so_far: {
      ...(summary ? { summary } : {}),
      earlier_outputs: earlierOutputs.reverse().map(({ title, messages_ago }) => ({ title, messages_ago })),
      carried_up_before: input.carriedUpBefore,
    },
    recent_messages: earlier.slice(0, TURN_DISPOSITION_MAX_RECENT_MESSAGES).reverse().map((row) => ({
      author: row.author_type === "agent" ? "rally" as const : "person" as const,
      text: row.content ?? "",
    })),
    judged_message: {
      author: input.judged.author_type === "agent" ? "rally" : "person",
      ...(input.mergedFrom ? { merged_from: { kind: "breakout" as const, title: input.mergedFrom.title } } : {}),
      text: judgedText,
      outputs: judgedEmbeds.map((embed) => ({ title: embed.title, first_time_here: !seen.has(embed.id) })),
    },
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? text;
}
