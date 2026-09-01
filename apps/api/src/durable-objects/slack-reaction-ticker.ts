import { z } from "zod/v3";

import type { Env } from "../env";
import { SlackAgentService } from "../services/slack-agent-service";
import { latestMigrationVersion, withMigrationReport } from "./migration-reporting";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

/**
 * The clock behind the rotating working reaction on a Slack session.
 *
 * A Durable Object alarm rather than a delayed queue message, which was the
 * first candidate because `schedulePublicChannelSync` already establishes that
 * pattern. It lost on two counts: every tick would write a `slack_ingress_jobs`
 * row, leaving dozens behind per run for a purely decorative effect, and a
 * queued message cannot be cancelled — a run that finished in ten seconds would
 * keep waking for as long as its ticks had been scheduled, each one only to
 * discover it was over. An alarm cancels by being cleared and keeps its cursor
 * in its own database, so the regional D1 is untouched between transitions.
 *
 * It is one object per Slack session rather than a member of WorkspaceDO's
 * alarm set, because the cadence is per thread: several sessions in a workspace
 * rotate independently and on their own phases.
 *
 * **This object is decoration and is allowed to be lost.** The outcome reaction
 * is applied by the delivery path, which runs on every terminal status whether
 * or not a ticker ever started. Nothing here may throw into the alarm handler:
 * a thrown alarm is retried by the runtime, and retrying a rotation step is
 * spending Slack's rate limit to redraw an emoji nobody was waiting for.
 */
const StartRequestSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  /**
   * The session's delivery key when the rotation started, or "" for a session
   * that has never delivered. Delivery stamps a new key, so a value that has
   * moved is the signal that this run is over — and unlike "has ever
   * delivered", it stays correct for a follow-up prompt in the same thread,
   * which inherits the previous run's key.
   */
  deliveryKey: z.string(),
  intervalMs: z.number().int().safe().min(3_000).max(60_000),
});

const TickerStateSchema = z.object({
  workspace_id: z.string().min(1),
  session_id: z.string().min(1),
  delivery_key: z.string(),
  interval_ms: z.number().int().safe().positive(),
  ticks: z.number().int().safe().nonnegative(),
  /** Identifies this rotation, so a resumed alarm can tell it was cancelled. */
  started_at: z.number().int().safe().nonnegative(),
});

const MIGRATION_COMPONENT = "slack_reaction_ticker";

export const SLACK_REACTION_TICKER_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "Slack session reaction rotation cursor",
  statements: [
    `CREATE TABLE slack_reaction_rotation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
      ticks INTEGER NOT NULL CHECK (ticks >= 0),
      started_at INTEGER NOT NULL
    ) STRICT`,
  ],
}];

/**
 * How many steps a rotation takes before parking on its current reaction.
 *
 * A backstop, not a policy: the liveness check ends the rotation as soon as the
 * run does, and this only bounds a ticker whose run vanished without reaching
 * delivery. At the six-second default it is about five minutes of cycling, after
 * which a very long run keeps its last working reaction until it finishes.
 */
const MAXIMUM_TICKS = 50;

export class SlackReactionTicker {
  private readonly initialized: Promise<void>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    this.initialized = state.blockConcurrencyWhile(async () => {
      await withMigrationReport({
        state,
        env,
        component: MIGRATION_COMPONENT,
        className: "SlackReactionTicker",
        latestVersion: latestMigrationVersion(SLACK_REACTION_TICKER_SCHEMA_MIGRATIONS),
      }, () => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: SLACK_REACTION_TICKER_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return responseJson({ error: "invalid_json" }, 400);
      }
      const parsed = StartRequestSchema.safeParse(input);
      if (!parsed.success) return responseJson({ error: "invalid_request" }, 400);
      // A restart resets the cursor rather than resuming: the reaction has just
      // moved to a newer message, and continuing the previous run's position
      // would read as a rotation that skipped a step.
      this.state.storage.sql.exec(
        `INSERT INTO slack_reaction_rotation
           (id, workspace_id, session_id, delivery_key, interval_ms, ticks, started_at)
         VALUES (1, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           session_id = excluded.session_id,
           delivery_key = excluded.delivery_key,
           interval_ms = excluded.interval_ms,
           ticks = 0,
           started_at = excluded.started_at`,
        parsed.data.workspaceId,
        parsed.data.sessionId,
        parsed.data.deliveryKey,
        parsed.data.intervalMs,
        Date.now(),
      );
      await this.state.storage.setAlarm(Date.now() + parsed.data.intervalMs);
      return responseJson({ started: true });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      await this.clear();
      return responseJson({ stopped: true });
    }
    return responseJson({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.initialized;
    const stored = TickerStateSchema.safeParse(
      this.state.storage.sql
        .exec("SELECT workspace_id, session_id, delivery_key, interval_ms, ticks, started_at FROM slack_reaction_rotation WHERE id = 1")
        .toArray()[0],
    );
    if (!stored.success) {
      await this.clear();
      return;
    }
    const state = stored.data;
    if (state.ticks >= MAXIMUM_TICKS) {
      await this.clear();
      return;
    }
    let live: boolean;
    try {
      live = await new SlackAgentService(this.env).advanceSessionReaction({
        workspaceId: state.workspace_id,
        sessionId: state.session_id,
        deliveryKey: state.delivery_key,
      });
    } catch {
      // `advanceSessionReaction` is written not to throw. If it does anyway, the
      // rotation stops rather than retrying: the outcome reaction does not
      // depend on this object having run.
      live = false;
    }
    if (!live) {
      await this.clear();
      return;
    }
    // `advanceSessionReaction` awaits D1 reads, a token decrypt, and a Slack
    // round trip, and the input gate lets a concurrent `/stop` run during those
    // awaits. `deleteAlarm()` does not interrupt a handler already executing, so
    // re-arming unconditionally here resurrected the rotation the stop had just
    // cancelled — and the working emoji this tick placed then outlived the
    // outcome reaction. Re-reading the row makes the cancellation stick.
    const surviving = TickerStateSchema.safeParse(
      this.state.storage.sql
        .exec("SELECT workspace_id, session_id, delivery_key, interval_ms, ticks, started_at FROM slack_reaction_rotation WHERE id = 1")
        .toArray()[0],
    );
    if (!surviving.success || surviving.data.started_at !== state.started_at) {
      await this.clear();
      return;
    }
    this.state.storage.sql.exec("UPDATE slack_reaction_rotation SET ticks = ticks + 1 WHERE id = 1");
    await this.state.storage.setAlarm(Date.now() + state.interval_ms);
  }

  private async clear(): Promise<void> {
    await this.state.storage.deleteAlarm();
    this.state.storage.sql.exec("DELETE FROM slack_reaction_rotation WHERE id = 1");
  }
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
