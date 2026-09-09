import { DemoPreparationWorkflowInputSchema, type DemoPreparationWorkflowInput } from "@rally/contracts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

import type { Env } from "../env";
import {
  exhaustDemoProjectionWait,
  failDemoPreparationDriver,
  runDemoPreparationPhase,
  type DemoPhaseOutcome,
} from "../services/demo-preparation";

/**
 * The driver for one demo preparation attempt: one step per phase, then a
 * check-and-sleep loop until the workspace matches the pack.
 *
 * Every phase function is idempotent, so an attempt resumes rather than
 * repeats; the row the operator reads is written by the phase, not by this
 * class. The payload is a pointer — operation id and attempt — re-read on
 * arrival, and the operation's rows are the authority for everything else.
 *
 * A step does not retry. A phase that fails is final for this attempt, and the
 * operator's Retry is the retry: it starts the next attempt, whose number the
 * row now carries, and this driver — if it is still alive — is refused at its
 * next phase call. A step that retried on its own would race that, putting two
 * drivers on one operation. Whatever stops this driver outside a phase body —
 * a step the platform ended, an error between steps — is recorded on the row
 * before it propagates, so the operation never sits `running` with nothing
 * running it.
 *
 * The wait is a loop of steps rather than one long step because a step's
 * result is what Workflows memoize: a check that answered "waiting" is
 * recorded, the sleep is durable, and an eviction in between resumes at the
 * next check instead of at the start of the wait.
 */
const PROJECTION_POLL = "10 seconds";

const NO_RETRIES: WorkflowStepConfig = { retries: { limit: 0, delay: "1 second" } };

const PROJECTION_POLL_MS = 10_000;

/** The phases before the wait, each one step. */
const LEADING_PHASES = ["checking_template", "creating_workspace", "copying_connections", "seeding_conversations"] as const;

/**
 * How many rounds the wait may take, from the platform's own ceiling.
 *
 * Cloudflare publishes a maximum number of steps per Workflow instance
 * (https://developers.cloudflare.com/workflows/platform/limits/, read
 * 2026-09-08): 1,024 on the Workers Free plan, 10,000 by default on Paid.
 * Each wait round costs two steps — one check, one sleep — after the phase
 * steps before it, and the final round skips its sleep, so one step of
 * headroom is kept: bounding the rounds by the smaller published figure means
 * the wait ends, on either plan, with a failure this driver recorded rather
 * than with the platform ending the instance mid-round, which records nothing.
 * At the poll cadence above that is about 85 minutes; a readiness gap that
 * lasts that long is not a projection still on its way.
 */
const WORKFLOW_STEP_LIMIT = 1_024;
const PHASE_STEPS = LEADING_PHASES.length;
const STEPS_PER_WAIT_ROUND = 2;
const STEP_HEADROOM = 1;
const MAX_PROJECTION_WAIT_ROUNDS = Math.floor((WORKFLOW_STEP_LIMIT - PHASE_STEPS - STEP_HEADROOM) / STEPS_PER_WAIT_ROUND);
const MAX_PROJECTION_WAIT_MINUTES = Math.round((MAX_PROJECTION_WAIT_ROUNDS * PROJECTION_POLL_MS) / 60_000);

/**
 * What a step memoizes: the outcome alone. The detail a phase produced is in
 * its row already, and a step result has to be serializable.
 */
function outcomeOf(result: DemoPhaseOutcome): DemoPhaseOutcome["outcome"] {
  return result.outcome;
}

export class DemoPreparationWorkflow extends WorkflowEntrypoint<Env, DemoPreparationWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<DemoPreparationWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<{ outcome: "ready" }> {
    const input = DemoPreparationWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");
    const phaseOptions = { attempt: input.attempt };
    try {
      for (const phase of LEADING_PHASES) {
        await step.do(
          phase,
          NO_RETRIES,
          async () => outcomeOf(await runDemoPreparationPhase(this.env, input.operationId, phase, phaseOptions)),
        );
      }
      for (let round = 0; round < MAX_PROJECTION_WAIT_ROUNDS; round += 1) {
        const outcome = await step.do(
          `waiting_for_workspace:${round}`,
          NO_RETRIES,
          async () => outcomeOf(await runDemoPreparationPhase(this.env, input.operationId, "waiting_for_workspace", phaseOptions)),
        );
        if (outcome === "ready") return { outcome: "ready" };
        // No sleep after the last check: nothing follows it but the failure.
        if (round + 1 < MAX_PROJECTION_WAIT_ROUNDS) await step.sleep(`projection_wait:${round}`, PROJECTION_POLL);
      }
      return exhaustDemoProjectionWait(this.env, input.operationId, input.attempt, {
        rounds: MAX_PROJECTION_WAIT_ROUNDS,
        minutes: MAX_PROJECTION_WAIT_MINUTES,
      });
    } catch (error) {
      await failDemoPreparationDriver(this.env, input.operationId, input.attempt, error);
      throw error;
    }
  }
}
