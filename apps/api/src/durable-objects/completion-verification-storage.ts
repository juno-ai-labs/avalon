import { COMPLETION_VERIFICATION_SOURCE, type CompletionState } from "@rally/agent-harness";
import { WorkstreamMessageStorage } from "./workstream-message-storage";

export interface CompletionVerificationSnapshot {
  lifecycle: "ready" | "cancelled" | "input_required" | "background_pending" | "ambiguous_write" | "recovery_used" | "unknown";
  trigger: CompletionState["triggering_request"] | null;
  receipts: CompletionState["tool_receipts"];
}

/** Reads existing authorities. The derived nudge fact is both the message and
 * durable one-use marker; compaction only removes projection links. */
export function readCompletionVerificationSnapshot(storage: DurableObjectStorage, runId: string, triggerId: string | null): CompletionVerificationSnapshot {
  const sql = storage.sql;
  const run = sql.exec<{ status: string; terminalized_at: number | null; cancellation_requested_at: number | null; stop_requested_at: number | null }>(
    `SELECT run.status, run.terminalized_at, run.cancellation_requested_at, loop.stop_requested_at
       FROM runs run JOIN substream_loops loop ON loop.active_execution_id = run.run_id
      WHERE run.run_id = ? AND loop.status = 'executing'`, runId,
  ).toArray()[0];
  const used = sql.exec<{ fact_id: string }>(
    `SELECT fact_id FROM transcript_facts
      WHERE origin_kind = 'derived' AND source_kind = ? AND source_id = ? LIMIT 1`,
    COMPLETION_VERIFICATION_SOURCE, runId,
  ).toArray().length > 0;
  const pendingQuestion = sql.exec<{ elicitation_id: string }>(
    `SELECT elicitation_id FROM elicitation_requests WHERE run_id = ? AND status = 'pending' LIMIT 1`, runId,
  ).toArray().length > 0;
  const effects = sql.exec<{
    tool_call_id: string; tool_name: string; status: string; mode: string;
    output_summary: string | null; output_ref: string | null; error_json: string | null;
  }>(`SELECT tool_call_id, tool_name, status, mode, output_summary, output_ref, error_json
        FROM tool_effects WHERE run_id = ? ORDER BY tool_position`, runId).toArray();
  const row = triggerId ? new WorkstreamMessageStorage(storage).message({ messageId: triggerId }) : null;
  // Elicitation answers can have an empty body; retain the question/answer wrapper.
  const trigger = row ? { id: row.id, text: row.text_content || row.structured_content_json || "", origin: row.author_type } : null;
  const lifecycle = !run ? "unknown"
    : run.stop_requested_at !== null || run.cancellation_requested_at !== null || run.terminalized_at !== null || run.status === "cancelled" ? "cancelled"
    : used ? "recovery_used"
    : pendingQuestion || run.status === "needs_input" ? "input_required"
    : effects.some((effect) => effect.mode === "write" && effect.status === "ambiguous") ? "ambiguous_write"
    : effects.some((effect) => effect.status === "admitted" || effect.status === "executing") ? "background_pending"
    : run.status !== "running" ? "unknown" : "ready";
  return { lifecycle, trigger,
    receipts: effects.map((effect) => ({ id: effect.tool_call_id, operation: effect.tool_name,
      target: {}, status: effect.status, summary: effect.output_summary ?? effect.error_json,
      output_refs: effect.output_ref ? [effect.output_ref] : [] })),
  };
}
