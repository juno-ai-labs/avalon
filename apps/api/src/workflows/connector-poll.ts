import {
  ActivityQueueMessageSchema,
  ConnectorPollWorkflowInputSchema,
  IdSchema,
  type ConnectorPollWorkflowInput
} from "@avalon/contracts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import {
  advanceOwningPollTarget,
  commitConnectorCursor,
  pollConnectorConnection,
  type ConnectorCursorCommit,
} from "../services/integrations";

const PollResultSchema = z.object({
  activityIds: z.array(IdSchema).max(5_000),
  cursor: z.record(z.string(), z.unknown()),
  baseCursorJson: z.string().min(2).max(1_000_000),
  nextPollAt: z.string().datetime({ offset: true }).nullable().optional()
});

interface StoredPollResult {
  activityIds: string[];
  cursorJson: string;
  baseCursorJson: string;
  nextPollAt: string | null;
}

/** Static, retryable poll workflow shared by all connector connections. */
export class ConnectorPollWorkflow extends WorkflowEntrypoint<Env, ConnectorPollWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<ConnectorPollWorkflowInput>>,
    step: WorkflowStep
  ): Promise<{ activityCount: number }> {
    const input = ConnectorPollWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");

    await step.do("load-connector-poll-state", async (): Promise<string> => {
      const connection = await this.env.DB.prepare(
        `SELECT c.id, c.cursor_json
           FROM connector_connections c
          WHERE c.id = ?2
            AND c.workspace_id = ?3
            AND c.status = 'healthy'
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
        .first<{ id: string; cursor_json: string }>();
      if (!connection) throw new Error("connector_poll_not_authorized");
      return connection.id;
    });

    const result = await step.do("poll-and-persist-provider-page", async (): Promise<StoredPollResult> => {
      const parsed = PollResultSchema.parse(await pollConnectorConnection(this.env, input));
      return {
        activityIds: parsed.activityIds,
        cursorJson: JSON.stringify(parsed.cursor),
        baseCursorJson: parsed.baseCursorJson,
        nextPollAt: parsed.nextPollAt ? new Date(parsed.nextPollAt).toISOString() : null
      };
    });

    await step.do("enqueue-normalized-activities", async () => {
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
      return commitConnectorCursor(this.env.DB, input, result, now);
    });

    if (result.nextPollAt && cursorCommit !== "superseded") {
      await step.do("advance-owning-poll-target", async (): Promise<boolean> =>
        advanceOwningPollTarget(
          this.env.DB,
          input,
          result.nextPollAt!,
          new Date().toISOString(),
        )
      );
      // Refresh even when the target already held this value: the previous
      // attempt may have committed D1 but lost its response before re-arming
      // the workspace alarm.
      await step.do("refresh-workspace-scheduler", async () => {
        const schedulers = durableObjectNamespaceForRegion(this.env.WORKSPACE_SCHEDULERS, input.region, this.env.APP_ENV);
        const schedulerId = schedulers.idFromName(
          `${input.region}:${input.workspaceId}`
        );
        const response = await schedulers.get(schedulerId).fetch(
          "https://scheduler.internal/refresh",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: input.workspaceId })
          }
        );
        if (!response.ok) throw new Error("connector_scheduler_refresh_failed");
      });
    }

    return { activityCount: result.activityIds.length };
  }
}
