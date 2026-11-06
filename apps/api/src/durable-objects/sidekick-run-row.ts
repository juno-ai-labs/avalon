import type { SqlStorageValue } from "@cloudflare/workers-types";

/**
 * A Sidekick run's row in its Sidekick's shared conversation, as the
 * conversation reads it.
 *
 * The row is an `automation_activation` turn written once; what it shows (the
 * run's state, its steps, its reply) lives in `sidekick_run_rows`, the
 * conversation's projection of the Sidekick's `sidekick_runs` row, and is
 * joined in here whenever the turn is read. `docs/automation-lifecycle.md`
 * owns the mechanism.
 */

export type SidekickRunRowState = "pending" | "running" | "needs_input" | "completed" | "failed" | "stopped";

export interface SidekickRunRowFacts {
  state: SidekickRunRowState;
  stepCount: number;
  reply: string | null;
}

/** The row's text: the run's reply once it has one, otherwise a line saying where the run is. */
export function sidekickRunRowText(state: SidekickRunRowState, reply: string | null): string {
  if (reply !== null && reply.trim().length > 0) return reply;
  switch (state) {
    case "pending": return "Starting a run.";
    case "running": return "Working on it.";
    case "needs_input": return "Waiting for input.";
    case "completed": return "Finished.";
    case "failed": return "The run failed.";
    case "stopped": return "The run was stopped.";
  }
}

/** What each of these turns shows now, for the turns that are run rows; one read. */
export function sidekickRunRowFacts(sql: SqlStorage, turnIds: readonly string[]): Map<string, SidekickRunRowFacts> {
  if (turnIds.length === 0) return new Map();
  return new Map(sql.exec<{
    turn_id: string; state: SidekickRunRowState; step_count: number; reply: string | null;
  } & Record<string, SqlStorageValue>>(
    `SELECT turn_id, state, step_count, reply FROM sidekick_run_rows
      WHERE turn_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(turnIds),
  ).toArray().map((row) => [row.turn_id, { state: row.state, stepCount: Number(row.step_count), reply: row.reply }]));
}
