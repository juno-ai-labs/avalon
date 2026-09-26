import {
  asUserId,
  asWorkspaceId,
  type WorkstreamId,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceSpaceBootstrapFinalizeResultSchema,
  WorkspaceSpaceBootstrapPageSchema,
  WorkspaceSpaceChannelChangeResultSchema,
  type SpaceBootstrapChannel,
  type WorkspaceSpaceBootstrapSettleRequest,
} from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { boundParameterChunks } from "../durable-objects/bound-parameters";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
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
    await this.settle({ phase: "general", cursor: null, clearedWorkstreamIds: [], blocked: [] });
  }

  /**
   * Ask, of one page of Channels, whether the cutover may widen each of them —
   * and write nothing.
   *
   * The PRD's Existing Organizations section says an unsafe Channel blocks its
   * Organization "without partial mutation", and rollout step 3 asks the
   * preflight to identify every blocker *before* promotion. A walk that
   * discovered its blockers one placement at a time could not do either: by the
   * time the fenced Channel refused, the Channels before it in the page were
   * already Organization-wide. So the same questions a placement asks are asked
   * here first, against the same page and cursor, and `memberships` is only
   * entered when this pass recorded nothing.
   *
   * A Channel that comes back clear is reported as cleared, which takes a stale
   * blocker off the row: this is also the pass that notices a remediation, and
   * a Channel whose content or fence has changed since the last walk is exactly
   * what an Organization stuck in `finalize` is waiting for.
   */
  async runPreflight(cursor: WorkstreamId | null): Promise<void> {
    const workspace = await this.workspace();
    const page = WorkspaceSpaceBootstrapPageSchema.parse(await workspace.spaceBootstrapPage({
      workspaceId: this.driver.workspaceId,
      cursor,
    }));
    if (page.generalSpaceId === null) {
      await this.reopen();
      return;
    }
    const actors = await this.activeActors(page.items);
    const cleared: WorkstreamId[] = [];
    const blocked: Array<{ workstreamId: WorkstreamId; code: string }> = [];
    for (const channel of page.items) {
      // A Channel some Space already holds is not about to be widened by this
      // cutover, so there is nothing to preflight and nothing to refuse.
      const admission = channel.placed ? { actor: this.driver } : await this.admit(channel, actors);
      if ("actor" in admission) cleared.push(channel.workstreamId);
      else blocked.push({ workstreamId: channel.workstreamId, code: admission.code });
    }
    if (blocked.length > 0) {
      logWarn(this.env, "space_bootstrap_channels_blocked", {
        workspace_id: this.driver.workspaceId,
        blocked: blocked.length,
        reason: blocked[0]?.code ?? "unknown",
      });
    }
    await this.settle({
      phase: "preflight",
      cursor: page.nextCursor,
      clearedWorkstreamIds: cleared,
      blocked,
    });
  }

  /**
   * Place one page of Channels in General.
   *
   * Active and archived alike, and only ever on an Organization whose
   * `preflight` pass found nothing to refuse. A Channel some Space already
   * holds is skipped, which is what makes a redelivery of the same page — and a
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
      await this.reopen();
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
      const outcome = await this.place(channel, actors);
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
      clearedWorkstreamIds: placed,
      blocked,
    });
  }

  /**
   * Close the Organization's cutover, or send it back to the walk and say why.
   *
   * **Both refusals re-walk**, and the difference between them is only how
   * soon. An unplaced Channel is new work — the walk passed its id before it
   * existed — so the pass starts again with its gate cleared. A blocker means a
   * person has to act, and the pass that takes a Channel off `blocked_json` is
   * the same walk: the preflight reports the Channels it now finds clear and a
   * still-fenced one is simply re-recorded. Leaving the phase at `finalize`
   * instead, which is what this used to do, made a blocked Organization
   * permanent — nothing else clears a blocker, so `spacesReady` stayed false
   * and the opening card stayed up however the Channel was remediated.
   *
   * The blocked re-walk keeps the claim's retry gate rather than zeroing it, so
   * an Organization nobody remediates re-walks on
   * `scheduledAlarmRetryDelay`'s interval instead of spinning the alarm.
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
      await this.settle({ phase: "general", cursor: null, clearedWorkstreamIds: [], blocked: [] });
      return;
    }
    logWarn(this.env, "space_bootstrap_not_ready", {
      workspace_id: this.driver.workspaceId,
      reason: result.outcome,
    });
    await this.reopen();
  }

  /**
   * Put this Organization's cutover back on the walk.
   *
   * Idempotent, and it keeps the claim's retry gate: an Organization already
   * walking is left where it is, and one that had settled starts again on the
   * ordinary interval.
   */
  async reopen(): Promise<void> {
    await (await this.workspace()).reopenSpaceBootstrap({ workspaceId: this.driver.workspaceId });
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
    await new SpaceService(this.env, this.driver).ensureGeneral();
    return this.place(channel, await this.activeActors([channel]));
  }

  /**
   * Whether the cutover may widen this Channel, and as whom.
   *
   * Everything a placement can refuse *before* it writes anything, in one
   * place, because two passes ask it: `preflight` to find every blocker in an
   * Organization before the first Channel is widened, and `place` again at the
   * moment of the mutation. The second ask is not redundant — the fence is a
   * trigger inside the conversation and content can arrive between the two —
   * but by then a refusal is a rarity rather than the normal way a blocker is
   * discovered.
   *
   * Only a Channel that is about to be widened is asked about containment. An
   * Organization-wide one is already readable by everybody General admits, so
   * there is nothing for a containment fence to be about and nothing to ask a
   * second object.
   */
  private async admit(
    channel: SpaceBootstrapChannel,
    actors: ReadonlyMap<string, AuthContext>,
  ): Promise<{ actor: AuthContext } | { code: string }> {
    const actor = this.actorFor(channel, actors);
    if (!actor) return { code: "space_bootstrap_no_active_actor" };
    if (channel.scope === "personal") {
      const contains = await (await this.conversation(channel.workstreamId)).previewAudienceContainment({
        workspaceId: asWorkspaceId(this.driver.workspaceId),
        workstreamId: channel.workstreamId,
        audience: { scope: "workspace" },
      });
      if (contains !== true) {
        return {
          code: contains === false
            ? "space_membership_content_fence"
            : "space_bootstrap_conversation_unreachable",
        };
      }
    }
    return { actor };
  }

  /**
   * Place one Channel in General, or name the refusal that stopped it.
   *
   * One WorkspaceDO call as the actor: it stages the membership, asks the
   * Channel's conversation for General's audience and activates the
   * membership, the same path a person adding a Channel takes, able to place
   * an archived Channel as well.
   */
  private async place(
    channel: SpaceBootstrapChannel,
    actors: ReadonlyMap<string, AuthContext>,
  ): Promise<string | null> {
    const admission = await this.admit(channel, actors);
    if (!("actor" in admission)) return admission.code;
    const { actor } = admission;
    const placed = WorkspaceSpaceChannelChangeResultSchema.parse(await (await this.workspace()).placeChannelInGeneral({
      auth: {
        sessionId: actor.sessionId,
        userId: asUserId(actor.userId),
        workspaceId: asWorkspaceId(actor.workspaceId),
        region: actor.region,
        role: actor.role,
        ...(actor.principal ? { principal: actor.principal } : {}),
      },
      workstreamId: channel.workstreamId,
    }));
    return placed.ok ? null : placed.refusal.code;
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
 * Give a Channel its home when the creation coordinator did not.
 *
 * The Slack agent opens a Channel for a Slack member with no Rally identity,
 * and provisions the conversation itself rather than through the creation
 * coordinator — PRD goal 4 covers connectors explicitly. The local development
 * seed route is the other caller and is there for the same reason: it restores
 * a captured fixture into objects it provisions under the fixture's own ids.
 * Neither reaches `WorkstreamObjectCreationService`, and every non-deleted
 * Channel still has to have a home. Best effort and never throws: the person's
 * Slack message has already produced a Channel and a run, and a placement that
 * could not be made must not turn that into an error they see.
 *
 * **A refusal reopens the cutover.** Saying so in a log and stopping there left
 * the Channel homeless for good: a `complete` Organization is never walked
 * again, and this is the one placement path with no page behind it. The
 * Organization goes back to the walk instead, which is the same pass that
 * places every other Channel and reaches this one with the directory's own
 * record of who may act on it rather than the connector's. The Organization is
 * not `spacesReady` while that runs, which is the honest answer: one of its
 * Channels is in no Space.
 */
export async function placeConnectorChannelInGeneral(
  env: Env,
  workspaceId: string,
  channel: SpaceBootstrapChannel,
): Promise<void> {
  let cutover: SpaceBootstrapService | null = null;
  try {
    const driver = await spaceBootstrapDriver(env, workspaceId, env.AVALON_REGION);
    if (!driver) return;
    cutover = new SpaceBootstrapService(env, driver);
    const refusal = await cutover.placeChannel(channel);
    if (refusal === null) return;
    logWarn(env, "space_connector_channel_unplaced", {
      workspace_id: workspaceId,
      workstream_id: channel.workstreamId,
      reason: refusal,
    });
    await cutover.reopen();
  } catch (error) {
    logWarn(env, "space_connector_channel_unplaced", {
      workspace_id: workspaceId,
      workstream_id: channel.workstreamId,
      reason: diagnosticErrorCode(error, "space_connector_channel_unplaced"),
    });
    await cutover?.reopen().catch((reopenError: unknown) => {
      logWarn(env, "space_connector_channel_reopen_failed", {
        workspace_id: workspaceId,
        workstream_id: channel.workstreamId,
        reason: diagnosticErrorCode(reopenError, "space_connector_channel_reopen_failed"),
      });
    });
  }
}
