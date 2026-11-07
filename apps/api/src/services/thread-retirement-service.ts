import {
  asSubstreamId,
  asWorkspaceId,
  type WorkspaceId,
} from "@rally/contracts";
import type {
  DumpThreadTranscriptsResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";

/**
 * Retiring an Organization's Threads, Breakouts and Channels after the
 * cutover to Canvases and Sidekicks, while the Organization itself stays open.
 *
 * Two operator operations, each one Organization at a time and each
 * resumable by asking again:
 *
 * 1. **The dump.** Every conversation under a Thread or a Channel is written to
 *    R2 as room-visible text, the only copy once the second step runs. The R2
 *    object is the receipt: a pass skips a key that is already there.
 * 2. **The retirement**, refused until every conversation it would retire has
 *    its dump (see below).
 *
 * Canvases and Sidekicks are other parents in other tables, and nothing here
 * names them. `docs/workspace-retirement.md` owns the walk this reuses; the
 * product decision is in `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`
 * ("Existing Threads, Breakouts and Channels are deleted", "Transcripts are
 * dumped to R2 before Threads are retired").
 */

/** Where one conversation's transcript lands: the plan's key, one object per conversation. */
export function retiredConversationKey(workspaceId: string, parentId: string, substreamId: string): string {
  return `retired-conversations/${workspaceId}/${parentId}/${substreamId}.txt`;
}

async function organizationObject(env: Env, workspaceId: WorkspaceId) {
  return durableObjectStubForWorkspace(
    env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId),
  );
}

async function conversationObject(env: Env, workspaceId: WorkspaceId, parentId: string, substreamId: string) {
  return durableObjectStubForWorkspace(
    env, env.SUBSTREAM_AGENTS, workspaceId,
    conversationObjectName(env.AVALON_REGION, workspaceId, parentId, asSubstreamId(substreamId)),
  );
}

/** Every conversation the walk would visit, Threads before Channels. */
export async function threadRetirementInventory(env: Env, workspaceId: WorkspaceId) {
  return (await (await organizationObject(env, workspaceId)).threadRetirementInventory()).parents;
}

/**
 * Write each conversation's transcript to `PAYLOADS` under
 * `retiredConversationKey`, skipping any key already written.
 *
 * Reads go to the conversation's own object, which formats with
 * `conversationAsText`, the formatter the operator `read_thread` tool uses. An
 * object that holds a different identity than the name it was reached by, or
 * a conversation of another parent kind, is refused by code and left
 * unwritten, so the retirement that follows stays refused until an operator
 * looks.
 */
export async function dumpThreadTranscripts(
  env: Env,
  input: { workspaceId: string; operationId: string; operatorSubject: string },
): Promise<DumpThreadTranscriptsResult> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const parents = await threadRetirementInventory(env, workspaceId);
  const result: DumpThreadTranscriptsResult = {
    region: env.AVALON_REGION, orgId: workspaceId, conversations: 0, dumped: 0, skipped: 0, failed: [],
  };
  for (const parent of parents) {
    for (const substreamId of parent.substreamIds) {
      result.conversations += 1;
      const key = retiredConversationKey(workspaceId, parent.parentId, substreamId);
      try {
        if (await env.PAYLOADS.head(key)) {
          result.skipped += 1;
          continue;
        }
        const conversation = await conversationObject(env, workspaceId, parent.parentId, substreamId);
        const transcript = await conversation.conversationTranscriptText();
        const identity = transcript.identity;
        if (identity && (identity.workspaceId !== workspaceId || identity.parentId !== parent.parentId
          || identity.substreamId !== substreamId)) {
          throw new Error("thread_transcript_identity_mismatch");
        }
        if (identity && identity.parentKind !== parent.parentKind) {
          throw new Error("thread_transcript_parent_kind_refused");
        }
        await env.PAYLOADS.put(key, transcript.text, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: {
            parentKind: parent.parentKind,
            // An object that never held a conversation is written empty, so
            // the retirement's coverage check finds a receipt for it too.
            materialized: identity ? "true" : "false",
            throughSequence: String(transcript.throughSequence),
            operationId: input.operationId,
            dumpedAt: new Date().toISOString(),
          },
        });
        result.dumped += 1;
      } catch (error) {
        const reason = diagnosticErrorCode(error, "thread_transcript_dump_failed");
        result.failed.push({ parentKind: parent.parentKind, parentId: parent.parentId, substreamId, error: reason });
        logWarn(env, "thread_transcript_dump_failed", {
          workspace_id: workspaceId, operation_id: input.operationId, parent_kind: parent.parentKind,
          parent_id: parent.parentId, substream_id: substreamId, reason,
        });
      }
    }
  }
  logInfo(env, "thread_transcript_dump_pass", {
    workspace_id: workspaceId, operation_id: input.operationId, operator_subject: input.operatorSubject,
    conversations: result.conversations, dumped: result.dumped, skipped: result.skipped, failed: result.failed.length,
  });
  return result;
}
