import { asWorkspaceId, type WorkspaceId } from "@rally/contracts";
import type { ConvertThreadsToCanvasesResult } from "@rally/contracts/engineering-inspection";
import { truncateUtf16Safe } from "@rally/contracts/text";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { UNTITLED_CANVAS } from "./canvas-service";
import { conversationObject, retiredConversationKey } from "./thread-retirement-service";

/**
 * Converting an Organization's Threads that have artifacts into Canvases, in
 * place: the Canvas keeps the Thread's id, so the Thread's Main becomes the
 * Canvas's Chat and every row keyed by the id (`artifact_registry`, search,
 * the D1 anchor and route) already names the Canvas. The rest of the Thread's
 * Breakouts are retired as `retire_threads` retires them. The product
 * decision is the user's, of 2026-11-08; `docs/workspace-retirement.md`
 * owns the mechanism.
 *
 * Refused, as the retirement is, until `dump_thread_transcripts` has written
 * every conversation under each Thread it would convert. Per Thread, in an
 * order a crash resumes from:
 *
 * 1. the Canvas's rows (`WorkspaceDO.convertThreadToCanvas`; an existing
 *    Canvas row is the resume marker),
 * 2. the Main's stored parent kind, `workstream` to `canvas`
 *    (`AgentLoopDO.convertParentKind`; already `canvas` is success),
 * 3. each Breakout's object retired (`retireObject`),
 * 4. the Thread's rows deleted (`WorkspaceDO.deleteRetiredThreadParent`).
 *
 * A Thread whose rows are gone is no longer a candidate, so a finished
 * Organization reruns as a pass over nothing.
 */
export async function convertThreadsToCanvases(
  env: Env,
  input: { workspaceId: string; dryRun: boolean; operationId: string; operatorSubject: string },
): Promise<ConvertThreadsToCanvasesResult> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await organizationObject(env, workspaceId);
  const inventory = await workspace.threadConversionInventory();
  const candidates = await Promise.all(inventory.candidates.map(async (candidate) => {
    const dumped = await Promise.all(candidate.substreamIds.map(async (substreamId) =>
      await env.PAYLOADS.head(retiredConversationKey(workspaceId, candidate.threadId, substreamId)) !== null));
    return { ...candidate, undumped: dumped.filter((present) => !present).length };
  }));
  const result: ConvertThreadsToCanvasesResult = {
    region: env.AVALON_REGION, orgId: workspaceId, dryRun: input.dryRun,
    candidates: candidates.map((candidate) => ({
      threadId: candidate.threadId, title: candidate.title, artifactCount: candidate.artifactCount,
      linkedArtifactCount: candidate.linkedArtifactCount, participantCount: candidate.participantCount,
      conversations: candidate.substreamIds.length, undumped: candidate.undumped,
    })),
    converted: 0, alreadyConverted: 0, failed: [], artifactsWithoutThread: inventory.artifactsWithoutThread,
  };
  if (input.dryRun) return result;
  const undumped = candidates.reduce((total, candidate) => total + candidate.undumped, 0);
  if (undumped > 0) {
    logWarn(env, "thread_retirement_dump_incomplete", {
      workspace_id: workspaceId, operation_id: input.operationId, undumped,
    });
    throw new ApiError(409, "thread_retirement_dump_incomplete",
      `${undumped} conversations have no transcript dump; run dump_thread_transcripts until nothing fails`);
  }
  const tombstone = { retiredAt: Date.now(), operationId: input.operationId, actorUserId: null, reason: "thread_conversion" };
  for (const candidate of candidates) {
    let substreamId: string | null = null;
    try {
      const { created } = await workspace.convertThreadToCanvas({
        workspaceId, threadId: candidate.threadId,
        title: truncateUtf16Safe(candidate.title.trim(), 300) || UNTITLED_CANVAS,
      });
      substreamId = "0";
      await (await conversationObject(env, workspaceId, candidate.threadId, "0")).convertParentKind({
        workspaceId, parentId: candidate.threadId, from: "workstream", to: "canvas",
      });
      for (const breakout of candidate.substreamIds.filter((id) => id !== "0")) {
        substreamId = breakout;
        await (await conversationObject(env, workspaceId, candidate.threadId, breakout)).retireObject(tombstone);
      }
      substreamId = null;
      await workspace.deleteRetiredThreadParent({ parentKind: "workstream", parentId: candidate.threadId });
      if (created) result.converted += 1;
      else result.alreadyConverted += 1;
    } catch (error) {
      const reason = diagnosticErrorCode(error, "thread_conversion_failed");
      result.failed.push({ threadId: candidate.threadId, substreamId, error: reason });
      logWarn(env, "thread_conversion_failed", {
        workspace_id: workspaceId, operation_id: input.operationId, thread_id: candidate.threadId,
        substream_id: substreamId, reason,
      });
    }
  }
  // Read again: an artifact a converted Thread only linked is a Canvas's now.
  result.artifactsWithoutThread = (await workspace.threadConversionInventory()).artifactsWithoutThread;
  logInfo(env, "thread_conversion_pass", {
    workspace_id: workspaceId, operation_id: input.operationId, operator_subject: input.operatorSubject,
    candidates: result.candidates.length, converted: result.converted, already_converted: result.alreadyConverted,
    failed: result.failed.length, artifacts_without_thread: result.artifactsWithoutThread,
  });
  return result;
}

async function organizationObject(env: Env, workspaceId: WorkspaceId) {
  return durableObjectStubForWorkspace(
    env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId),
  );
}
