import { WorkstreamWorkflowInputSchema, type WorkstreamWorkflowInput } from "@avalon/contracts";
import { createDatabase } from "@avalon/db";
import { connectorRetryAfterMs } from "@avalon/connectors";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import { workstreamRoomName } from "../durable-objects/workstream-room";
import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import {
  claimHarnessAttempt,
  reapStaleHarnessRuns,
  terminalizeQueuedHarnessRun,
  terminalizeHarnessAttempt,
  type AttemptIdentity,
  type AttemptLease,
} from "../runtime/harness-run-runtime";
import { runWorkstreamHarness } from "../services/integrations";
import {
  hyperSightBlockRunFromRow,
  publishHyperSightRun,
  type HyperSightBlockRunRow,
} from "../services/hypersight-service";
import { SlackAgentService } from "../services/slack-agent-service";

const HarnessWorkflowOutcomeSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed", "stopped"]),
  messageId: z.string().uuid().optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
});

const SlackDeliveryRetryConfig = {
  retries: {
    limit: 5,
    delay: ({ error }: { error: Error }) => Math.max(5_000, connectorRetryAfterMs(error) ?? 0),
    backoff: "exponential" as const,
  },
};

type HarnessWorkflowOutcome = z.infer<typeof HarnessWorkflowOutcomeSchema>;

const MAX_QUEUE_POLLS = 240;

function memberSafeFailure(error: unknown): HarnessWorkflowOutcome {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "harness_execution_failed";
  return {
    status: code === "run_cancelled" ? "stopped" : "failed",
    error: {
      code,
      message: code === "run_ownership_lost"
        ? "The run was superseded by another durable executor"
        : code === "run_cancelled"
          ? "The run was cancelled"
          : "The Avalon harness could not complete this run",
    },
  };
}

function terminalSlackText(outcome: HarnessWorkflowOutcome): string {
  if (outcome.status === "stopped") return "Avalon stopped this task.";
  if (outcome.status === "needs_input") return "Avalon needs more information before it can continue this task.";
  if (outcome.status === "failed") return outcome.error?.message ?? "Avalon could not complete this task.";
  return "Avalon completed the task without a text response.";
}

async function updateHyperSightRun(
  env: Env,
  input: WorkstreamWorkflowInput,
  status: HyperSightBlockRunRow["status"],
  error?: { code: string; message: string },
): Promise<void> {
  const at = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE hypersight_block_runs
        SET status = ?,
            started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
            completed_at = CASE WHEN ? IN ('completed', 'failed', 'stopped') THEN COALESCE(completed_at, ?) ELSE completed_at END,
            error_json = CASE WHEN ? IS NULL THEN error_json ELSE ? END
      WHERE harness_run_id = ? AND workspace_id = ? AND workstream_id = ?
        AND status NOT IN ('completed', 'failed', 'stopped')`,
  ).bind(
    status,
    status,
    at,
    status,
    at,
    error ? JSON.stringify(error) : null,
    error ? JSON.stringify(error) : null,
    input.harnessRunId,
    input.workspaceId,
    input.workstreamId,
  ).run();
  const row = await env.DB.prepare(
    `SELECT id, block_id, configuration_version_id, status, markdown, error_json, created_at, started_at, completed_at
       FROM hypersight_block_runs
      WHERE harness_run_id = ? AND workspace_id = ? AND workstream_id = ?`,
  ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<HyperSightBlockRunRow>();
  if (row) await publishHyperSightRun(env, input.workspaceId, input.workstreamId, hyperSightBlockRunFromRow(row));
}

/** Static workflow definition used by every ad-hoc and automated harness run. */
export class WorkstreamLoopWorkflow extends WorkflowEntrypoint<Env, WorkstreamWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<WorkstreamWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<HarnessWorkflowOutcome> {
    const input = WorkstreamWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");
    const hyperSightRun = input.reason === "hypersight_block";

    const identity = await step.do("create-durable-attempt-identity", async (): Promise<AttemptIdentity> => {
      const attemptId = crypto.randomUUID();
      return { attemptId, owner: `workflow:${input.harnessRunId}:${attemptId}` };
    });

    await step.do("reap-expired-workstream-attempts", async () => {
      await reapStaleHarnessRuns(this.env.DB, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        limit: 25,
      });
    });

    let lease: AttemptLease | null = null;
    for (let poll = 0; poll < MAX_QUEUE_POLLS; poll += 1) {
      const claim = await step.do(`claim-harness-run-${poll}`, async () => claimHarnessAttempt(
        this.env.DB,
        input,
        { ...identity, leaseSeconds: 300 },
      ));
      if (claim.state === "terminal") return { status: claim.status };
      if (claim.state === "cancelled") {
        const outcome: HarnessWorkflowOutcome = { status: "stopped" };
        await step.do("terminalize-cancelled-queued-run", async () => {
          await terminalizeQueuedHarnessRun(
            this.env.DB,
            input,
            identity,
            { code: "run_cancelled", message: "The run was stopped before it started" },
            "stopped",
          );
        });
        if (hyperSightRun) {
          await step.do("publish-hypersight-cancelled-before-start", async () => {
            await updateHyperSightRun(this.env, input, "stopped");
          });
          return outcome;
        }
        await step.do("deliver-slack-cancelled-before-start", SlackDeliveryRetryConfig, async () => {
          await this.deliverSlackDurably(input, outcome);
        });
        return outcome;
      }
      if (claim.state === "claimed") {
        lease = claim.lease;
        break;
      }
      await step.sleep(`wait-for-workstream-attempt-${poll}`, "5 seconds");
    }
    if (!lease) {
      const outcome: HarnessWorkflowOutcome = {
        status: "failed",
        error: { code: "run_admission_timeout", message: "The work stream remained busy for too long" },
      };
      await step.do("terminalize-queued-admission-timeout", async () => {
        await terminalizeQueuedHarnessRun(this.env.DB, input, identity, outcome.error!);
      });
      if (hyperSightRun) {
        await step.do("publish-hypersight-admission-timeout", async () => {
          await updateHyperSightRun(this.env, input, "failed", outcome.error);
        });
        return outcome;
      }
      await step.do("deliver-slack-admission-timeout", SlackDeliveryRetryConfig, async () => {
        await this.deliverSlackDurably(input, outcome);
      });
      return outcome;
    }

    if (hyperSightRun) {
      await step.do("publish-hypersight-running", async () => {
        await updateHyperSightRun(this.env, input, "running");
      });
    } else {
      await this.publishBestEffort(input, { type: "harness_status_changed", status: "running" });
    }

    let outcome: HarnessWorkflowOutcome;
    try {
      outcome = await step.do(
        "run-authorized-bind-loop",
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
          timeout: "5 minutes",
        },
        async () => HarnessWorkflowOutcomeSchema.parse(await runWorkstreamHarness(
          this.env,
          input,
          undefined,
          { lease: lease! },
        )),
      );
    } catch (error) {
      outcome = memberSafeFailure(error);
    }

    const stopped = await step.do("recheck-persisted-stop", async () => {
      const row = await this.env.DB.prepare(
        "SELECT status, cancellation_requested_at FROM harness_runs WHERE id = ? AND workspace_id = ? AND workstream_id = ?",
      ).bind(input.harnessRunId, input.workspaceId, input.workstreamId)
        .first<{ status: string; cancellation_requested_at: string | null }>();
      return row?.status === "stopped" || row?.cancellation_requested_at != null;
    });
    const effectiveOutcome: HarnessWorkflowOutcome = stopped ? { ...outcome, status: "stopped" } : outcome;

    await step.do("terminalize-harness-attempt", async () => {
      await terminalizeHarnessAttempt(this.env.DB, input, lease!, {
        status: effectiveOutcome.status,
        ...(effectiveOutcome.messageId ? { finalMessageId: effectiveOutcome.messageId } : {}),
        ...(effectiveOutcome.error ? { error: effectiveOutcome.error } : {}),
        memberSafePayload: effectiveOutcome.error
          ? { code: effectiveOutcome.error.code }
          : {},
      });
      if (!hyperSightRun) await this.finalizeAutomation(input, effectiveOutcome, lease!);
    });

    if (hyperSightRun) {
      await step.do("publish-hypersight-terminal", async () => {
        await updateHyperSightRun(
          this.env,
          input,
          effectiveOutcome.status === "completed"
            ? "completed"
            : effectiveOutcome.status === "stopped" ? "stopped" : "failed",
          effectiveOutcome.error,
        );
      });
      return effectiveOutcome;
    }

    if (effectiveOutcome.messageId) {
      await this.publishPersistedFinalBestEffort(input, effectiveOutcome.messageId);
    }
    await step.do("deliver-slack-terminal-outcome", SlackDeliveryRetryConfig, async () => {
      await this.deliverSlackDurably(input, effectiveOutcome);
    });

    await this.publishBestEffort(input, {
      type: "harness_status_changed",
      status: effectiveOutcome.status === "stopped" ? "idle" : effectiveOutcome.status,
    });
    return effectiveOutcome;
  }

  private async deliverSlackDurably(
    input: WorkstreamWorkflowInput,
    outcome: HarnessWorkflowOutcome,
  ): Promise<void> {
    const messages = outcome.messageId
      ? await createDatabase(this.env.DB).workstreams.listMessages(input.workspaceId, input.workstreamId, 250)
      : [];
    const message = outcome.messageId
      ? messages.find((candidate) => candidate.id === outcome.messageId)
      : undefined;
    const text = message?.textContent ?? terminalSlackText(outcome);
    const deliveryKey = `${input.harnessRunId}:${outcome.status}`;
    const slack = new SlackAgentService(this.env);
    await slack.deliverWorkstreamOutcome(
      input.workspaceId,
      input.workstreamId,
      text,
      deliveryKey,
      outcome.status,
    );
    if (input.automationSubscriptionId) {
      const automation = await this.env.DB.prepare(
        `SELECT t.name FROM automation_subscriptions s
         JOIN automation_templates t ON t.id = s.template_id
         WHERE s.id = ? AND s.workspace_id = ?`,
      ).bind(input.automationSubscriptionId, input.workspaceId).first<{ name: string }>();
      await slack.deliverAutomationResult({
        workspaceId: input.workspaceId,
        automationSubscriptionId: input.automationSubscriptionId,
        workstreamId: input.workstreamId,
        title: automation?.name ?? "Avalon automation result",
        text,
        outcomeStatus: outcome.status,
      });
    }
  }

  private async publishPersistedFinalBestEffort(
    input: WorkstreamWorkflowInput,
    messageId: string,
  ): Promise<void> {
    try {
      const messages = await createDatabase(this.env.DB).workstreams.listMessages(
        input.workspaceId,
        input.workstreamId,
        250,
      );
      const message = messages.find((candidate) => candidate.id === messageId);
      if (message) await this.publishBestEffort(input, { type: "stream_completed", message });
    } catch {
      // The persisted message and terminal lifecycle remain authoritative.
      // A reconnect fetches both through the canonical REST snapshot.
    }
  }

  private async finalizeAutomation(
    input: WorkstreamWorkflowInput,
    outcome: HarnessWorkflowOutcome,
    lease: AttemptLease,
  ): Promise<void> {
    if (!input.automationSubscriptionId) return;
    const now = new Date().toISOString();
    const automationStatus = outcome.status === "stopped" ? "failed" : outcome.status;
    await this.env.DB.prepare(
      `UPDATE automation_runs
          SET status = ?1,
              completed_at = CASE WHEN ?1 IN ('completed', 'failed') THEN ?2 ELSE completed_at END,
              result_summary = COALESCE(result_summary, ?3)
        WHERE workstream_id = ?4
          AND automation_subscription_id = ?5
          AND workspace_id = ?6
          AND EXISTS (
            SELECT 1 FROM harness_runs
             WHERE id = ?7 AND attempt_id = ?8 AND terminalized_at IS NOT NULL
          )`,
    ).bind(
      automationStatus,
      now,
      outcome.error?.message.slice(0, 500) ?? null,
      input.workstreamId,
      input.automationSubscriptionId,
      input.workspaceId,
      input.harnessRunId,
      lease.attemptId,
    ).run();
  }

  private async publishBestEffort(input: WorkstreamWorkflowInput, event: unknown): Promise<void> {
    try {
      const rooms = durableObjectNamespaceForRegion(
        this.env.WORKSTREAM_ROOMS,
        input.region,
        this.env.APP_ENV,
      );
      const id = rooms.idFromName(
        workstreamRoomName(input.region, input.workspaceId, input.workstreamId),
      );
      await rooms.get(id).fetch("https://workstream-room/internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
      });
    } catch {
      // Realtime display is best-effort. D1 terminal state and lifecycle events
      // remain authoritative and clients recover through snapshot/resync.
    }
  }
}
