import {
  asUserId,
  asWorkspaceId,
  type ChannelAccessSources,
  type SpaceErrorCode,
  type SpaceScope,
  type WorkstreamDetail,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type {
  ObservedChannel,
  SetChannelDirectScopeResult,
} from "../durable-objects/workstream-access-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError, asApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import {
  publishChannelNarrowing,
} from "./space-source-operations";
import { WorkstreamObjectClient } from "./workstream-object-client";

export { publishChannelNarrowing };

/**
 * A Channel's own audience against the Space sources that reach it: reading
 * who supplies whom, and changing the Channel's direct scope and readers
 * without revoking what a Space still supplies.
 *
 * A Space's source itself is applied and withdrawn by WorkspaceDO
 * (`SpaceChannelAccess`), through the same canonical scope and participant
 * operations, which are where the retained-content containment preflight and
 * its SQL triggers run.
 */
export class ChannelAccessService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
  ) {}

  private client(workstreamId: string): WorkstreamObjectClient {
    return new WorkstreamObjectClient(this.env, this.auth, workstreamId);
  }

  /** The Organization object, which hosts every Channel's parent. */
  private async room() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private async workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private address(workstreamId: string) {
    return { workspaceId: asWorkspaceId(this.auth.workspaceId), parentId: workstreamId };
  }

  /**
   * What the Channel's readers are, read once from the conversation that owns
   * them.
   *
   * Both halves come from one `WorkstreamDetail` rather than from
   * `readWorkstreamRuntimeAudience`, which answers `{ scope: "workspace" }` with
   * no roster: an Organization-wide Channel still has participants, and they are
   * what the *direct* source is once the readers a Space seated are taken out.
   * A plan that could not see them would re-seat the whole audience on every
   * narrowing or, worse, narrow without seating anyone.
   */
  private observed(detail: WorkstreamDetail): ObservedChannel {
    const participantUserIds = detail.participants.map((participant) => asUserId(participant.user.id));
    return {
      readers: detail.scope === "workspace"
        ? { scope: "workspace" }
        : { scope: "personal", userIds: participantUserIds },
      participantUserIds,
    };
  }

  /** Product detail, with the directory projection as the archived-only seam. */
  private async observation(workstreamId: string): Promise<{ channel: ObservedChannel; title: string }> {
    try {
      const detail = await this.client(workstreamId).get();
      return { channel: this.observed(detail), title: detail.title };
    } catch (error) {
      if (asApiError(error)?.status !== 404) throw error;
      const projected = await (await this.workspace()).channelAccessObservation({
        workspaceId: this.auth.workspaceId,
        workstreamId,
      });
      if (!projected.found || !projected.archived) throw error;
      return { channel: projected.channel as ObservedChannel, title: projected.title };
    }
  }

  async channelTitle(workstreamId: string): Promise<string> {
    return (await this.observation(workstreamId)).title;
  }

  /**
   * Every source that currently grants a reader access to this Channel.
   *
   * Gated on management access, which is the authority a direct audience change
   * already requires: somebody who cannot change the audience has no reason to
   * be shown which Space supplies which reader. The refusal is a 404 rather
   * than a 403 because the Channel's own read decision has already been made by
   * `get`, and saying "you may read this but not that" about a Channel is a
   * disclosure the rest of this surface does not make.
   */
  async readSources(workstreamId: string): Promise<ChannelAccessSources> {
    const room = await this.room();
    const management = await room.readManagementAccess({
      ...this.address(workstreamId),
      userId: asUserId(this.auth.userId),
    });
    if (!management.allowed) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    const observed = await this.observation(workstreamId);
    return room.readAccessSources({
      ...this.address(workstreamId),
      channel: observed.channel,
    });
  }

  /**
   * Take one reader out of the Channel. A Space supplies no reader, so the
   * canonical removal is the whole change; the boolean says whether access
   * was actually lost, which it is not on an Organization-wide Channel.
   */
  async removeDirectReader(workstreamId: string, userId: string): Promise<boolean> {
    const { channel } = await this.observation(workstreamId);
    await this.client(workstreamId).removeParticipant(userId);
    return channel.readers.scope !== "workspace";
  }

  /**
   * Record the Channel's own audience.
   *
   * Returns the scope that was recorded before, so a caller whose canonical
   * update then fails can put the record back rather than leave it claiming an
   * audience the Channel never took.
   */
  async recordDirectScope(
    workstreamId: string,
    scope: SpaceScope,
    observed = true,
  ): Promise<SetChannelDirectScopeResult> {
    return (await this.room()).setDirectScope({
      ...this.address(workstreamId),
      scope,
      observed,
      operationId: uuidV7(),
    });
  }

  /**
   * Put the recorded direct scope back after a canonical update did not take.
   *
   * Both halves of the record, not just the scope. A Channel whose row was
   * still the migration's guess has to go back to being a guess: restoring the
   * scope alone would tell the first Space to reach it that somebody decided
   * this audience, and stop it seeding the value it can still derive exactly
   * from the readers it is handed.
   *
   * Best effort and never throws: the refusal the caller is about to see is the
   * useful one, and a restore that is itself refused leaves a record that is
   * named here.
   */
  async restoreDirectScope(workstreamId: string, scope: SpaceScope, observed: boolean): Promise<void> {
    try {
      const restored = await this.recordDirectScope(workstreamId, scope, observed);
      if (restored.ok) return;
      logWarn(this.env, "channel_direct_scope_restore_refused", {
        workstream_id: workstreamId, scope, observed, code: restored.code,
      });
    } catch (error) {
      logWarn(this.env, "channel_direct_scope_restore_failed", {
        workstream_id: workstreamId,
        scope,
        observed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** A direct add makes this reader the Channel's own, whichever Space seated them. */
  async noteDirectReader(workstreamId: string, userId: string): Promise<void> {
    await (await this.room()).noteDirectReader({
      ...this.address(workstreamId),
      userId: asUserId(userId),
    });
  }
}

/** One refusal per closed code, each naming the Channel it is about. */
export function spaceAccessError(code: SpaceErrorCode, channelTitle: string): ApiError {
  switch (code) {
    case "space_membership_content_fence":
      return new ApiError(409, code,
        `“${channelTitle}” holds retained content this audience cannot view`);
    case "space_audience_incompatible":
      return new ApiError(409, code,
        `Everyone who can read “${channelTitle}” must still be able to find it through a Space`);
    case "channel_scope_locked_by_space":
      return new ApiError(409, code,
        `“${channelTitle}” is visible to the Organization through a Space, so it cannot be made private until it leaves that Space`);
    case "space_revision_conflict":
      return new ApiError(409, code, "The Space changed while this was being applied; try again");
    case "space_not_found":
      return new ApiError(404, code, "That Space no longer reaches this Channel");
    case "space_membership_final":
      return new ApiError(409, code, `“${channelTitle}” must belong to at least one Space`);
    case "space_protected":
      return new ApiError(409, code, "General cannot be archived or made private");
    case "space_default_audience_mismatch":
      return new ApiError(409, code,
        `Everyone who can read “${channelTitle}” must be able to use this resource`);
    case "space_bootstrap_pending":
      return new ApiError(409, code, "This Organization is still being prepared");
    // The Space half of this table's one code that answers a read as well as a
    // write: a guest or a removed member is refused seeing a Space by the same
    // gate that refuses somebody reaching one through a Channel in it changing
    // it. The sentence has to be true of both.
    case "space_access_denied":
      return new ApiError(403, code, "Your access to that space does not allow this");
    case "space_conversation_unreachable":
      return new ApiError(409, code,
        `“${channelTitle}” could not be asked whether this audience may read it`);
    case "space_authority_unreachable":
      // Written about the Channel, like every sentence in this table. The
      // Space's own authority is what did not answer, and the reader is being
      // told why the Channel in front of them did not change.
      return new ApiError(503, code,
        `The Space that reaches “${channelTitle}” could not be reached; try again`);
    // Reachable only because this map is exhaustive over the shared union. No
    // Channel access path is paginated, so no cursor reaches one, and no
    // Channel access path changes a Space's audience.
    case "space_cursor_invalid":
      return new ApiError(400, code, "That page cursor is not one this Space issued");
    case "space_audience_self_excluded":
      return new ApiError(409, code, "A space cannot be made private without its own editor in it");
  }
}
