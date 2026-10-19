import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import { renderMemoryDigest } from "@rally/agent-harness";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { PERSONAL_SYSTEM_PROMPT_REASONS } from "../durable-objects/personal-system-prompt";
import {
  WorkspaceMemoryDigestResultSchema,
  digestPrincipalKey,
  type MemoryConversation,
  type MemoryDigestFact,
  type MemoryReader,
} from "../durable-objects/workspace-memory-facts-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";

/**
 * The memory digest's conversation half: which reader a run's digest is read
 * as, the conversation object's copy of that reader's facts, the refreshes
 * that keep the copy current, and the section a run renders from it.
 *
 * A run never reads `WorkspaceDO` for its digest. It renders from the copy its
 * own object holds (`memory_digest_copies`), which is refreshed after the run
 * settles, after a sweep that wrote, after a forget, when a Sidekick run is
 * provisioned, and by the copy-sync lane when `WorkspaceDO` marks the
 * conversation. The cost is lag: a principal's first run in a Thread or
 * Breakout has no digest, and a new fact reaches a run from
 * the next refresh. See `docs/agent-memory.md#the-digest`.
 */

// LIMIT UNSET: facts one copy holds; 120 one-line facts at ~100 characters is twice the render budget, so the renderer's cut decides what is shown.
export const MEMORY_DIGEST_COPY_FACT_LIMIT = 120;
// LIMIT UNSET: characters the rendered digest may take; ~1,500 tokens at four characters a token, under 1% of a 200k-token window on every request.
export const MEMORY_DIGEST_BUDGET_CHARACTERS = 6_000;

/** One conversation, addressed for both `WorkspaceDO` and the conversation object. */
export type MemoryDigestTarget = MemoryConversation & { workspaceId: string };

/**
 * Who a run's digest is read as.
 *
 * A Sidekick run reads as its Sidekick (its home facts and its own). A person
 * whose own act started the run reads as themselves (the shared facts plus
 * their own), on the same reason list that carries their personal system
 * prompt. Every other run, a wake-up, a connector trigger, an inbound email, a
 * background agent, or a workspace principal, reads as the conversation: what
 * every participant may, and no one person's own facts, because nobody in
 * particular asked.
 */
export function digestReaderFor(input: WorkstreamWorkflowInput): MemoryReader {
  if (input.automationRun || input.parentKind === "automation") {
    return { kind: "sidekick", automationId: input.automationRun?.automationId ?? input.parentId };
  }
  if (input.executionPrincipal.type === "user" && PERSONAL_SYSTEM_PROMPT_REASONS.has(input.reason)
    && !input.backgroundAgent) {
    return { kind: "person", userId: input.executionPrincipal.userId };
  }
  return { kind: "conversation" };
}

/** The copy's row key for a reader; defined beside the reader, because `WorkspaceDO` records it too. */
export { digestPrincipalKey };

/** The reader a stored row key names, or `null` for a key this module never writes. */
function readerOfPrincipalKey(key: string): MemoryReader | null {
  if (key === "conversation") return { kind: "conversation" };
  if (key.startsWith("user:") && key.length > "user:".length) return { kind: "person", userId: key.slice("user:".length) };
  if (key.startsWith("sidekick:") && key.length > "sidekick:".length) {
    return { kind: "sidekick", automationId: key.slice("sidekick:".length) };
  }
  return null;
}

function schedulingPortOf(env: Env, target: MemoryDigestTarget) {
  return createSchedulingObjectPort(env, target.workspaceId, target.parentId, undefined, target.substreamId);
}

function logRefreshFailure(env: Env, target: MemoryDigestTarget, principal: string | null, error: unknown): void {
  logWarn(env, "memory_digest_refresh_failed", {
    workspace_id: target.workspaceId,
    parent_kind: target.parentKind,
    workstream_id: target.parentId,
    substream_id: target.substreamId,
    ...(principal ? { principal_kind: principal.split(":")[0] } : {}),
    reason: diagnosticErrorCode(error, "memory_digest_refresh_failed"),
  });
}

/**
 * Re-read one reader's digest from `WorkspaceDO` and store it as this
 * conversation's copy. One `WorkspaceDO` call and one local write. Never
 * throws: a failure keeps the old copy, logs `memory_digest_refresh_failed`
 * with its reason, and answers `false`.
 */
export async function refreshMemoryDigestCopy(
  env: Env,
  target: MemoryDigestTarget,
  reader: MemoryReader,
): Promise<boolean> {
  const principal = digestPrincipalKey(reader);
  try {
    const workspaceId = asWorkspaceId(target.workspaceId);
    const workspace = await durableObjectStubForWorkspace(
      env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    const digest = WorkspaceMemoryDigestResultSchema.parse(await workspace.memoryDigest({
      workspaceId,
      reader,
      conversation: { parentKind: target.parentKind, parentId: target.parentId, substreamId: target.substreamId },
      now: Date.now(),
      limit: MEMORY_DIGEST_COPY_FACT_LIMIT,
    }));
    await schedulingPortOf(env, target).storeMemoryDigestCopy({
      principal,
      facts: digest.facts,
      sourceRevision: digest.revision,
      now: Date.now(),
    });
    return true;
  } catch (error) {
    logRefreshFailure(env, target, principal, error);
    return false;
  }
}

/**
 * Refresh every copy this conversation holds, one reader at a time. Never
 * throws; answers how many were refreshed and how many failed, so the
 * copy-sync lane can release rather than complete a conversation that did not
 * catch up.
 */
export async function refreshMemoryDigestCopies(
  env: Env,
  target: MemoryDigestTarget,
): Promise<{ refreshed: number; failed: number }> {
  let principals: string[];
  try {
    principals = await schedulingPortOf(env, target).memoryDigestPrincipals();
  } catch (error) {
    logRefreshFailure(env, target, null, error);
    return { refreshed: 0, failed: 1 };
  }
  let refreshed = 0;
  let failed = 0;
  for (const principal of principals) {
    const reader = readerOfPrincipalKey(principal);
    if (!reader) {
      logRefreshFailure(env, target, null, new Error("memory_digest_principal_unrecognized"));
      failed += 1;
      continue;
    }
    if (await refreshMemoryDigestCopy(env, target, reader)) refreshed += 1;
    else failed += 1;
  }
  return { refreshed, failed };
}

/** The digest as the system message carries it, or the empty string when nothing current remains. */
export function renderMemoryDigestSection(facts: readonly MemoryDigestFact[], now: number): string {
  return renderMemoryDigest({ facts, now, budget: MEMORY_DIGEST_BUDGET_CHARACTERS });
}
