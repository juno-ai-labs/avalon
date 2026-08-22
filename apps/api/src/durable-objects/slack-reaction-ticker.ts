import { z } from "zod";

import type { Env } from "../env";
import { SlackAgentService } from "../services/slack-agent-service";

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
 * in its own storage, so D1 is untouched between transitions.
 *
 * **This object is decoration and is allowed to be lost.** The outcome reaction
 * is applied by the delivery path, which runs on every terminal status whether
 * or not a ticker ever started. Nothing here may throw into the alarm handler:
 * a thrown alarm is retried by the runtime, and retrying a rotation step is
 * spending Slack's rate limit to redraw an emoji nobody was waiting for.
 */
const StartRequestSchema = z.object({
  sessionId: z.string().min(1),
  intervalMs: z.number().int().min(3_000).max(60_000),
});

const TickerStateSchema = z.object({
  sessionId: z.string().min(1),
  intervalMs: z.number().int().positive(),
  ticks: z.number().int().nonnegative(),
});

const STATE_KEY = "slackReactionTicker";

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
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
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
      await this.state.storage.put(STATE_KEY, { ...parsed.data, ticks: 0 });
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
    const stored = TickerStateSchema.safeParse(await this.state.storage.get(STATE_KEY));
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
      live = await new SlackAgentService(this.env).advanceSessionReaction(state.sessionId);
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
    await this.state.storage.put(STATE_KEY, { ...state, ticks: state.ticks + 1 });
    await this.state.storage.setAlarm(Date.now() + state.intervalMs);
  }

  private async clear(): Promise<void> {
    await this.state.storage.deleteAlarm();
    await this.state.storage.delete(STATE_KEY);
  }
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
