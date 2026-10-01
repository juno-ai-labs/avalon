import {
  DesktopActionOutcomeSchema,
  DesktopActionSchema,
  type DesktopAction,
  type DesktopActionOutcome,
  type DesktopActionRequest,
} from "@rally/contracts/desktop-actions";

/**
 * Object-local record of the work a conversation's tools asked of a desktop.
 *
 * One row per tool call, keyed by the run and the call's durable receipt id, so
 * a tool re-entered after eviction finds the action its interrupted attempt
 * recorded rather than asking a second time. The answer is stored with the
 * row: an action the desktop answered while the object was evicted is returned
 * to the re-entered tool without the desktop doing it again.
 *
 * A row is `pending` until the first answer, which moves it to `answered`
 * exactly once; later answers are duplicates. `abandoned` is a pending action
 * whose tool stopped waiting (its run was cancelled or its tool timed out), so
 * it is no longer offered to a desktop that subscribes.
 */
/**
 * The largest answer this object records, in UTF-8 bytes of its JSON.
 *
 * Not a Rally limit: Durable Object SQLite refuses a row over 2 MB, and every
 * answer is recorded before it is used, so an answer past it could never be
 * stored. The room answers such a reply with `result_too_large` instead.
 */
export const DESKTOP_ACTION_MAX_OUTCOME_BYTES = 2_000_000;

export class WorkstreamDesktopActionStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * Record the action for this call, or find the one an earlier attempt of the
   * same call recorded. The action recorded first is kept; a re-entered attempt
   * carries the same recorded input, so the two are the same action.
   */
  request(input: {
    id: string;
    runId: string;
    toolCallId: string;
    action: DesktopAction;
    now: number;
  }): { status: "pending"; request: DesktopActionRequest } | { status: "answered"; outcome: DesktopActionOutcome } {
    const row = this.sql.exec<{
      action_id: string; action_json: string; status: string; outcome_json: string | null;
    }>(
      `INSERT INTO desktop_actions (action_id, run_id, tool_call_id, action_json, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (run_id, tool_call_id) DO UPDATE SET
         status = CASE WHEN desktop_actions.status = 'abandoned' THEN 'pending' ELSE desktop_actions.status END
       RETURNING action_id, action_json, status, outcome_json`,
      input.id,
      input.runId,
      input.toolCallId,
      JSON.stringify(input.action),
      input.now,
    ).one();
    if (row.status === "answered" && row.outcome_json !== null) {
      return { status: "answered", outcome: DesktopActionOutcomeSchema.parse(JSON.parse(row.outcome_json)) };
    }
    return {
      status: "pending",
      request: { id: row.action_id, action: DesktopActionSchema.parse(JSON.parse(row.action_json)) },
    };
  }

  /** The first answer wins; the returned row says whether this one did. */
  answer(input: {
    id: string;
    outcome: DesktopActionOutcome;
    answeredByUserId: string;
    now: number;
  }): "answered" | "duplicate" | "unknown" {
    const updated = this.sql.exec<{ action_id: string }>(
      `UPDATE desktop_actions
          SET status = 'answered', outcome_json = ?, answered_by_user_id = ?, answered_at = ?
        WHERE action_id = ? AND status IN ('pending', 'abandoned')
        RETURNING action_id`,
      JSON.stringify(input.outcome),
      input.answeredByUserId,
      input.now,
      input.id,
    ).toArray();
    if (updated[0]?.action_id === input.id) return "answered";
    const existing = this.sql.exec<{ action_id: string }>(
      `SELECT action_id FROM desktop_actions WHERE action_id = ?`,
      input.id,
    ).toArray();
    return existing.length > 0 ? "duplicate" : "unknown";
  }

  /** A tool stopped waiting; its action is no longer offered to subscribers. */
  abandon(id: string): void {
    this.sql.exec(
      `UPDATE desktop_actions SET status = 'abandoned' WHERE action_id = ? AND status = 'pending'`,
      id,
    );
  }

  /** Actions still waiting on a desktop, oldest first. */
  pending(): DesktopActionRequest[] {
    return this.sql.exec<{ action_id: string; action_json: string }>(
      `SELECT action_id, action_json FROM desktop_actions
        WHERE status = 'pending' ORDER BY created_at, action_id`,
    ).toArray().map((row) => ({
      id: row.action_id,
      action: DesktopActionSchema.parse(JSON.parse(row.action_json)),
    }));
  }
}
