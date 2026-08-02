import { WorkstreamWorkflowInputSchema, type WorkstreamWorkflowInput } from "@avalon/contracts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import { workstreamRoomName } from "../durable-objects/workstream-room";
import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { runWorkstreamHarness } from "../services/integrations";

const HarnessWorkflowOutcomeSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed", "stopped"]),
  messageId: z.string().uuid().optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional()
});

type HarnessWorkflowOutcome = z.infer<typeof HarnessWorkflowOutcomeSchema>;

interface ClaimResult {
  claimed: boolean;
  terminalStatus: HarnessWorkflowOutcome["status"] | null;
}

/** Static workflow definition used by every ad-hoc and automated harness run. */
export class WorkstreamLoopWorkflow extends WorkflowEntrypoint<Env, WorkstreamWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<WorkstreamWorkflowInput>>,
    step: WorkflowStep
  ): Promise<HarnessWorkflowOutcome> {
    const input = WorkstreamWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");

    const claim = await step.do("claim-harness-run", async (): Promise<ClaimResult> => {
      const canonical = await this.env.DB.prepare(
        `SELECT hr.status AS harness_status
           FROM harness_runs hr
           JOIN workstreams w ON w.id = hr.workstream_id
          WHERE hr.id = ?1
            AND hr.workspace_id = ?2
            AND hr.workstream_id = ?3
            AND w.workspace_id = ?2
          LIMIT 1`
      )
        .bind(input.harnessRunId, input.workspaceId, input.workstreamId)
        .first<{ harness_status: string }>();
      if (!canonical) throw new Error("harness_run_not_found");

      if (["completed", "needs_input", "failed", "stopped"].includes(canonical.harness_status)) {
        return {
          claimed: false,
          terminalStatus: canonical.harness_status as HarnessWorkflowOutcome["status"]
        };
      }

      const now = new Date().toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE harness_runs
              SET status = 'running', started_at = COALESCE(started_at, ?1)
            WHERE id = ?2 AND workspace_id = ?3 AND workstream_id = ?4`
        ).bind(now, input.harnessRunId, input.workspaceId, input.workstreamId),
        this.env.DB.prepare(
          `UPDATE workstreams
              SET harness_status = 'running', updated_at = ?1
            WHERE id = ?2 AND workspace_id = ?3`
        ).bind(now, input.workstreamId, input.workspaceId)
      ]);

      await this.publish(input, { type: "harness_status_changed", status: "running" });
      return { claimed: true, terminalStatus: null };
    });

    if (!claim.claimed && claim.terminalStatus) {
      return { status: claim.terminalStatus };
    }

    const outcome = await step.do("run-authorized-harness-loop", async () => {
      const result = await runWorkstreamHarness(this.env, input);
      return HarnessWorkflowOutcomeSchema.parse(result);
    });

    const stopped = await step.do("recheck-persisted-stop", async () => {
      const row = await this.env.DB.prepare(
        "SELECT status FROM harness_runs WHERE id = ? AND workspace_id = ? AND workstream_id = ?"
      ).bind(input.harnessRunId, input.workspaceId, input.workstreamId).first<{ status: string }>();
      return row?.status === "stopped";
    });
    const effectiveOutcome: HarnessWorkflowOutcome = stopped ? { status: "stopped" } : outcome;

    await step.do("finalize-harness-run", async () => {
      await this.finalize(input, effectiveOutcome);
    });

    return effectiveOutcome;
  }

  private async finalize(
    input: WorkstreamWorkflowInput,
    outcome: HarnessWorkflowOutcome
  ): Promise<void> {
    const now = new Date().toISOString();
    const workstreamStatus = outcome.status === "stopped" ? "idle" : outcome.status;
    const errorJson = outcome.error
      ? JSON.stringify({
          code: outcome.error.code,
          message: outcome.error.message.slice(0, 500)
        })
      : null;

    const statements = [
      this.env.DB.prepare(
        `UPDATE harness_runs
            SET status = ?1, completed_at = ?2, error_json = ?3
          WHERE id = ?4 AND workspace_id = ?5 AND workstream_id = ?6
            AND status != 'stopped'`
      ).bind(outcome.status, now, errorJson, input.harnessRunId, input.workspaceId, input.workstreamId),
      this.env.DB.prepare(
        `UPDATE workstreams
            SET harness_status = ?1, last_activity_at = ?2, updated_at = ?2
          WHERE id = ?3 AND workspace_id = ?4
            AND NOT EXISTS (
              SELECT 1 FROM harness_runs WHERE id = ?5 AND status = 'stopped'
            )`
      ).bind(workstreamStatus, now, input.workstreamId, input.workspaceId, input.harnessRunId)
    ];

    if (input.automationSubscriptionId) {
      const automationStatus = outcome.status === "stopped" ? "failed" : outcome.status;
      statements.push(
        this.env.DB.prepare(
          `UPDATE automation_runs
              SET status = ?1,
                  completed_at = CASE WHEN ?1 IN ('completed', 'failed') THEN ?2 ELSE completed_at END,
                  result_summary = COALESCE(result_summary, ?3)
            WHERE workstream_id = ?4
              AND automation_subscription_id = ?5
              AND workspace_id = ?6
              AND NOT EXISTS (
                SELECT 1 FROM harness_runs WHERE id = ?7 AND status = 'stopped'
              )`
        ).bind(
          automationStatus,
          now,
          outcome.error?.message.slice(0, 500) ?? null,
          input.workstreamId,
          input.automationSubscriptionId,
          input.workspaceId,
          input.harnessRunId
        )
      );
    }

    await this.env.DB.batch(statements);
    await this.publish(input, {
      type: "harness_status_changed",
      status: workstreamStatus
    });
  }

  private async publish(input: WorkstreamWorkflowInput, event: unknown): Promise<void> {
    const rooms = durableObjectNamespaceForRegion(this.env.WORKSTREAM_ROOMS, input.region, this.env.APP_ENV);
    const id = rooms.idFromName(
      workstreamRoomName(input.region, input.workspaceId, input.workstreamId)
    );
    const response = await rooms.get(id).fetch(
      "https://workstream-room/internal/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event })
      }
    );
    if (!response.ok) {
      throw new Error(`workstream_event_rejected:${response.status}`);
    }
  }
}
