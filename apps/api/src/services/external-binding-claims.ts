import type { WorkspaceDO } from "../durable-objects/workspace-do";
import {
  ExternalBindingActivateResultSchema,
  type ExternalBindingClaim,
} from "../durable-objects/workspace-external-binding-protocol";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import type { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logWarn } from "../observability/logger";

type WorkspaceStub = Awaited<ReturnType<typeof durableObjectStubForWorkspace<WorkspaceDO>>>;
type ClaimStub = Pick<WorkspaceStub, "activateExternalConversationBinding" | "releaseExternalConversationBinding">;

/**
 * A Channel created for a provider thread claims that thread's binding in the
 * reservation, and every creation path settles the claim the same way: these
 * are the one implementation. See docs/external-conversation-bindings.md.
 */

/**
 * The reservation refused the thread's claim. `held`: another attempt is
 * creating this thread's Channel, so this one retries and then finds it.
 * `bound`: the thread already has a destination, and a second Channel for it
 * must not exist.
 */
export function externalBindingRefusal(outcome: "held" | "bound"): ApiError {
  return outcome === "held"
    ? new ApiError(503, "external_binding_held", "Another request is creating this conversation's Channel")
    : new ApiError(409, "external_binding_bound", "This conversation is already bound to a Channel");
}

/** The claim a completed creation made becomes the thread's route. */
export async function activateExternalBindingClaim(
  env: Env,
  workspace: ClaimStub,
  workspaceId: string,
  claim: ExternalBindingClaim,
  workstreamId: string,
): Promise<void> {
  const activated = ExternalBindingActivateResultSchema.parse(await workspace.activateExternalConversationBinding({
    workspaceId,
    installationId: claim.installationId,
    path: claim.path,
    target: { kind: "conversation", parentKind: "workstream", parentId: workstreamId, substreamId: "0" },
    at: new Date().toISOString(),
  }));
  if (activated.outcome !== "conflict") return;
  // The claim outlived its lease and another attempt took the thread. This
  // Channel exists and holds its opening message, but nothing routes to it;
  // the log names it so it can be found.
  logWarn(env, "external_binding_activation_lost", { workspace_id: workspaceId, workstream_id: workstreamId });
  throw new ApiError(409, "external_binding_bound", "This conversation is already bound to another Channel");
}

/**
 * Open a Channel whose reservation claimed a thread: a failure releases this
 * attempt's pending claim (a retry of the same create reclaims it), and a
 * success activates it.
 */
export async function openUnderExternalBindingClaim<T>(
  env: Env,
  workspace: ClaimStub,
  workspaceId: string,
  claim: ExternalBindingClaim,
  workstreamId: string,
  open: () => Promise<T>,
): Promise<T> {
  let opened: T;
  try {
    opened = await open();
  } catch (error) {
    await workspace.releaseExternalConversationBinding({
      workspaceId,
      installationId: claim.installationId,
      path: claim.path,
      target: { kind: "conversation", parentKind: "workstream", parentId: workstreamId, substreamId: "0" },
      at: new Date().toISOString(),
    }).catch((releaseError: unknown) => {
      logWarn(env, "external_binding_release_failed", {
        workspace_id: workspaceId,
        workstream_id: workstreamId,
        reason: diagnosticErrorCode(releaseError, "external_binding_release_failed"),
      });
    });
    throw error;
  }
  await activateExternalBindingClaim(env, workspace, workspaceId, claim, workstreamId);
  return opened;
}
