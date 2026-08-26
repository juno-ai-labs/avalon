import {
  ApplyWorkstreamBatchRequestSchema,
  WorkstreamBatchAcceptedSchema,
  WorkstreamBatchFilterSchema,
  WorkstreamBatchUpdateSchema,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
  type ApplyWorkstreamBatchRequest,
  type WorkstreamBatchFilter,
} from "@rally/contracts";
import { z } from "zod";

import { substreamAgentName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { logInfo } from "../observability/logger";

/** Cloudflare Queues accepts at most 100 messages in one sendBatch call. */
const QUEUE_SEND_BATCH_SIZE = 100;

export const WorkstreamBatchUpdateQueueMessageSchema = z.object({
  kind: z.literal("workstream_batch_update"),
  region: z.enum(["global", "eu"]),
  operationId: z.string().uuid(),
  requestHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  userId: z.string().uuid(),
  update: WorkstreamBatchUpdateSchema,
}).strict();

export type WorkstreamBatchUpdateQueueMessage = z.infer<
  typeof WorkstreamBatchUpdateQueueMessageSchema
>;

const QueuedWorkstreamBatchUpdateResultSchema = z.object({
  outcome: z.enum(["applied", "replayed", "skipped"]),
  reason: z.string().min(1).max(160).nullable(),
}).strict();

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * Generic filtered batch mutation coordinator.
 *
 * WorkspaceDO resolves the filter in one cross-work-stream query. The Worker
 * then sends one event per target in transport-sized batches; it never reads or
 * calls each child on the request path.
 */
export class WorkstreamBatchUpdateService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async preview(filter: WorkstreamBatchFilter): Promise<{ matchedCount: number }> {
    const parsed = WorkstreamBatchFilterSchema.parse(filter);
    const items = await new WorkstreamDirectoryService(this.env, this.auth).batchTargets(parsed);
    return { matchedCount: items.length };
  }

  async enqueue(rawRequest: ApplyWorkstreamBatchRequest) {
    const request = ApplyWorkstreamBatchRequestSchema.parse(rawRequest);
    const workstreamIds = await new WorkstreamDirectoryService(this.env, this.auth)
      .batchTargets(request.filter);
    const requestHash = workstreamImportHash({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      filter: request.filter,
      update: request.update,
    });
    const events = workstreamIds.map((workstreamId) => ({
      body: WorkstreamBatchUpdateQueueMessageSchema.parse({
        kind: "workstream_batch_update",
        region: this.env.AVALON_REGION,
        operationId: request.operationId,
        requestHash,
        workspaceId: this.auth.workspaceId,
        workstreamId,
        userId: this.auth.userId,
        update: request.update,
      }),
      contentType: "json" as const,
    }));

    await Promise.all(chunks(events, QUEUE_SEND_BATCH_SIZE).map((batch) =>
      this.env.ACTIVITY_QUEUE.sendBatch(batch)));

    logInfo(this.env, "workstream_batch_update_enqueued", {
      workspace_id: this.auth.workspaceId,
      operation_id: request.operationId,
      update_kind: request.update.kind,
      workstream_count: workstreamIds.length,
      queue_batch_count: Math.ceil(events.length / QUEUE_SEND_BATCH_SIZE),
    });
    return WorkstreamBatchAcceptedSchema.parse({
      operationId: request.operationId,
      enqueuedCount: workstreamIds.length,
    });
  }
}

/** Apply one queued event to its one authoritative work-stream object. */
export async function consumeWorkstreamBatchUpdate(
  message: Message<unknown>,
  env: Env,
): Promise<boolean> {
  const parsed = WorkstreamBatchUpdateQueueMessageSchema.safeParse(message.body);
  if (!parsed.success) return false;
  const event = parsed.data;
  if (event.region !== env.AVALON_REGION) {
    message.ack();
    return true;
  }
  const workspaceId = asWorkspaceId(event.workspaceId);
  const workstreamId = asWorkstreamId(event.workstreamId);
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    substreamAgentName(env.AVALON_REGION, workspaceId, workstreamId, asSubstreamId("0")),
  );
  const result = QueuedWorkstreamBatchUpdateResultSchema.parse(
    await stub.applyQueuedBatchUpdate(event),
  );
  logInfo(env, "workstream_batch_update_applied", {
    workspace_id: event.workspaceId,
    workstream_id: event.workstreamId,
    operation_id: event.operationId,
    update_kind: event.update.kind,
    outcome: result.outcome,
    reason: result.reason,
    queue_attempts: message.attempts,
  });
  message.ack();
  return true;
}
