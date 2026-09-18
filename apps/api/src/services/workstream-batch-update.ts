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
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

import { conversationObjectName } from "../durable-objects/names";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import type { AuthContext, Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import { WorkstreamDirectoryService } from "./workstream-directory-service";

/**
 * Cloudflare accepts at most 100 messages per Queue call. The product owner
 * selected 50 during the 2026-08-31 incident follow-up; no further load-derived
 * rationale was recorded. Keep this at or below the platform maximum.
 */
const QUEUE_SEND_BATCH_SIZE = 50;

export const WorkstreamBatchUpdateQueueMessageSchema = z.strictObject({
  kind: z.literal("workstream_batch_update"),
  region: RegionSchema,
  operationId: z.string().uuid(),
  requestHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  userId: z.string().uuid(),
  update: WorkstreamBatchUpdateSchema,
});

export type WorkstreamBatchUpdateQueueMessage = z.infer<
  typeof WorkstreamBatchUpdateQueueMessageSchema
>;

const QueuedWorkstreamBatchUpdateResultSchema = z.strictObject({
  outcome: z.enum(["applied", "replayed", "skipped"]),
  reason: z.string().min(1).max(160).nullable(),
});

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
 * WorkspaceDO resolves the filter in one query. The Worker then sends one event
 * per work stream in transport-sized batches; it never reads or calls each
 * child on the request path.
 *
 * Notes take the other route on purpose. A work stream is its own authority, so
 * reaching it means an event; a note is a row in the workspace object this
 * request has already reached, so `archive` finishes them there in one
 * transaction and reports the count rather than enqueueing anything. Giving
 * notes a Queue trip would buy nothing but a second way for the two halves of
 * one grouping to disagree about whether they happened.
 */
export class WorkstreamBatchUpdateService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async preview(
    filter: WorkstreamBatchFilter,
  ): Promise<{ matchedCount: number; matchedNoteCount: number }> {
    const parsed = WorkstreamBatchFilterSchema.parse(filter);
    const targets = await new WorkstreamDirectoryService(this.env, this.auth).batchTargets(parsed);
    return { matchedCount: targets.items.length, matchedNoteCount: targets.noteIds.length };
  }

  async enqueue(rawRequest: ApplyWorkstreamBatchRequest) {
    const request = ApplyWorkstreamBatchRequestSchema.parse(rawRequest);
    const requestHash = workstreamImportHash({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      filter: request.filter,
      update: request.update,
    });
    const directory = new WorkstreamDirectoryService(this.env, this.auth);
    const dispatch = await directory.beginBatchDispatch({
      operationId: request.operationId,
      requestHash,
      filter: request.filter,
      update: request.update,
    });
    const workstreamIds = dispatch.items;
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

    const published = await Promise.allSettled(
      chunks(events, QUEUE_SEND_BATCH_SIZE).map(async (batch) => {
        await this.env.ACTIVITY_QUEUE.sendBatch(batch);
        await directory.advanceBatchDispatch({
          operationId: request.operationId,
          requestHash,
          workstreamIds: batch.map((message) => message.body.workstreamId),
        });
      }),
    );
    const failed = published.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed.length > 0) {
      logWarn(this.env, "workstream_batch_update_dispatch_failed", {
        workspace_id: this.auth.workspaceId,
        operation_id: request.operationId,
        update_kind: request.update.kind,
        queue_batch_count: published.length,
        failed_batch_count: failed.length,
        reason: failed[0]?.reason instanceof Error ? failed[0].reason.message : "unknown",
      });
      throw failed[0]?.reason;
    }

    // After the Queue publication, not before. Everything above can still fail
    // and be retried, and a caller that sees this request fail has to be able
    // to read that as "nothing happened": archiving first meant a failed chunk
    // send threw with the notes already gone, so the client showed a retryable
    // error while the reader's notes had in fact been archived, and the caches
    // and open routes that follow an archive were never told. The receipt makes
    // the retry idempotent either way; only this order makes the *failure*
    // honest.
    //
    // The residual window is one RPC wide and points the safe way: if this
    // throws, the work streams are enqueued and the notes are not, and the
    // retry finishes them.
    const archivedNoteCount = 0;

    logInfo(this.env, "workstream_batch_update_enqueued", {
      workspace_id: this.auth.workspaceId,
      operation_id: request.operationId,
      update_kind: request.update.kind,
      workstream_count: dispatch.targetCount,
      note_count: archivedNoteCount,
      queue_batch_count: Math.ceil(events.length / QUEUE_SEND_BATCH_SIZE),
    });
    return WorkstreamBatchAcceptedSchema.parse({
      operationId: request.operationId,
      enqueuedCount: dispatch.targetCount,
      archivedNoteCount,
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
    conversationObjectName(env.AVALON_REGION, workspaceId, workstreamId, asSubstreamId("0")),
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
