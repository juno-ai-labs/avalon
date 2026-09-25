import {
  asUserId,
  asWorkspaceId,
  type ChannelAccessSources,
  type SpaceErrorCode,
  type SpaceId,
  type SpaceScope,
  type UserId,
  type WorkstreamDetail,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type {
  ConfirmedAccessSource,
  ObservedChannel,
  SetChannelDirectScopeResult,
  SpaceAccessRetraction,
} from "../durable-objects/workstream-access-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError, asApiError } from "../lib/api-error";
import { effectiveChannelAudience } from "../lib/channel-audience";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import {
  publishChannelNarrowing,
  runSpaceSourceApplication,
  runSpaceSourceRetraction,
  type SpaceSourceApplicationInterrupted,
} from "./space-source-operations";
import { WorkstreamObjectClient } from "./workstream-object-client";

export { publishChannelNarrowing };

/**
 * The audience a Space supplies to one Channel.
 *
 * `spaceRevision` and `membershipGeneration` are the Space as it was when this
 * work was staged. They are the caller's to supply because the Channel cannot
 * read them, and they are what the Channel re-reads before committing so a
 * staged application that lost a race cannot overwrite a newer one.
 */
export interface SpaceAccessSource {
  spaceId: SpaceId;
  scope: SpaceScope;
  participantUserIds: readonly UserId[];
  spaceRevision: number;
  membershipGeneration: number;
  operationId: string;
}

/**
 * The one seam between a Space and a Channel's audience.
 *
 * Every caller — a membership change, a Space audience change, the cutover,
 * creation — goes through `applySpaceSource` and `retractSpaceSource`, and
 * nothing here knows which of them is calling. What it does is always the same
 * three steps: read what the Channel's readers are, ask the Channel's own
 * authority for the delta that its provenance implies, and apply that delta
 * through the Channel's canonical scope and participant operations.
 *
 * The third step is the point. Those operations are where the retained-content
 * containment preflight and its SQL triggers run, and where a Channel that has
 * migrated to grant authority writes a grant instead of a participant row. A
 * service that wrote the audience itself would need a second copy of both, and
 * would be the second place an audience could be widened without the fence.
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
   * Read persisted Space provenance while converging a WorkspaceDO-staged move.
   * The durable intent is the authorization; mutable caller access is not
   * rechecked after the move may already have changed Channel provenance.
   */
  async readPersistedSpaceSources(workstreamId: string): Promise<ChannelAccessSources["spaces"]> {
    return (await this.room()).readPersistedSpaceAccessSources(
      this.address(workstreamId),
    );
  }

  /**
   * Remove the Channel's own claim on one reader without revoking a Space's.
   *
   * The canonical participant removal acts on the effective roster. When a
   * Space still supplies the same person, put that reader back attributed to
   * every surviving supplier before the caller publishes a revocation. The
   * boolean says whether access was actually lost.
   */
  async removeDirectReader(workstreamId: string, userId: string): Promise<boolean> {
    const sources = await this.readSources(workstreamId);
    const reader = asUserId(userId);
    const suppliers = sources.spaces.filter((space) => space.participantUserIds.includes(reader));
    const client = this.client(workstreamId);
    await client.removeParticipant(userId);
    const room = await this.room();
    for (const supplier of suppliers) {
      await client.addParticipant(userId, { spaceSourceId: supplier.spaceId });
      const confirmed = await room.confirmSpaceAccessSource({
        ...this.address(workstreamId),
        spaceId: supplier.spaceId,
        operationId: uuidV7(),
        seatedUserIds: [reader],
      });
      if (!confirmed.ok) throw spaceAccessError(confirmed.code, "Channel");
    }
    return sources.direct.scope !== "workspace" && suppliers.length === 0;
  }

  /**
   * Record the Channel's own audience, refusing a narrowing a Space would
   * override.
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
   * useful one, and a restore that is itself refused — the Channel is
   * Organization-wide through a Space, so it cannot be recorded as private —
   * leaves a record that is wrong in the safe direction and is named here.
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

  /**
   * Seat everybody a Space still supplies, before the Channel's own audience
   * stops being Organization-wide.
   *
   * The same gap `audienceSourceRetractionPlan` closes, on the other path into
   * it. A personal Space applied while the Channel was Organization-wide seats
   * nobody — everybody could already read, so a participant row would have
   * added no access — and its readers therefore exist only as that source's
   * roster. Narrowing the Channel's *own* scope with that still true revokes
   * them, although the Space that supplies them has not changed at all.
   *
   * Returns the readers it seated, so a caller whose narrowing then fails can
   * say what it left behind. It does not withdraw them: they are access a
   * source still provides, and the next retraction of that source is what
   * takes them out.
   *
   * Safe to run when nothing narrows. An audience that is still
   * Organization-wide through some Space seats nobody here and is refused by
   * `recordDirectScope` a moment later, which is the authority that decides.
   */
  async narrowDirectScope(workstreamId: string): Promise<UserId[]> {
    const sources = await this.readSources(workstreamId);
    // The direct source as it will be *after* the narrowing, which is the
    // whole question: who is left once the Channel stops admitting everybody.
    const audience = effectiveChannelAudience({
      direct: { scope: "personal", participantUserIds: sources.direct.participantUserIds },
      sources: sources.spaces.map((space) => ({
        sourceId: space.spaceId, scope: space.scope, participantUserIds: space.participantUserIds,
      })),
    });
    if (audience.scope === "workspace") return [];
    const client = this.client(workstreamId);
    const seated = new Set<string>((await client.get()).participants.map((participant) => participant.user.id));
    const newlySeated: UserId[] = [];
    for (const userId of audience.participantUserIds) {
      if (seated.has(userId)) continue;
      // Attributed to the Space that lists them, which is what keeps the grant
      // out of the shared scope-grant directory and what lets that Space's
      // departure take them with it. A reader the direct source lists is
      // already seated, so anybody reached here has a supplier.
      const supplier = sources.spaces.find((space) => space.participantUserIds.includes(userId));
      if (!supplier) continue;
      await client.addParticipant(userId, { spaceSourceId: supplier.spaceId });
      newlySeated.push(userId);
    }
    // Attribute them to the source that supplied them, per Space, or the next
    // retraction reads them as the Channel's own and leaves them behind.
    const room = await this.room();
    for (const space of sources.spaces) {
      const supplied = newlySeated.filter((userId) => space.participantUserIds.includes(userId));
      if (supplied.length === 0) continue;
      const confirmed = await room.confirmSpaceAccessSource({
        ...this.address(workstreamId),
        spaceId: space.spaceId,
        operationId: uuidV7(),
        seatedUserIds: supplied,
      });
      if (!confirmed.ok) {
        // Named rather than thrown: the readers are seated and can read, and
        // failing the narrowing over an attribution would leave the Channel
        // Organization-wide for a reason nobody asked about.
        logWarn(this.env, "channel_narrowing_attribution_refused", {
          workstream_id: workstreamId, space_id: space.spaceId, code: confirmed.code,
        });
      }
    }
    return newlySeated;
  }

  /** A direct add makes this reader the Channel's own, whichever Space seated them. */
  async noteDirectReader(workstreamId: string, userId: string): Promise<void> {
    await (await this.room()).noteDirectReader({
      ...this.address(workstreamId),
      userId: asUserId(userId),
    });
  }

  /**
   * Apply a Space's source to one Channel.
   *
   * `known` is for a caller that already has the Channel's readers and cannot
   * ask for them: the cutover walks archived Channels, and `get` answers 404
   * for an archived one, so the observation comes from the Organization's own
   * directory projection instead. It is the same two facts either way — who may
   * read, and who is listed — and the plan is computed from them by the
   * Channel's own authority, not here.
   */
  async applySpaceSource(
    workstreamId: string,
    source: SpaceAccessSource,
    known?: { channel: ObservedChannel; title: string },
  ): Promise<void> {
    const client = this.client(workstreamId);
    const detail = known ? null : await client.get();
    const observed = known?.channel ?? this.observed(detail!);
    const title = known?.title ?? detail!.title;
    const room = await this.room();
    const applied = await room.applySpaceAccessSource({
      ...this.address(workstreamId),
      spaceId: source.spaceId,
      scope: source.scope,
      participantUserIds: [...source.participantUserIds],
      spaceRevision: source.spaceRevision,
      membershipGeneration: source.membershipGeneration,
      operationId: source.operationId,
      channel: observed,
    });
    if (!applied.ok) throw spaceAccessError(applied.code, title);

    // The source the confirmation below commits, and the Channel as it was
    // before any of this ran. Carried rather than re-read: by the time the
    // confirmation lands the audience may already be Organization-wide
    // because of this very source.
    const confirmedSource = {
      scope: source.scope,
      participantUserIds: [...source.participantUserIds],
      spaceRevision: source.spaceRevision,
      membershipGeneration: source.membershipGeneration,
      channel: observed,
    };

    let seated: UserId[];
    try {
      seated = await runSpaceSourceApplication(client, source.spaceId, applied.plan);
    } catch (error) {
      const interrupted = error as SpaceSourceApplicationInterrupted;
      await this.rollbackSpaceSource(workstreamId, source.spaceId, interrupted.seated, confirmedSource);
      const refusal = asApiError(interrupted.cause);
      if (refusal?.code === "workstream_audience_restricted_content") {
        throw spaceAccessError("space_membership_content_fence", title);
      }
      throw interrupted.cause;
    }

    const confirmed = await room.confirmSpaceAccessSource({
      ...this.address(workstreamId),
      spaceId: source.spaceId,
      operationId: uuidV7(),
      seatedUserIds: seated,
      source: confirmedSource,
    });
    if (!confirmed.ok) {
      await this.rollbackUnconfirmedSeating(workstreamId, source.spaceId, seated);
      throw spaceAccessError(confirmed.code, title);
    }
  }

  /**
   * Withdraw a Space's source from one Channel.
   *
   * `expectedSpaceRevision` is what an audience change carries and a removal or
   * an archive does not: a convergence that retracts in order to re-apply has
   * to lose to a newer one, and the row the application's fence reads is the
   * row this call deletes.
   */
  async retractSpaceSource(
    workstreamId: string,
    spaceId: SpaceId,
    operationId: string,
    expectedSpaceRevision?: number,
  ): Promise<void> {
    const observation = await this.observation(workstreamId);
    const observed = observation.channel;
    const room = await this.room();
    const retracted = await room.retractSpaceAccessSource({
      ...this.address(workstreamId),
      spaceId,
      operationId,
      ...(expectedSpaceRevision === undefined ? {} : { expectedSpaceRevision }),
      channel: observed,
    });
    if (!retracted.ok) throw spaceAccessError(retracted.code, observation.title);
    // Read *after* the retraction, so what comes back is exactly the sources
    // that survived it — which is where the plan's survivors come from, and
    // which the plan itself cannot say because it is a list of readers. Only
    // when there is somebody to attribute: a retraction that seats nobody is
    // the common case and owes no extra hop.
    const remaining = retracted.plan.seatUserIds.length === 0
      ? []
      : (await room.readAccessSources({ ...this.address(workstreamId), channel: observed })).spaces;
    await this.applyRetraction(workstreamId, spaceId, retracted.plan, remaining);
  }

  /**
   * Withdraw what an application seated after it failed part way through.
   *
   * Nothing seated is nothing to withdraw: the application records no source,
   * so a failure before the first canonical add leaves the Channel exactly as
   * it was and this returns without touching it. There is no half-applied
   * audience and no orphaned provenance to clean up, which is the whole reason
   * the source moved to the confirmation.
   *
   * Otherwise the readers that *were* seated are attributed first — committing
   * the source as the successful path would have — and then withdrawn through
   * the same retraction the product path uses, rather than an unwind of its
   * own: the plan is computed against the Channel as it is now and against the
   * other sources that still reach it, so a reader another Space also supplies
   * survives a rollback exactly as it survives a removal.
   */
  private async rollbackSpaceSource(
    workstreamId: string,
    spaceId: SpaceId,
    seated: readonly UserId[],
    source: ConfirmedAccessSource,
  ): Promise<void> {
    if (seated.length === 0) return;
    try {
      const room = await this.room();
      await room.confirmSpaceAccessSource({
        ...this.address(workstreamId),
        spaceId,
        operationId: uuidV7(),
        seatedUserIds: [...seated],
        source,
      });
      await this.retractSpaceSource(workstreamId, spaceId, uuidV7());
    } catch (error) {
      // The refusal the caller is about to see is the useful one; this is the
      // cleanup that could not finish, and it is named so the leftover source
      // can be found rather than inferred from a later surprise.
      logWarn(this.env, "space_access_rollback_failed", {
        workstream_id: workstreamId,
        space_id: spaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove readers this attempt seated after its confirmation loses a fence.
   *
   * The stale source was never committed, so confirming it just to use the
   * ordinary retraction path would lose the same fence again. Re-read the
   * sources that did win, keep every reader their live union still names, and
   * withdraw only the now-unowned seats. A direct grant is protected by the
   * scope-grant authority even if it appeared between this read and removal.
   */
  private async rollbackUnconfirmedSeating(
    workstreamId: string,
    spaceId: SpaceId,
    seated: readonly UserId[],
  ): Promise<void> {
    if (seated.length === 0) return;
    try {
      const current = await this.readSources(workstreamId);
      const retained = new Set(effectiveChannelAudience({
        direct: current.direct,
        sources: current.spaces.map((space) => ({
          sourceId: space.spaceId,
          scope: space.scope,
          participantUserIds: space.participantUserIds,
        })),
      }).participantUserIds);
      const client = this.client(workstreamId);
      for (const userId of seated) {
        if (retained.has(userId)) continue;
        await client.removeParticipant(userId, { spaceSourceId: spaceId });
      }
    } catch (error) {
      logWarn(this.env, "space_access_unconfirmed_seating_rollback_failed", {
        workstream_id: workstreamId,
        space_id: spaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply a retraction through the Channel's canonical operations.
   *
   * Seat, then attribute, then narrow, then remove. Seating first is what keeps
   * a narrowing from revoking access a surviving source still provides — the
   * readers it supplies were never seated while everybody could read — and
   * removing last means nobody is taken out of an audience that is still about
   * to change.
   *
   * A survivor is seated and attributed under a Space that **remains**, never
   * under the one leaving. Naming the departing Space is not a cosmetic
   * mis-labelling: its source row is already gone, so the attribution cannot
   * commit at all, and the reader is left with a grant pointing at nothing.
   * The Space that really supplies them then retracts with no provenance for
   * them and leaves behind a reader nobody can account for — the same failure
   * the attribution in `narrowDirectScope` exists to prevent, on the other
   * path into the same state.
   *
   * A survivor no remaining Space lists is the direct source's, and is seated
   * as the Channel's own with no source at all. One several Spaces list is
   * attributed to each of them, because access is the live union and any one of
   * them departing must leave the others' claim standing.
   */
  private async applyRetraction(
    workstreamId: string,
    spaceId: SpaceId,
    plan: SpaceAccessRetraction,
    remaining: ChannelAccessSources["spaces"],
  ): Promise<void> {
    const room = await this.room();
    await runSpaceSourceRetraction({
      env: this.env,
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      workstreamId,
      client: this.client(workstreamId),
      spaceId,
      plan,
      remaining,
      attribute: async (attributions) => {
        for (const { spaceId: supplierId, userIds } of attributions) {
          const confirmed = await room.confirmSpaceAccessSource({
            ...this.address(workstreamId),
            spaceId: supplierId,
            operationId: uuidV7(),
            seatedUserIds: userIds,
          });
          if (!confirmed.ok) {
            // Named rather than thrown, for the reason `narrowDirectScope` names
            // its own: the readers are seated and can read, and failing here would
            // leave the Channel in the Space it has already been taken out of.
            logWarn(this.env, "channel_retraction_attribution_refused", {
              workstream_id: workstreamId, space_id: supplierId, code: confirmed.code,
            });
          }
        }
      },
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
