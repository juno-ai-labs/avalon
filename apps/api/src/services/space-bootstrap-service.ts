import {
  asUserId,
  asWorkspaceId,
  type SpaceId,
  type WorkstreamId,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceSpaceBootstrapFinalizeResultSchema,
  WorkspaceSpaceBootstrapPageSchema,
  WorkspaceSpaceMembershipPlanResultSchema,
  WorkspaceSpaceMutationResultSchema,
  type SpaceBootstrapChannel,
  type WorkspaceSpaceBootstrapSettleRequest,
} from "../durable-objects/workspace-space-protocol";
import type { ObservedChannel } from "../durable-objects/workstream-access-protocol";
import type { AuthContext, Env } from "../env";
import { boundParameterChunks } from "../durable-objects/bound-parameters";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { ChannelAccessService } from "./channel-access-service";
import { SpaceService } from "./space-service";

/**
 * The one-time cutover that gives an existing Organization its hierarchy.
 *
 * It runs with nobody signed in. The tracker's forced migration wakes every
 * Organization, WorkspaceDO's alarm claims one page of work and publishes it on
 * the activity Queue, and this is what the consumer runs against that page. The
 * PRD requires the fleet migration to finish without relying on user access,
 * which is why none of this hangs off a request.
 *
 * **It acts as a person, per Channel.** The audience change a placement implies
 * goes through the Channel's canonical scope operation, which authorizes an
 * actor — and a personal Channel admits only its own participants. So each
 * placement runs as one of that Channel's active participants rather than as an
 * authority the product does not have; an Organization-wide Channel is acted on
 * by any active member. A Channel with no active participant left is recorded
 * as blocked rather than forced, because there is nobody the disclosure could
 * honestly be attributed to.
 *
 * **A blocker is not a retry.** An immutable content fence is never bypassed
 * and never deleted (PRD: "Cutover never deletes or bypasses those fences"), so
 * a Channel whose retained content the Organization may not read keeps its own
 * audience, keeps no membership, and holds the Organization short of `complete`
 * until somebody remediates it.
 */
export class SpaceBootstrapService {
  constructor(
    private readonly env: Env,
    /** Any active member, used for Channels every member can already act on. */
    private readonly driver: AuthContext,
  ) {}

  /** Create the Organization's General Space, then move the pass on. */
  async runGeneral(): Promise<void> {
    const general = await new SpaceService(this.env, this.driver).ensureGeneral();
    logInfo(this.env, "space_bootstrap_general_ready", {
      workspace_id: this.driver.workspaceId,
      space_id: general.id,
    });
    await this.settle({ phase: "general", cursor: null, placedWorkstreamIds: [], blocked: [] });
  }

  /**
   * Place one page of Channels in General.
   *
   * Active and archived alike. A Channel some Space already holds is receipted
   * and skipped, which is what makes a redelivery of the same page — and a
   * Channel created by the ordinary creation path while the cutover is running
   * — cost nothing.
   */
  async runMemberships(cursor: WorkstreamId | null): Promise<void> {
    const workspace = await this.workspace();
    const page = WorkspaceSpaceBootstrapPageSchema.parse(await workspace.spaceBootstrapPage({
      workspaceId: this.driver.workspaceId,
      cursor,
    }));
    if (page.generalSpaceId === null) {
      // The phase moved backwards under us, or General's reservation was
      // cancelled. Say so and let the alarm republish the `general` step.
      await this.settle({ phase: "general", cursor: null, placedWorkstreamIds: [], blocked: [] });
      return;
    }
    const actors = await this.activeActors(page.items);
    const placed: WorkstreamId[] = [];
    const blocked: Array<{ workstreamId: WorkstreamId; code: string }> = [];
    for (const channel of page.items) {
      if (channel.placed) {
        placed.push(channel.workstreamId);
        continue;
      }
      const outcome = await this.place(channel, page.generalSpaceId, actors);
      if (outcome === null) placed.push(channel.workstreamId);
      else blocked.push({ workstreamId: channel.workstreamId, code: outcome });
    }
    if (blocked.length > 0) {
      logWarn(this.env, "space_bootstrap_channels_blocked", {
        workspace_id: this.driver.workspaceId,
        blocked: blocked.length,
        reason: blocked[0]?.code ?? "unknown",
      });
    }
    await this.settle({
      phase: "memberships",
      cursor: page.nextCursor,
      placedWorkstreamIds: placed,
      blocked,
    });
  }

  /**
   * Close the Organization's cutover, or leave it open and say why.
   *
   * The refusals are not failures to retry immediately: an unplaced Channel
   * means a page is still owed, and a blocker means a person has to act. Both
   * leave the phase at `finalize`, where the alarm's retry gate republishes it
   * on the ordinary interval.
   */
  async runFinalize(): Promise<void> {
    const result = WorkspaceSpaceBootstrapFinalizeResultSchema.parse(
      await (await this.workspace()).finalizeSpaceBootstrap({ workspaceId: this.driver.workspaceId }),
    );
    if (result.outcome === "complete") {
      logInfo(this.env, "space_bootstrap_complete", { workspace_id: this.driver.workspaceId });
      return;
    }
    if (result.outcome === "unplaced") {
      // A Channel arrived after the walk passed its id — the ordinary creation
      // path places one itself, but a directory projection can land late — so
      // the walk starts again rather than the Organization waiting forever.
      await this.settle({ phase: "general", cursor: null, placedWorkstreamIds: [], blocked: [] });
      return;
    }
    logWarn(this.env, "space_bootstrap_not_ready", {
      workspace_id: this.driver.workspaceId,
      reason: result.outcome,
    });
  }

  /**
   * Place one Channel in General on its own, outside a page.
   *
   * For a creation path that cannot reach the coordinator: the Slack agent
   * opens a Channel for a Slack member who is not a Rally user at all, and
   * provisions the object itself rather than through
   * `WorkstreamObjectCreationService`. Every non-deleted Channel still has to
   * have a home, so it takes the same step a page would take for it.
   */
  async placeChannel(channel: SpaceBootstrapChannel): Promise<string | null> {
    const general = await new SpaceService(this.env, this.driver).ensureGeneral();
    return this.place(channel, general.id, await this.activeActors([channel]));
  }

  /** Place one Channel in General, or name the refusal that stopped it. */
  private async place(
    channel: SpaceBootstrapChannel,
    generalSpaceId: SpaceId,
    actors: ReadonlyMap<string, AuthContext>,
  ): Promise<string | null> {
    const actor = this.actorFor(channel, actors);
    if (!actor) return "space_bootstrap_no_active_actor";
    // Only a Channel that is about to be widened. An Organization-wide one is
    // already readable by everybody General admits, so there is nothing for a
    // containment fence to be about and nothing to ask a second object.
    if (channel.scope === "personal") {
      const contains = await (await this.conversation(channel.workstreamId)).previewAudienceContainment({
        workspaceId: asWorkspaceId(this.driver.workspaceId),
        workstreamId: channel.workstreamId,
        audience: { scope: "workspace" },
      });
      if (contains !== true) {
        return contains === false
          ? "space_membership_content_fence"
          : "space_bootstrap_conversation_unreachable";
      }
    }
    const workspace = await this.workspace();
    const plan = WorkspaceSpaceMembershipPlanResultSchema.parse(await workspace.prepareSpaceMembership({
      workspaceId: asWorkspaceId(this.driver.workspaceId),
      userId: asUserId(actor.userId),
      spaceId: generalSpaceId,
      workstreamId: channel.workstreamId,
    }));
    if (!plan.ok) return plan.code;
    const settle = {
      workspaceId: asWorkspaceId(this.driver.workspaceId),
      userId: asUserId(actor.userId),
      spaceId: generalSpaceId,
      workstreamId: channel.workstreamId,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    };
    try {
      // Through the one seam, with the observation the Organization already
      // holds: `get` answers 404 for an archived Channel, and the cutover has
      // to place those too.
      await new ChannelAccessService(this.env, actor).applySpaceSource(channel.workstreamId, {
        spaceId: generalSpaceId,
        scope: plan.space.scope,
        participantUserIds: plan.space.participants.map((participant) => participant.userId),
        spaceRevision: plan.space.revision,
        membershipGeneration: plan.membershipGeneration,
        operationId: uuidV7(),
      }, { channel: observedFromDirectory(channel), title: "" });
      const settled = WorkspaceSpaceMutationResultSchema.parse(
        await workspace.finalizeSpaceMembership(settle),
      );
      if (!settled.ok) throw new Error(settled.code);
      return null;
    } catch (error) {
      await workspace.cancelSpaceMembership(settle).catch(() => undefined);
      return diagnosticErrorCode(error, "space_bootstrap_placement_failed");
    }
  }

  /**
   * Who may act on this Channel.
   *
   * A personal Channel admits only its own participants, so one of them is the
   * only honest actor. An Organization-wide one is readable and writable by
   * every active member, so the driver acts.
   */
  private actorFor(
    channel: SpaceBootstrapChannel,
    actors: ReadonlyMap<string, AuthContext>,
  ): AuthContext | null {
    for (const userId of channel.participantUserIds) {
      const actor = actors.get(userId);
      if (actor) return actor;
    }
    return channel.scope === "workspace" ? this.driver : null;
  }

  /** The page's participants who are still active members, as actors. */
  private async activeActors(
    items: readonly SpaceBootstrapChannel[],
  ): Promise<Map<string, AuthContext>> {
    const actors = new Map<string, AuthContext>();
    const userIds = [...new Set(items.flatMap((item) => item.participantUserIds as string[]))];
    for (const chunk of boundParameterChunks(userIds)) {
      const rows = await this.env.DB.prepare(
        `SELECT user_id, role FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND access_class = 'member'
            AND user_id IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(this.driver.workspaceId, ...chunk)
        .all<{ user_id: string; role: AuthContext["role"] }>();
      for (const row of rows.results) {
        actors.set(row.user_id, { ...this.driver, userId: asUserId(row.user_id), role: row.role });
      }
    }
    return actors;
  }

  private async settle(input: Omit<WorkspaceSpaceBootstrapSettleRequest, "workspaceId">): Promise<void> {
    await (await this.workspace()).settleSpaceBootstrapPage({
      workspaceId: asWorkspaceId(this.driver.workspaceId),
      ...input,
    });
  }

  private conversation(workstreamId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      this.driver.workspaceId,
      conversationObjectName(
        this.env.AVALON_REGION, asWorkspaceId(this.driver.workspaceId), workstreamId,
      ),
    );
  }

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.driver.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.driver.workspaceId),
    );
  }
}

/**
 * The Channel as the Organization's own directory projection describes it.
 *
 * The cutover cannot read a Channel's conversation for this — `get` refuses an
 * archived one, and every Channel it walks is one nobody has asked about — and
 * it does not need to: the projection is the Organization's record of the same
 * two facts the plan is computed from.
 */
function observedFromDirectory(channel: SpaceBootstrapChannel): ObservedChannel {
  const participantUserIds = channel.participantUserIds.map((userId) => asUserId(userId));
  return {
    readers: channel.scope === "workspace"
      ? { scope: "workspace" }
      : { scope: "personal", userIds: participantUserIds },
    participantUserIds,
  };
}

/**
 * An active member to drive one Organization's cutover.
 *
 * Owners first, then administrators, then anybody: the driver is what acts on
 * Channels every member can already act on, and preferring the people who
 * administer the Organization keeps the audit trail on the least surprising
 * name. A guest is never chosen — guests hold explicit Channel grants and no
 * Organization-wide discovery — and an Organization with no active member has
 * nobody to act at all, which is what `null` says.
 */
export async function spaceBootstrapDriver(
  env: Env,
  workspaceId: string,
  region: AuthContext["region"],
): Promise<AuthContext | null> {
  const member = await env.DB.prepare(
    `SELECT user_id, role FROM workspace_members
      WHERE workspace_id = ? AND status = 'active' AND access_class = 'member'
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, user_id
      LIMIT 1`,
  ).bind(workspaceId).first<{ user_id: string; role: AuthContext["role"] }>();
  if (!member) return null;
  return {
    // A correlation value, not a `sessions` row: the cutover has no session,
    // and the objects verify a non-session principal against current
    // membership instead.
    sessionId: `space-bootstrap:${workspaceId}`,
    userId: asUserId(member.user_id),
    workspaceId: asWorkspaceId(workspaceId),
    region,
    role: member.role,
    analyticsWorkspaceId: null,
    principal: "connector",
  };
}


/**
 * Open a new Organization's General Space before its first usable session.
 *
 * The alarm would get there on its own — a freshly initialized WorkspaceDO
 * claims its `general` page within a tick — but "within a tick" is a Queue
 * round trip, and the first session in that window is shown the
 * Organization-opening card for an Organization that has nothing to open. So
 * the path that initializes the object does the same two steps inline: make
 * General, then close a cutover that has an empty directory to walk.
 *
 * Best effort, deliberately. This is on the onboarding path, and a Space
 * failure must not cost somebody the Organization they just created; the alarm
 * is the backstop and it is the same code. An Organization whose object already
 * holds Channels — a restore, or an import — is left to the alarm's walk, which
 * is what `runFinalize` answers with when anything is still unplaced.
 */
export async function openGeneralSpaceForNewWorkspace(
  env: Env,
  workspaceId: string,
): Promise<void> {
  try {
    const driver = await spaceBootstrapDriver(env, workspaceId, env.AVALON_REGION);
    // No active member yet: the creation path writes the membership after the
    // object is initialized on some routes, and the alarm follows either way.
    if (!driver) return;
    await new SpaceService(env, driver).ensureGeneral();
    await new SpaceBootstrapService(env, driver).runFinalize();
  } catch (error) {
    logWarn(env, "space_bootstrap_open_failed", {
      workspace_id: workspaceId,
      reason: diagnosticErrorCode(error, "space_bootstrap_open_failed"),
    });
  }
}

/**
 * Give a connector-created Channel its home.
 *
 * The Slack agent opens a Channel for a Slack member with no Rally identity,
 * and provisions the conversation itself rather than through the creation
 * coordinator — so it is the one creation path the coordinator's placement does
 * not cover, and PRD goal 4 covers connectors explicitly. Best effort and
 * never throws: the person's Slack message has already produced a Channel and
 * a run, and a placement that could not be made must not turn that into an
 * error they see. What it costs when it fails is named here.
 */
export async function placeConnectorChannelInGeneral(
  env: Env,
  workspaceId: string,
  channel: SpaceBootstrapChannel,
): Promise<void> {
  try {
    const driver = await spaceBootstrapDriver(env, workspaceId, env.AVALON_REGION);
    if (!driver) return;
    const refusal = await new SpaceBootstrapService(env, driver).placeChannel(channel);
    if (refusal === null) return;
    logWarn(env, "space_connector_channel_unplaced", {
      workspace_id: workspaceId,
      workstream_id: channel.workstreamId,
      reason: refusal,
    });
  } catch (error) {
    logWarn(env, "space_connector_channel_unplaced", {
      workspace_id: workspaceId,
      workstream_id: channel.workstreamId,
      reason: diagnosticErrorCode(error, "space_connector_channel_unplaced"),
    });
  }
}
