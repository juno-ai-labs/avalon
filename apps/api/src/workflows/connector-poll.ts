import {
  ActivityQueueMessageSchema,
  ConnectorPollWorkflowInputSchema,
  IdSchema,
  type ConnectorPollWorkflowInput
} from "@rally/contracts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import {
  advanceOwningPollTarget,
  commitConnectorCursor,
  pollConnectorConnection,
  type ConnectorCursorCommit,
} from "../services/integrations";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { refreshWorkspaceSchedule } from "../services/workstream-wakeup-service";

const PollResultSchema = z.object({
  activityIds: z.array(IdSchema).max(5_000),
  cursor: z.record(z.string(), z.unknown()),
  baseCursorJson: z.string().min(2).max(1_000_000),
  nextPollAt: z.string().datetime({ offset: true }).nullable().optional(),
  streamErrors: z.array(z.object({
    streamId: z.string().min(1).max(200),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
  })).max(100).optional(),
});

interface StoredPollResult {
  activityIds: string[];
  cursorJson: string;
  baseCursorJson: string;
  nextPollAt: string | null;
  streamErrors?: Array<{ streamId: string; code: string; message: string }>;
}

/** Static, retryable poll workflow shared by all connector connections. */
export class ConnectorPollWorkflow extends WorkflowEntrypoint<Env, ConnectorPollWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<ConnectorPollWorkflowInput>>,
    step: WorkflowStep
  ): Promise<{ activityCount: number }> {
    const input = ConnectorPollWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");
    const workspaceEnv = withWorkspaceRuntimeDatabase(this.env, input.workspaceId);

    const connection = await step.do("load-connector-poll-state", async (): Promise<{ id: string; provider: string }> => {
      const connection = await workspaceEnv.DB.prepare(
        `SELECT c.id, c.connector_type, c.cursor_json
           FROM connector_connections c
          WHERE c.id = ?2
            AND c.workspace_id = ?3
            AND c.status <> 'disabled'
            AND (
              EXISTS (
                SELECT 1 FROM schedules s
                 WHERE s.id = ?1 AND s.workspace_id = c.workspace_id
                   AND s.connector_connection_id = c.id AND s.enabled = 1
              )
              OR EXISTS (
                SELECT 1 FROM resource_watches rw
                 WHERE rw.id = ?1 AND rw.workspace_id = c.workspace_id
                   AND rw.connection_id = c.id AND rw.enabled = 1
              )
            )
          LIMIT 1`
      )
        .bind(input.pollScheduleId, input.connectionId, input.workspaceId)
        .first<{ id: string; connector_type: string; cursor_json: string }>();
      if (!connection) throw new Error("connector_poll_not_authorized");
      return { id: connection.id, provider: connection.connector_type };
    });

    let result: StoredPollResult;
    try {
      result = await step.do(
        "poll-and-persist-provider-page",
        {
          retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
          timeout: "25 seconds",
        },
        async (context): Promise<StoredPollResult> => {
          const startedAt = Date.now();
          logStructuredEvent(this.env, "info", "connector_poll_attempt", {
            workspace_id: input.workspaceId,
            connection_id: input.connectionId,
            provider: connection.provider,
            poll_schedule_id: input.pollScheduleId,
            workflow_step: "poll-and-persist-provider-page",
            attempt: context.attempt,
          });
          const parsed = PollResultSchema.parse(await pollConnectorConnection(workspaceEnv, input));
          logStructuredEvent(this.env, "info", "connector_poll_attempt_completed", {
            workspace_id: input.workspaceId,
            connection_id: input.connectionId,
            provider: connection.provider,
            poll_schedule_id: input.pollScheduleId,
            workflow_step: "poll-and-persist-provider-page",
            attempt: context.attempt,
            duration_ms: Date.now() - startedAt,
            activity_count: parsed.activityIds.length,
          });
          return {
            activityIds: parsed.activityIds,
            cursorJson: JSON.stringify(parsed.cursor),
            baseCursorJson: parsed.baseCursorJson,
            nextPollAt: parsed.nextPollAt ? new Date(parsed.nextPollAt).toISOString() : null,
            ...(parsed.streamErrors?.length ? { streamErrors: parsed.streamErrors } : {}),
          };
        },
      );
    } catch (error) {
      const at = new Date().toISOString();
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      const code = timedOut ? "connector_poll_timeout" : "connector_poll_failed";
      const message = timedOut ? "Connector poll timed out" : "Connector poll failed after retries";
      await workspaceEnv.DB.prepare(
        `UPDATE connector_connections
         SET status = 'error', error_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(JSON.stringify({ code, message }), at, input.connectionId, input.workspaceId).run();
      logStructuredEvent(this.env, "error", code, {
        workspace_id: input.workspaceId,
        connection_id: input.connectionId,
        provider: connection.provider,
        poll_schedule_id: input.pollScheduleId,
        workflow_step: "poll-and-persist-provider-page",
        error_name: error instanceof Error ? error.name : "Error",
        terminal_outcome: timedOut ? "degraded_timeout" : "degraded_error",
      });
      throw error;
    }

    await step.do("enqueue-normalized-activities", async () => {
      // WorkspaceDO cutover enqueues each normalized event from the provider
      // persistence step itself, so no D1 activity-body handoff exists to read
      // here. Legacy deployments retain the separate ID-only queue step.
      if (this.env.WORKSPACE_DOS) return;
      for (let offset = 0; offset < result.activityIds.length; offset += 100) {
        const chunk = result.activityIds.slice(offset, offset + 100);
        await this.env.ACTIVITY_QUEUE.sendBatch(
          chunk.map((activityId) => ({
            body: ActivityQueueMessageSchema.parse({
              region: input.region,
              workspaceId: input.workspaceId,
              activityId,
              attempt: 0
            }),
            contentType: "json" as const
          }))
        );
      }
    });

    const cursorCommit = await step.do("commit-connector-cursor", async (): Promise<ConnectorCursorCommit> => {
      const now = new Date().toISOString();
      return commitConnectorCursor(workspaceEnv.DB, input, result, now);
    });

    if (result.nextPollAt && cursorCommit !== "superseded") {
      await step.do("advance-owning-poll-target", async (): Promise<boolean> =>
        advanceOwningPollTarget(
          workspaceEnv.DB,
          input,
          result.nextPollAt!,
          new Date().toISOString(),
        )
      );
      // Refresh even when the target already held this value: the previous
      // attempt may have committed D1 but lost its response before re-arming
      // the workspace alarm.
      // The step name is durable Workflow history: renaming it would orphan
      // every in-flight run's checkpoint, so it keeps the retired object's name.
      await step.do("refresh-workspace-scheduler", async () => {
        await refreshWorkspaceSchedule(this.env, input.workspaceId);
      });
    }

    return { activityCount: result.activityIds.length };
  }
}
