import {
  asWorkspaceId,
  type SpaceErrorCode,
  type SpaceId,
  type SpaceSummary,
  type UserId,
  type WorkstreamDetail,
  type WorkstreamId,
} from "@rally/contracts";

import type { Env } from "../env";
import { asApiError } from "../lib/api-error";
import { effectiveChannelAudience } from "../lib/channel-audience";
import { settledBatches } from "../lib/settled-batches";
import { stableUuidSync } from "../lib/stable-uuid";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import {
  observedAfterRetraction,
  runSpaceSourceApplication,
  runSpaceSourceRetraction,
  SpaceSourceApplicationInterrupted,
  survivorAttributions,
} from "../services/space-source-operations";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import type { HostedParent } from "./hosted-parent";
import type {
  SpaceActorAuth,
  SpaceChannelRefusal,
  SpaceMemberWalkKind,
  WorkspaceSpaceChannelChangeResult,
  WorkspaceSpaceIntentResumeResult,
  WorkspaceSpaceMemberWalkResult,
  WorkspaceSpaceMutationResult,
} from "./workspace-space-protocol";
import type { WorkspaceSpaceIntentClaim, WorkspaceSpaceStorage } from "./workspace-space-storage";
import type {
  ConfirmedAccessSource,
  ObservedChannel,
  SpaceAccessApplication,
  SpaceAccessRetraction,
} from "./workstream-access-protocol";
import type { ChannelAccessSources } from "@rally/contracts";

/**
 * Cloudflare permits six simultaneous outgoing connections per invocation
 * (https://developers.cloudflare.com/workers/platform/limits/, verified
 * 2026-09-21). An archive's member steps are independent withdrawals, so six
 * can overlap without asking the runtime to queue a seventh connection.
 */
const SPACE_ARCHIVE_MEMBER_CONCURRENCY = 6;

/** What WorkspaceDO lends the Space source coordinator. */
export interface SpaceChannelAccessHost {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  /**
   * Run `run` in one transaction, learning anybody it met that the member
   * table had never heard of and running it once more; the first run rolled
   * back whole.
   */
  transaction<T>(run: () => T): Promise<T>;
  spaceStorage(): WorkspaceSpaceStorage;
  hostedParent(parentId: string, workspaceId: string): Promise<HostedParent>;
  /** The directory's audience for an archived Channel, whose product read answers 404. */
  archivedChannel(workstreamId: string): { channel: ObservedChannel; title: string } | null;
  /** When a newly staged intent becomes due for the alarm's resume. */
  intentResumeAt(): number;
  /**
   * Mark an intent as being run by this request until the returned release,
   * so the alarm skips it rather than running the same intent alongside.
   */
  holdIntent(operationId: string): () => void;
  armNextAlarm(): Promise<void>;
  publishSpaceSnapshot(): void;
  publishMembershipChanged(workstreamId: string, spaceIds: readonly string[]): void;
  deferSpaceMembershipConvergence(workspaceId: string, workstreamId: string, includeDirectory: boolean): void;
  afterSidekickDefaultsApplied(storage: WorkspaceSpaceStorage, workspaceId: string): Promise<void>;
  finalizeArchive(
    workspaceId: string, userId: string, spaceId: string, operationId: string,
  ): Promise<WorkspaceSpaceMutationResult>;
}

/** The fences a staged membership was written at, which its resume carries. */
export interface StagedMembership {
  spaceRevision: number;
  membershipGeneration: number;
}

/** The Space whose audience a change applies, and the membership it is fenced on. */
interface PlannedSource {
  space: SpaceSummary;
  membershipGeneration: number;
}

type SourceChange = "apply" | "retract" | "reapply";

type ChangeOutcome<T> = { ok: true; value: T } | { ok: false; refusal: SpaceChannelRefusal };

/** A refusal raised inside a plan or settle transaction, so the transaction rolls back. */
class SpaceSourceRefused extends Error {
  constructor(readonly refusal: SpaceChannelRefusal) {
    super(refusal.code);
  }
}

function spaceRefused(
  code: SpaceErrorCode,
  subject: string,
  unreachableUserIds: readonly UserId[] = [],
  blockedWorkstreamIds: readonly WorkstreamId[] = [],
): SpaceSourceRefused {
  return new SpaceSourceRefused({
    about: "space", code, subject, unreachableUserIds: [...unreachableUserIds],
    blockedWorkstreamIds: [...blockedWorkstreamIds],
  });
}

function channelRefused(code: SpaceErrorCode, title: string): SpaceSourceRefused {
  return new SpaceSourceRefused({ about: "channel", code, subject: title });
}

/**
 * A Channel conversation's refusal, passed on with its own code and sentence.
 *
 * Anything that is not the conversation's own `ApiError` (an RPC that broke, a
 * parent that could not be imported) is named by its diagnostic code rather
 * than left to cross the RPC hop as a bare `Error`.
 */
function conversationRefusal(error: unknown): SpaceChannelRefusal {
  const refusal = asApiError(error);
  if (refusal) {
    return {
      about: "conversation",
      status: refusal.status,
      code: refusal.code,
      message: refusal.message,
      ...(refusal.details ? { details: refusal.details } : {}),
    };
  }
  return {
    about: "conversation",
    status: 503,
    code: diagnosticErrorCode(error, "channel_access_unreachable"),
    message: "The Channel could not be reached; try again",
  };
}

/** The operation id an `add` or `remove` intent is recorded under. */
function membershipOperationId(spaceId: string, workstreamId: string, generation: number): string {
  return `${spaceId}:${workstreamId}:${generation}`;
}

function observedOf(detail: WorkstreamDetail): ObservedChannel {
  const participantUserIds = detail.participants.map((participant) => participant.user.id);
  return {
    readers: detail.scope === "workspace"
      ? { scope: "workspace" }
      : { scope: "personal", userIds: participantUserIds },
    participantUserIds,
  } as ObservedChannel;
}

/**
 * A Space's source on an existing Channel, driven from WorkspaceDO.
 *
 * Every change is the same three steps around the Channel's canonical
 * operations, which stay the only place a Channel's audience is written (the
 * retained-content fence and the roster live in its conversation):
 *
 * 1. One transaction here stages whatever the change is about (a `joining` or
 *    `removing` membership and its intent, or nothing for a walk step),
 *    retracts the departing source and records which remaining Space supplies
 *    each survivor, and commits the applied source with the readers it plans
 *    to seat.
 * 2. The Channel's conversation is asked for the canonical operations the plan
 *    names, as the person who asked.
 * 3. One transaction here confirms the applied source and settles the
 *    membership and its intent.
 *
 * The intent row is the durable record between the two transactions, and the
 * alarm resumes it through this same path. The access operations of step 1
 * are keyed by the intent (`operationId` on `changeSource`), so a resume
 * replays the plan the first attempt committed rather than planning again
 * against a Channel that attempt may already have changed: a retraction's
 * departing readers are the ones it read before the source was deleted, and
 * an application's seats are the ones it recorded before any were made.
 */
export class SpaceChannelAccess {
  constructor(private readonly host: SpaceChannelAccessHost) {}

  /**
   * Put an existing Channel in a Space, or finish a staged `add`.
   *
   * With `staged`, the membership is already `joining` at those fences (a
   * resume) and is not staged again. `archived` lets the cutover place an
   * archived Channel, observed from the directory because its product read
   * answers 404; the product route never passes it.
   */
  async addChannel(
    actor: SpaceActorAuth,
    spaceId: SpaceId,
    workstreamId: WorkstreamId,
    staged: StagedMembership | null,
    options: { archived?: boolean } = {},
  ): Promise<WorkspaceSpaceChannelChangeResult> {
    const storage = this.host.spaceStorage();
    const address = { workspaceId: actor.workspaceId, userId: actor.userId, spaceId, workstreamId };
    let fences = staged;
    let spaceName = "";
    let release: (() => void) | null = null;
    const operationId = () => membershipOperationId(spaceId, workstreamId, fences!.membershipGeneration);
    const result = await this.changeSource({
      actor,
      spaceId,
      workstreamId,
      change: "apply",
      operationId: () => operationId(),
      archived: options.archived ?? false,
      plan: () => {
        if (staged) {
          const space = this.currentSpace(storage, actor.userId, spaceId);
          if (space.revision !== staged.spaceRevision) throw spaceRefused("space_revision_conflict", space.name);
          spaceName = space.name;
          return { space, membershipGeneration: staged.membershipGeneration };
        }
        const prepared = storage.prepareMembership(address);
        if (!prepared.ok) {
          throw spaceRefused(prepared.code, "", prepared.unreachableUserIds, prepared.blockedWorkstreamIds);
        }
        fences = { spaceRevision: prepared.space.revision, membershipGeneration: prepared.membershipGeneration };
        spaceName = prepared.space.name;
        storage.recordIntent({
          operationId: operationId(),
          kind: "add",
          spaceId,
          workstreamId,
          spaceRevision: prepared.space.revision,
          membershipGeneration: prepared.membershipGeneration,
          deliveryGeneration: null,
          requestedByUserId: actor.userId,
          notBefore: this.host.intentResumeAt(),
        });
        return prepared;
      },
      afterPlan: staged ? undefined : async () => {
        release = this.host.holdIntent(operationId());
        await this.host.armNextAlarm();
      },
      settle: () => {
        const space = storage.finalizeMembership({ ...address, ...fences! });
        if (space === "conflict") throw spaceRefused("space_revision_conflict", spaceName);
        if (space === false) throw spaceRefused("space_not_found", spaceName);
        // A Channel that has just joined inherits every current default, staged
        // in the transaction that activates it so a default registered
        // meanwhile reaches it exactly once.
        storage.stageDefaultsForMember(spaceId, workstreamId, fences!.membershipGeneration, actor.userId);
        storage.settleIntent(operationId(), "membership_finalized", true);
        return space;
      },
      // Nothing renders a `joining` row, so an add that will not finish takes
      // it back rather than leave it for the alarm.
      abandon: () => {
        if (!fences) return;
        storage.cancelMembership({ ...address, ...fences });
        storage.cancelIntent(operationId());
      },
    }).finally(() => (release as (() => void) | null)?.());
    if (!result.ok) {
      if (fences) this.host.publishSpaceSnapshot();
      return result;
    }
    this.host.publishSpaceSnapshot();
    // Through the Channel: the people whose Space dashboard changed are the
    // people who can list it.
    this.host.publishMembershipChanged(workstreamId, [spaceId]);
    this.host.deferSpaceMembershipConvergence(actor.workspaceId, workstreamId, false);
    await this.host.afterSidekickDefaultsApplied(storage, actor.workspaceId);
    return { ok: true, space: result.value };
  }

  /**
   * Take a Channel out of a Space, or finish a staged `remove`.
   *
   * A failure after the plan leaves the membership `removing` and its intent
   * pending: the source is already withdrawn from the Channel's record, so the
   * only way forward is the resume replaying the retraction that read it.
   */
  async removeChannel(
    actor: SpaceActorAuth,
    spaceId: SpaceId,
    workstreamId: WorkstreamId,
    staged: StagedMembership | null,
  ): Promise<WorkspaceSpaceChannelChangeResult> {
    const storage = this.host.spaceStorage();
    const address = { workspaceId: actor.workspaceId, userId: actor.userId, spaceId, workstreamId };
    let fences = staged;
    let spaceName = "";
    let release: (() => void) | null = null;
    const operationId = () => membershipOperationId(spaceId, workstreamId, fences!.membershipGeneration);
    const result = await this.changeSource({
      actor,
      spaceId,
      workstreamId,
      change: "retract",
      operationId: () => operationId(),
      plan: () => {
        if (staged) return null;
        const prepared = storage.prepareMembershipRemoval(address);
        if (!prepared.ok) {
          throw spaceRefused(prepared.code, "", prepared.unreachableUserIds, prepared.blockedWorkstreamIds);
        }
        fences = { spaceRevision: prepared.space.revision, membershipGeneration: prepared.membershipGeneration };
        spaceName = prepared.space.name;
        storage.recordIntent({
          operationId: operationId(),
          kind: "remove",
          spaceId,
          workstreamId,
          spaceRevision: prepared.space.revision,
          membershipGeneration: prepared.membershipGeneration,
          deliveryGeneration: null,
          requestedByUserId: actor.userId,
          notBefore: this.host.intentResumeAt(),
        });
        return null;
      },
      // The membership is `removing` from here, which every list already hides.
      afterPlan: staged ? undefined : async () => {
        release = this.host.holdIntent(operationId());
        this.host.publishSpaceSnapshot();
        await this.host.armNextAlarm();
      },
      settle: () => {
        const space = storage.finalizeMembershipRemoval({ ...address, ...fences! });
        if (space === false) throw spaceRefused("space_not_found", spaceName);
        storage.settleIntent(operationId(), "membership_removed", true);
        return space;
      },
    }).finally(() => (release as (() => void) | null)?.());
    if (!result.ok) return result;
    this.host.publishSpaceSnapshot();
    // The Space is named alongside the Channel: the membership is `removed`
    // by now, so the Channel no longer resolves to the Space it just left.
    this.host.publishMembershipChanged(workstreamId, [spaceId]);
    this.host.deferSpaceMembershipConvergence(actor.workspaceId, workstreamId, true);
    return { ok: true, space: result.value };
  }

  /**
   * One page of an audience change's, an archive's or a restore's walk.
   *
   * Each member Channel is one `changeSource`: retract-then-apply for an
   * audience change, retract for an archive, apply for a restore. The page is
   * recorded on the intent before the answer, so a walk that dies continues
   * from the page it reached. The last page settles the intent (an archive is
   * finalized) and answers with the Space.
   *
   * An archive overlaps up to six member steps and waits for every started
   * one, including the siblings of one that fails, before it moves the cursor.
   */
  async walkPage(actor: SpaceActorAuth, request: {
    spaceId: SpaceId;
    operationId: string;
    kind: SpaceMemberWalkKind;
    cursor: string | null;
    expectedSpaceRevision: number | null;
  }): Promise<WorkspaceSpaceMemberWalkResult> {
    const storage = this.host.spaceStorage();
    const { spaceId, kind } = request;
    // `reaching` for an archive: the prepare flipped every membership to
    // `removing`, so the active set is empty and the Channels whose source is
    // still live are exactly the ones this reads.
    const page = storage.members(actor.userId, spaceId, kind === "archive" ? "reaching" : "active", request.cursor);
    if (page === "not_editable") return { ok: false, refusal: spaceRefused("space_access_denied", "").refusal };
    if (page === false) return { ok: false, refusal: spaceRefused("space_not_found", "").refusal };
    const change: SourceChange = kind === "audience" ? "reapply" : kind === "archive" ? "retract" : "apply";
    let abandoned = false;
    const step = async (member: { workstreamId: WorkstreamId; membershipGeneration: number }) => {
      // Re-read between Channels: a later audience change can accept and
      // overtake this one part way through, and it walks every member itself.
      if (request.expectedSpaceRevision !== null
        && storage.spaceRevision(spaceId) !== request.expectedSpaceRevision) {
        abandoned = true;
        return null;
      }
      const result = await this.changeSource({
        actor,
        spaceId,
        workstreamId: member.workstreamId,
        change,
        operationId: () => `${request.operationId}:${member.workstreamId}`,
        // Archive and restore walks include leftover archived Channels. Their
        // product read answers 404; observe then from the directory.
        archived: kind === "archive" || kind === "restore",
        plan: () => (change === "retract" ? null : {
          space: this.currentSpace(storage, actor.userId, spaceId),
          membershipGeneration: member.membershipGeneration,
        }),
        settle: () => undefined,
      });
      return result.ok ? null : result.refusal;
    };
    const concurrency = kind === "archive" ? SPACE_ARCHIVE_MEMBER_CONCURRENCY : 1;
    for await (const results of settledBatches(page.members, concurrency, step)) {
      for (const result of results) {
        if (result.status === "rejected") return { ok: false, refusal: conversationRefusal(result.reason) };
        if (result.value !== null) return { ok: false, refusal: result.value };
      }
      if (abandoned) break;
    }
    if (abandoned) {
      storage.settleIntent(request.operationId, "audience_superseded", true);
      await this.host.armNextAlarm();
      return this.walked(storage, actor, spaceId, "abandoned");
    }
    if (page.nextCursor !== null) {
      storage.settleIntent(request.operationId, `${kind}_page`, false, Date.now(), page.nextCursor);
      await this.host.armNextAlarm();
      return { ok: true, outcome: "page", cursor: page.nextCursor };
    }
    if (kind === "archive") {
      const archived = await this.host.finalizeArchive(actor.workspaceId, actor.userId, spaceId, request.operationId);
      if (!archived.ok) {
        return {
          ok: false,
          refusal: spaceRefused(archived.code, "", archived.unreachableUserIds, archived.blockedWorkstreamIds).refusal,
        };
      }
      return { ok: true, outcome: "walked", space: archived.space };
    }
    // An audience walk that finished against a Space which moved after it was
    // staged converged on the newer Space, and says so.
    const intent = storage.unsettledIntent(request.operationId);
    const receipt = kind === "restore" ? "restored"
      : intent !== null && intent.spaceRevision !== storage.spaceRevision(spaceId) ? "audience_superseded"
        : "audience_settled";
    storage.settleIntent(request.operationId, receipt, true);
    await this.host.armNextAlarm();
    return this.walked(storage, actor, spaceId, "walked");
  }

  /**
   * Take one step of a staged intent as its requester, through the same path
   * the request takes.
   *
   * An `add`, a `remove` or a `move` is finished; a walk advances one page
   * from the cursor on its row and answers `progressed` while pages remain,
   * so no single resume holds this object for a whole Space.
   *
   * The requester's reach is checked first. Every branch applies this Space's
   * audience as the requester sees it, and somebody taken out of the Space
   * who still reaches it through a Channel in it is shown an empty roster;
   * applying that would withdraw every reader the Space supplies and report
   * success. That, like a missing fence, ends the intent by name: no later
   * attempt gives it back. A `move` is the exception (see `resumeMove`).
   */
  async resume(actor: SpaceActorAuth, intent: WorkspaceSpaceIntentClaim): Promise<WorkspaceSpaceIntentResumeResult> {
    const storage = this.host.spaceStorage();
    const spaceId = intent.spaceId as SpaceId;
    const abandon = async (reason: string): Promise<WorkspaceSpaceIntentResumeResult> => {
      storage.settleIntent(intent.operationId, reason, true);
      await this.host.armNextAlarm();
      return { ok: true, outcome: "abandoned", reason };
    };
    if (intent.kind === "move") return this.resumeMove(actor, intent, abandon);
    const reach = storage.reach(actor.userId, spaceId);
    if (reach === null) return { ok: false, refusal: spaceRefused("space_not_found", "").refusal };
    if (reach === "through_channel") {
      // On the row before the receipt that settles it: the failure is only
      // written while the intent is unsettled.
      storage.recordIntentFailure(intent.operationId, "requester_reach_lost");
      return abandon("requester_reach_lost");
    }
    switch (intent.kind) {
      case "add":
      case "remove": {
        const workstreamId = intent.workstreamId as WorkstreamId | null;
        if (!workstreamId || !intent.membershipGeneration) return abandon(`${intent.kind}_fences_missing`);
        const staged = { spaceRevision: intent.spaceRevision, membershipGeneration: intent.membershipGeneration };
        if (intent.kind === "add" && storage.spaceRevision(spaceId) !== intent.spaceRevision) {
          // Staged against a Space whose audience has since moved; applying
          // the audience it has now would be an add nobody asked for. The plan
          // recorded this add's source with the readers it meant to seat, so
          // the source is withdrawn before the membership is taken back.
          const parent = await this.host.hostedParent(workstreamId, actor.workspaceId);
          if (parent.recordedSpaceSource(spaceId)?.membershipGeneration === intent.membershipGeneration) {
            const withdrawn = await this.changeSource({
              actor, spaceId, workstreamId, change: "retract",
              operationId: () => `${intent.operationId}:superseded`,
              plan: () => null, settle: () => undefined,
            });
            if (!withdrawn.ok) return withdrawn;
          }
          storage.cancelMembership({ workspaceId: actor.workspaceId, userId: actor.userId, spaceId, workstreamId, ...staged });
          storage.cancelIntent(intent.operationId);
          this.host.publishSpaceSnapshot();
          return { ok: true, outcome: "abandoned", reason: "add_superseded" };
        }
        const changed = intent.kind === "add"
          ? await this.addChannel(actor, spaceId, workstreamId, staged)
          : await this.removeChannel(actor, spaceId, workstreamId, staged);
        return changed.ok ? { ok: true, outcome: "settled" } : changed;
      }
      case "audience":
      case "archive":
      case "restore": {
        if (intent.kind === "audience" && storage.spaceRevision(spaceId) !== intent.spaceRevision) {
          // Still an interrupted change: some members carry its roster and the
          // rest do not, so it converges on the Space as it is now.
          logWarn(this.host.env, "space_audience_intent_superseded", {
            workspace_id: actor.workspaceId,
            space_id: spaceId,
            operation_id: intent.operationId,
            staged_revision: intent.spaceRevision,
            current_revision: storage.spaceRevision(spaceId),
          });
        }
        const page = await this.walkPage(actor, {
          spaceId, operationId: intent.operationId, kind: intent.kind, cursor: intent.cursor, expectedSpaceRevision: null,
        });
        if (!page.ok) return page;
        return { ok: true, outcome: page.outcome === "page" ? "progressed" : "settled" };
      }
    }
  }

  /**
   * Finish a stored equal-audience `move`.
   *
   * No code path stages one (`moveSpaceMembership` commits an equal-audience
   * move in one transaction); this finishes the ones in storage. One
   * transaction finishes it the way that call does when the two Spaces still
   * grant the same readers; otherwise the move is taken apart into an add to
   * the target and a removal from the source, each with an intent of its own.
   * If the Channel's provenance was already swapped to the target, the
   * source's record is put back first, so the removal withdraws exactly what
   * the source supplied.
   *
   * The stored intent is the authorization: the requester may have lost reach
   * into either Space after the swap committed, and that must not strand a
   * move they were allowed to make.
   */
  private async resumeMove(
    actor: SpaceActorAuth,
    intent: WorkspaceSpaceIntentClaim,
    abandon: (reason: string) => Promise<WorkspaceSpaceIntentResumeResult>,
  ): Promise<WorkspaceSpaceIntentResumeResult> {
    const workstreamId = intent.workstreamId as WorkstreamId | null;
    const sourceSpaceId = intent.sourceSpaceId as SpaceId | null;
    const sourceSpaceRevision = intent.sourceSpaceRevision;
    const sourceMembershipGeneration = intent.sourceMembershipGeneration;
    if (!workstreamId || !intent.membershipGeneration || !sourceSpaceId || !sourceSpaceRevision
      || !sourceMembershipGeneration) {
      return abandon("move_fences_missing");
    }
    const targetSpaceId = intent.spaceId as SpaceId;
    const storage = this.host.spaceStorage();
    let parent: HostedParent;
    let observed: { channel: ObservedChannel; title: string };
    try {
      parent = await this.host.hostedParent(workstreamId, actor.workspaceId);
      observed = await this.observe(this.client(actor, workstreamId), workstreamId, true);
    } catch (error) {
      return { ok: false, refusal: conversationRefusal(error) };
    }
    const address = { workspaceId: actor.workspaceId, parentId: workstreamId };
    const outcome = await this.host.transaction(() => storage.resumeStagedMove({
      operationId: intent.operationId,
      userId: intent.requestedByUserId,
      sourceSpaceId,
      targetSpaceId,
      workstreamId,
      sourceMembershipGeneration,
      targetMembershipGeneration: intent.membershipGeneration!,
    }, {
      swap: (fences) => parent.replaceEquivalentSpaceAccessSource({
        ...address, sourceSpaceId, targetSpaceId, ...fences,
        operationId: stableUuidSync([intent.operationId, "swap", fences.sourceSpaceRevision, fences.targetSpaceRevision]),
      }).ok,
      restore: () => {
        if (parent.recordedSpaceSource(sourceSpaceId)) return;
        const swapped = parent.recordedSpaceSource(targetSpaceId);
        if (!swapped) return;
        parent.confirmSpaceAccessSource({
          ...address,
          spaceId: sourceSpaceId,
          operationId: stableUuidSync([intent.operationId, "restore"]),
          seatedUserIds: swapped.suppliedUserIds,
          source: {
            scope: swapped.scope,
            participantUserIds: swapped.participantUserIds,
            spaceRevision: sourceSpaceRevision,
            membershipGeneration: sourceMembershipGeneration,
            channel: observed.channel,
          },
        });
      },
    }));
    if (outcome === "superseded") return { ok: true, outcome: "abandoned", reason: "move_superseded" };
    this.host.publishSpaceSnapshot();
    if (outcome === "moved") {
      this.host.publishMembershipChanged(workstreamId, [sourceSpaceId, targetSpaceId]);
      this.host.deferSpaceMembershipConvergence(actor.workspaceId, workstreamId, true);
      await this.host.afterSidekickDefaultsApplied(storage, actor.workspaceId);
      return { ok: true, outcome: "settled" };
    }
    const added = await this.addChannel(actor, targetSpaceId, workstreamId, null);
    if (!added.ok) return added;
    const removed = await this.removeChannel(actor, sourceSpaceId, workstreamId, null);
    return removed.ok ? { ok: true, outcome: "settled" } : removed;
  }

  /**
   * One change to one Space's source on one Channel: plan in one transaction,
   * the Channel's canonical operations, then confirm and settle in another.
   *
   * `plan` runs first inside the plan transaction and names the Space whose
   * audience is applied (`null` for a pure retraction). `settle` runs inside
   * the confirming transaction. `abandon` undoes what `plan` staged when the
   * change will not finish; without it a failure leaves the staged intent for
   * the alarm.
   *
   * `operationId` names the intent this change belongs to and is read once
   * `plan` has run. The retraction and the application are recorded under
   * ids derived from it, so the same change resumed replays the plans the
   * first attempt committed; `null` (a rollback, which has no intent behind
   * it) plans afresh. The application's id carries the Space revision it
   * applies, and so does a re-application's retraction: a walk resumed after
   * the Space moved retracts the source as it stands now rather than
   * replaying a retraction of the one before.
   */
  private async changeSource<T>(input: {
    actor: SpaceActorAuth;
    spaceId: SpaceId;
    workstreamId: WorkstreamId;
    change: SourceChange;
    operationId: () => string | null;
    archived?: boolean;
    plan: () => PlannedSource | null;
    afterPlan?: (() => Promise<void>) | undefined;
    settle: () => T;
    abandon?: () => void;
  }): Promise<ChangeOutcome<T>> {
    const { actor, spaceId, workstreamId, change } = input;
    const client = this.client(actor, workstreamId);
    let observation: { channel: ObservedChannel; title: string; archived: boolean };
    let parent: HostedParent;
    try {
      observation = await this.observe(client, workstreamId, change === "retract" || (input.archived ?? false));
      parent = await this.host.hostedParent(workstreamId, actor.workspaceId);
    } catch (error) {
      return { ok: false, refusal: conversationRefusal(error) };
    }
    const address = { workspaceId: actor.workspaceId, parentId: workstreamId };
    const title = observation.title;
    let planned: {
      retraction: { plan: SpaceAccessRetraction; remaining: ChannelAccessSources["spaces"] } | null;
      application: { plan: SpaceAccessApplication; source: ConfirmedAccessSource } | null;
    };
    try {
      planned = await this.host.transaction(() => {
        const source = input.plan();
        const intentId = input.operationId();
        const step = (name: string) => (intentId === null ? uuidV7() : stableUuidSync([intentId, name]));
        let channel = observation.channel;
        let retraction: typeof planned.retraction = null;
        if (change !== "apply") {
          const retracted = parent.retractSpaceAccessSource({
            ...address,
            spaceId,
            operationId: step(change === "reapply" && source ? `retract:${source.space.revision}` : "retract"),
            // A convergence that retracts in order to re-apply has to lose to
            // a newer one: this deletes the row the application fences on.
            ...(change === "reapply" && source ? { expectedSpaceRevision: source.space.revision } : {}),
            channel,
          });
          if (!retracted.ok) throw channelRefused(retracted.code, title);
          // Read after the retraction, so these are the sources that survive
          // it, and attributed now, before any survivor is seated: a crash
          // between the two leaves an attribution the resume re-seats rather
          // than a seat nobody accounts for.
          const remaining = parent.readPersistedSpaceAccessSources(address);
          for (const supplied of survivorAttributions(retracted.plan, remaining)) {
            const attributed = parent.confirmSpaceAccessSource({
              ...address, spaceId: supplied.spaceId, operationId: uuidV7(), seatedUserIds: supplied.userIds,
            });
            if (!attributed.ok) {
              logWarn(this.host.env, "channel_retraction_attribution_refused", {
                workstream_id: workstreamId, space_id: supplied.spaceId, code: attributed.code,
              });
            }
          }
          retraction = { plan: retracted.plan, remaining };
          channel = observedAfterRetraction(channel, retracted.plan);
        }
        let application: typeof planned.application = null;
        if (change !== "retract") {
          if (!source) throw new Error("space_source_application_unplanned");
          const applied = {
            scope: source.space.scope,
            participantUserIds: source.space.participants.map((participant) => participant.userId),
            spaceRevision: source.space.revision,
            membershipGeneration: source.membershipGeneration,
          };
          // Committed with the readers it plans to seat, so whatever a crash
          // leaves seated is already attributed to this Space: a resume that
          // gives the change up withdraws them, and one that finishes it
          // confirms them.
          const plannedApplication = parent.applySpaceAccessSource({
            ...address, spaceId, ...applied, operationId: step(`apply:${applied.spaceRevision}`), channel,
            commitWithPlan: true,
          });
          if (!plannedApplication.ok) throw channelRefused(plannedApplication.code, title);
          application = { plan: plannedApplication.plan, source: { ...applied, channel } };
        }
        return { retraction, application };
      });
    } catch (error) {
      if (error instanceof SpaceSourceRefused) return { ok: false, refusal: error.refusal };
      throw error;
    }
    await input.afterPlan?.();

    let seated: UserId[] = [];
    try {
      // An archived Channel's conversation refuses every product mutation.
      // The hosted-parent source is the authority that still has to move;
      // seating and narrowing wait until the Channel is live again.
      if (planned.retraction && !observation.archived) {
        await runSpaceSourceRetraction({
          env: this.host.env,
          workspaceId: asWorkspaceId(actor.workspaceId),
          workstreamId,
          client,
          spaceId,
          plan: planned.retraction.plan,
          remaining: planned.retraction.remaining,
        });
      }
      if (planned.application && !observation.archived) {
        seated = await runSpaceSourceApplication(client, spaceId, planned.application.plan);
      }
    } catch (error) {
      if (!(error instanceof SpaceSourceApplicationInterrupted) || !planned.application) {
        return { ok: false, refusal: conversationRefusal(error) };
      }
      await this.rollbackApplication(actor, parent, spaceId, workstreamId, error.seated, planned.application.source);
      if (input.abandon) await this.host.transaction(input.abandon);
      if (asApiError(error.cause)?.code === "workstream_audience_restricted_content") {
        return { ok: false, refusal: channelRefused("space_membership_content_fence", title).refusal };
      }
      return { ok: false, refusal: conversationRefusal(error.cause) };
    }

    let superseded = false;
    try {
      const value = await this.host.transaction(() => {
        if (planned.application) {
          const confirmed = parent.confirmSpaceAccessSource({
            ...address,
            spaceId,
            operationId: uuidV7(),
            seatedUserIds: seated,
            source: planned.application.source,
          });
          if (!confirmed.ok) {
            superseded = true;
            throw channelRefused(confirmed.code, title);
          }
        }
        return input.settle();
      });
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof SpaceSourceRefused)) throw error;
      if (planned.application) {
        // A newer source replaced this one: only the seats nothing now
        // accounts for are withdrawn. Otherwise this change's own source is
        // still the recorded one, and it is withdrawn whole.
        if (superseded) await this.withdrawUnconfirmedSeats(actor, client, parent, workstreamId, spaceId, seated);
        else await this.rollbackApplication(actor, parent, spaceId, workstreamId, seated, planned.application.source);
      }
      if (input.abandon) await this.host.transaction(input.abandon);
      return { ok: false, refusal: error.refusal };
    }
  }

  /**
   * What the Channel's readers are, from the conversation that owns them.
   *
   * An archived Channel's product read answers 404; a retraction, a restore,
   * and the cutover placing an archived Channel, read the directory's
   * projection of it instead. `archived` is true only on that fallback, which
   * is also the signal that conversation seating and narrowing must not run.
   */
  private async observe(
    client: WorkstreamObjectClient,
    workstreamId: string,
    archivedAllowed: boolean,
  ): Promise<{ channel: ObservedChannel; title: string; archived: boolean }> {
    try {
      const detail = await client.get();
      return { channel: observedOf(detail), title: detail.title, archived: false };
    } catch (error) {
      if (!archivedAllowed || asApiError(error)?.status !== 404) throw error;
      const projected = this.host.archivedChannel(workstreamId);
      if (!projected) throw error;
      return { ...projected, archived: true };
    }
  }

  /**
   * Withdraw what an interrupted or refused application committed and seated.
   *
   * The source is confirmed first with the readers actually seated (a replayed
   * plan does not commit it again), then withdrawn through the ordinary
   * retraction, so a reader another Space also supplies survives a rollback
   * exactly as it survives a removal, and a widening made before the first
   * seat failed is narrowed back. Best effort: the refusal the caller is about
   * to see is the useful one, and a cleanup that could not finish is named so
   * the leftover source can be found.
   */
  private async rollbackApplication(
    actor: SpaceActorAuth,
    parent: HostedParent,
    spaceId: SpaceId,
    workstreamId: WorkstreamId,
    seated: readonly UserId[],
    source: ConfirmedAccessSource,
  ): Promise<void> {
    try {
      await this.host.transaction(() => parent.confirmSpaceAccessSource({
        workspaceId: actor.workspaceId,
        parentId: workstreamId,
        spaceId,
        operationId: uuidV7(),
        seatedUserIds: [...seated],
        source,
      }));
      const retracted = await this.changeSource({
        actor, spaceId, workstreamId, change: "retract", operationId: () => null,
        plan: () => null, settle: () => undefined,
      });
      if (!retracted.ok) throw new Error(retracted.refusal.code);
    } catch (error) {
      logWarn(this.host.env, "space_access_rollback_failed", {
        workstream_id: workstreamId,
        space_id: spaceId,
        reason: diagnosticErrorCode(error, "space_access_rollback_failed"),
      });
    }
  }

  /**
   * Remove readers this attempt seated after its confirmation lost a fence.
   *
   * A newer source for this Space replaced the one this attempt committed, so
   * nothing of this attempt's is left to retract. Every reader the sources
   * that did win still name is kept; only the now-unowned seats are withdrawn.
   */
  private async withdrawUnconfirmedSeats(
    actor: SpaceActorAuth,
    client: WorkstreamObjectClient,
    parent: HostedParent,
    workstreamId: WorkstreamId,
    spaceId: SpaceId,
    seated: readonly UserId[],
  ): Promise<void> {
    if (seated.length === 0) return;
    try {
      const observed = await this.observe(client, workstreamId, false);
      const current = parent.readAccessSources({
        workspaceId: actor.workspaceId, parentId: workstreamId, channel: observed.channel,
      });
      const retained = new Set<string>(effectiveChannelAudience({
        direct: current.direct,
        sources: current.spaces.map((space) => ({
          sourceId: space.spaceId, scope: space.scope, participantUserIds: space.participantUserIds,
        })),
      }).participantUserIds);
      for (const userId of seated) {
        if (retained.has(userId)) continue;
        await client.removeParticipant(userId, { spaceSourceId: spaceId });
      }
    } catch (error) {
      logWarn(this.host.env, "space_access_unconfirmed_seating_rollback_failed", {
        workstream_id: workstreamId,
        space_id: spaceId,
        reason: diagnosticErrorCode(error, "space_access_unconfirmed_seating_rollback_failed"),
      });
    }
  }

  /**
   * The Space whose audience is applied, as the actor sees it, refusing a view
   * that is not the Organization's answer.
   *
   * A `through_channel` view's roster is empty by design; applying it would
   * withdraw every reader this Space supplies and report success.
   */
  private currentSpace(storage: WorkspaceSpaceStorage, userId: string, spaceId: SpaceId): SpaceSummary {
    const space = storage.readable(userId, spaceId);
    if (space === false) throw spaceRefused("space_not_found", "");
    if (space.reach === "through_channel") throw spaceRefused("space_access_denied", space.name);
    return space;
  }

  private walked(
    storage: WorkspaceSpaceStorage,
    actor: SpaceActorAuth,
    spaceId: SpaceId,
    outcome: "walked" | "abandoned",
  ): WorkspaceSpaceMemberWalkResult {
    const space = storage.readable(actor.userId, spaceId);
    if (space === false) return { ok: false, refusal: spaceRefused("space_not_found", "").refusal };
    return { ok: true, outcome, space };
  }

  /** The Channel's conversation, as the person this operation acts for. */
  private client(actor: SpaceActorAuth, workstreamId: string): WorkstreamObjectClient {
    const { principal, ...session } = actor;
    return new WorkstreamObjectClient(this.host.env, principal ? { ...session, principal } : session, workstreamId);
  }
}
