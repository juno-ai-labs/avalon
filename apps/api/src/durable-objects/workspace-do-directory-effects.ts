import {
  asAutomationId,
  asWorkspaceId,
  WorkspaceAttentionSchema,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";

import { connectorRegistryForEnv } from "../lib/connector-registry";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { WorkspaceDoProduct } from "./workspace-do-product";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import {
  applyWorkspaceDirectoryEnvelope,
  listWorkspaceDirectory,
} from "./workspace-directory-storage";
import {
  advanceWorkspaceBatchDispatch,
  archiveWorkspaceNotesForBatch,
  beginWorkspaceBatchDispatch,
  workspaceBatchTargetIds,
} from "./workspace-batch-dispatch-storage";
import { epoch } from "./workspace-projection";
import { automationAgentName } from "./names";
import {
  WorkspaceDirectoryApplyRequestSchema,
  WorkspaceAttentionRequestSchema,
  WorkspaceDirectoryBatchTargetsRequestSchema,
  WorkspaceDirectoryBatchTargetsResultSchema,
  WorkspaceBatchDispatchAdvanceRequestSchema,
  WorkspaceBatchDispatchBeginRequestSchema,
  WorkspaceBatchNoteArchiveRequestSchema,
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryListRequestSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceRegionalEffectApplyRequestSchema,
  WorkspaceRegionalEffectApplyResultSchema,
  type WorkspaceDirectoryApplyRequest,
  type WorkspaceAttentionRequest,
  type WorkspaceAttentionResult,
  type WorkspaceDirectoryBatchTargetsRequest,
  type WorkspaceBatchDispatchAdvanceRequest,
  type WorkspaceBatchDispatchBeginRequest,
  type WorkspaceBatchNoteArchiveRequest,
  type WorkspaceBatchNoteArchiveResult,
  type WorkspaceDirectoryApplyResult,
  type WorkspaceDirectoryListRequest,
  type WorkspaceDirectoryPage,
  type WorkspaceRegionalEffectApplyRequest,
  type WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import {
  workspaceNoteBatchTargets,
} from "./workspace-notes-storage";
import {
  applyWorkstreamRegionalEnvelope,
} from "./workspace-regional-effect-storage";
import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentMaintenanceRequestSchema,
  WorkspaceNotificationIntentMaintenanceTargetSchema,
  WorkspaceNotificationIntentReapRequestSchema,
  WorkspaceNotificationIntentReapResultSchema,
  WorkspaceNotificationIntentRequestSchema,
  WorkspaceNotificationIntentTransitionRequestSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentClaimResult,
  type WorkspaceNotificationIntentMaintenanceRequest,
  type WorkspaceNotificationIntentMaintenanceTarget,
  type WorkspaceNotificationIntentReapRequest,
  type WorkspaceNotificationIntentReapResult,
  type WorkspaceNotificationIntentRequest,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "./workspace-notification-intent-protocol";
import {
  claimWorkspaceNotificationIntent as claimStoredWorkspaceNotificationIntent,
  reapSettledWorkspaceNotificationIntents as reapStoredWorkspaceNotificationIntents,
  transitionWorkspaceNotificationIntent as transitionStoredWorkspaceNotificationIntent,
  workspaceNotificationIntentMaintenanceTarget as storedWorkspaceNotificationIntentMaintenanceTarget,
} from "./workspace-notification-intent-storage";

/**
 * `WorkspaceDO`'s write side of the work-stream directory: the regional effects a
 * WorkstreamDO commits through it, notification intents, attention, and bulk
 * operations.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoDirectoryEffects extends WorkspaceDoProduct {

  /** Commit WorkstreamDO-owned facts into the workspace's authoritative directory. */
  async applyWorkstreamDirectoryEffects(
    input: WorkspaceDirectoryApplyRequest,
  ): Promise<WorkspaceDirectoryApplyResult> {
    await this.initialized;
    const request = WorkspaceDirectoryApplyRequestSchema.parse(input);
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    const userIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_user" ? [envelope.effect.userId] : []
    )))];
    const activeUsers = new Set<string>();
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
      ).bind(request.workspaceId, ...userIds).all<{ user_id: string }>();
      for (const member of members.results ?? []) activeUsers.add(member.user_id);
    }
    const subscriptionIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_common" && envelope.effect.automationSubscriptionId
        ? [envelope.effect.automationSubscriptionId]
        : []
    )))];
    const originLabels = new Map<string, string>();
    if (subscriptionIds.length > 0) {
      const placeholders = subscriptionIds.map(() => "?").join(",");
      const labels = this.state.storage.sql.exec<{ id: string; name: string }>(
        `SELECT automation_id AS id, title AS name
           FROM automation_directory
          WHERE workspace_id = ? AND automation_id IN (${placeholders})`,
        request.workspaceId,
        ...subscriptionIds,
      ).toArray();
      for (const label of labels) {
        originLabels.set(label.id, truncateUtf16Safe(label.name, 120));
      }
    }
    let directoryChanged = false;
    const commonChanges = new Set<string>();
    const watchReconciliations = new Map<string, {
      authorityGeneration: number;
      projectionVersion: number;
      sourceHash: string;
    }>();
    const automationRunProjections = new Map<string, {
      automationId: string;
      runId: string;
      workstreamId: string;
      workstreamGeneration: number;
      sourceVersion: number;
      payloadHash: string;
      state: string;
      completedAt: number | null;
    }>();
    const viewerChanges = new Map<string, Set<string>>();
    const accepted: WorkspaceDirectoryApplyResult["accepted"] = [];
    for (const envelope of request.envelopes) {
      const applied = applyWorkspaceDirectoryEnvelope(this.state.storage, envelope, activeUsers, originLabels);
      directoryChanged = directoryChanged || applied.changed;
      if (applied.changed && envelope.effect.kind === "directory_common") {
        commonChanges.add(envelope.workstreamId);
      } else if (applied.changed && envelope.effect.kind === "directory_user") {
        if (applied.participantMembershipChanged) {
          // The facepile is the whole participant set. A join or leave that
          // only reached the affected viewer's socket would leave everyone
          // else's pile stale until reconnect.
          commonChanges.add(envelope.workstreamId);
        } else {
          const users = viewerChanges.get(envelope.workstreamId) ?? new Set<string>();
          users.add(envelope.effect.userId);
          viewerChanges.set(envelope.workstreamId, users);
        }
      }
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(`SELECT authority_generation, waterline, payload_hash
              FROM workspace_workstream_directory WHERE workstream_id = ?`,
        envelope.workstreamId).toArray()[0];
        // Reconcile on an exact replay as well as the first application. The
        // directory row and registration replacement are separate durable
        // transactions, so a failed connector lookup must be recoverable by
        // replaying the same outbox envelope.
        if (current
          && current.authority_generation === envelope.generation
          && current.waterline === envelope.sourceVersion
          && current.payload_hash === envelope.payloadHash) {
          watchReconciliations.set(envelope.workstreamId, {
            authorityGeneration: envelope.generation,
            projectionVersion: envelope.sourceVersion,
            sourceHash: envelope.payloadHash,
          });
          const durableAutomation = envelope.effect.automationSubscriptionId
            ? this.state.storage.sql.exec<{ one: number }>(
                `SELECT 1 AS one FROM automation_directory WHERE automation_id = ?`,
                envelope.effect.automationSubscriptionId,
              ).toArray()[0]
            : null;
          if (durableAutomation && envelope.effect.automationSubscriptionId && envelope.effect.automationRunId) {
            automationRunProjections.set(envelope.effect.automationRunId, {
              automationId: envelope.effect.automationSubscriptionId,
              runId: envelope.effect.automationRunId,
              workstreamId: envelope.workstreamId,
              workstreamGeneration: envelope.generation,
              sourceVersion: envelope.sourceVersion,
              payloadHash: envelope.payloadHash,
              state: envelope.effect.state,
              completedAt: epoch(envelope.effect.completedAt),
            });
          }
        }
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    await Promise.all([...watchReconciliations].map(([workstreamId, coordinate]) => (
      this.reconcileWorkstreamResourceRegistrations({
        workspaceId: request.workspaceId,
        workstreamId,
        ...coordinate,
      })
    )));
    // One automation's refusal must not fail the batch. These envelopes are
    // already accepted above — the directory rows are written, and this hop is
    // the copy each automation keeps of its own run. Letting a rejection
    // propagate out of the `Promise.all` fails every envelope in the batch,
    // which is then redelivered with the same payload and fails the same way:
    // one automation the agent cannot parse for stalls the directory for all
    // of them, permanently. Each projection is carried on its own and its
    // failure logged, so the automation that could not be reached is the only
    // one that falls behind, and it catches up on its next projection.
    const runProjections = await Promise.allSettled(
      [...automationRunProjections.values()].map(async (projection) => {
        const automationId = asAutomationId(projection.automationId);
        const agent = await durableObjectStubForWorkspace(
          this.env,
          this.env.AUTOMATION_AGENTS,
          request.workspaceId,
          automationAgentName(this.env.AVALON_REGION, asWorkspaceId(request.workspaceId), automationId),
        );
        await agent.applyRunProjection({
          schemaVersion: 1,
          workspaceId: request.workspaceId,
          ...projection,
        });
      }),
    );
    for (const settled of runProjections) {
      if (settled.status !== "rejected") continue;
      logWarn(this.env, "automation_run_projection_failed", {
        workspace_id: request.workspaceId,
        code: diagnosticErrorCode(settled.reason, "automation_run_projection_failed"),
      });
    }
    if (commonChanges.size > 0) {
      // A `directory_common` effect is the only writer of
      // `next_terminal_action_at`, and it arrives outside any alarm — off the
      // Queue — so a sandbox deadline created or moved here would otherwise
      // wait for an unrelated target to reconcile before anything armed it.
      await this.refreshTerminalSchedule();
    }
    if (request.envelopes.some((envelope) => (
      envelope.effect.kind === "directory_common"
      && (envelope.effect.resourceLinks?.length ?? 0) > 0
    ))) {
      await this.refreshSchedule(request.workspaceId);
    }
    if (directoryChanged) {
      // Scope, participant, generation, and archival effects can invalidate a
      // foreground attachment without another client focus event. Rebuild now,
      // before the async state publications yield, so removed viewers neither
      // contribute to nor receive the next presence snapshot.
      this.broadcastPresence();
      await Promise.all([
        ...commonChanges,
      ].map((workstreamId) => this.publishWorkstreamState(workstreamId)));
      await Promise.all([...viewerChanges].flatMap(([workstreamId, users]) => (
        commonChanges.has(workstreamId)
          ? []
          : [...users].map((userId) => this.publishWorkstreamState(workstreamId, userId))
      )));
    }
    return WorkspaceDirectoryApplyResultSchema.parse({ accepted, directoryChanged });
  }

  /**
   * Turn authoritative watched links into exact typed registrations. The work
   * stream projects only the link intent; WorkspaceDO resolves resource and
   * connector facts and uses the same replacement engine as automations.
   */
  private async reconcileWorkstreamResourceRegistrations(input: {
    workspaceId: string;
    workstreamId: string;
    authorityGeneration: number;
    projectionVersion: number;
    sourceHash: string;
  }): Promise<void> {
    const linkedResources = this.state.storage.sql.exec<{
      resource_id: string;
      watch_enabled: number;
      connection_id: string | null;
      resource_type: string | null;
    }>(`SELECT link.resource_id, link.watch_enabled, resource.connection_id, resource.resource_type
          FROM workspace_workstream_resource_links link
          LEFT JOIN resources resource ON resource.id = link.resource_id
         WHERE link.workstream_id = ?
         ORDER BY link.resource_id`, input.workstreamId).toArray();
    const linkedById = new Map(linkedResources.map((resource) => [resource.resource_id, resource]));
    const destinationResourceIds = new Set([
      ...linkedById.keys(),
      ...this.state.storage.sql.exec<{ destination_resource_id: string }>(
        `SELECT DISTINCT destination_resource_id
           FROM workspace_external_event_registrations
          WHERE destination_kind = 'workstream_resource_update'
            AND workstream_id = ? AND destination_resource_id IS NOT NULL`,
        input.workstreamId,
      ).toArray().map((row) => row.destination_resource_id),
    ]);
    if (destinationResourceIds.size === 0) return;
    const connections = this.state.storage.sql.exec<{
      id: string;
      connector_type: string;
      status: string;
    }>(`SELECT id, connector_type, status FROM connector_connections WHERE workspace_id = ?`, input.workspaceId)
      .toArray();
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const manifests = new Map(connectorRegistryForEnv(this.env).list().map((manifest) => [manifest.type, manifest]));

    for (const resourceId of destinationResourceIds) {
      const resource = linkedById.get(resourceId);
      const connection = resource?.connection_id ? connectionsById.get(resource.connection_id) : undefined;
      const manifest = connection ? manifests.get(connection.connector_type) : undefined;
      const descriptors = resource?.watch_enabled === 1
        && resource.resource_type
        && connection?.status === "active"
        && manifest?.supportsWatches
        ? manifest.activityTriggers.filter((descriptor) => descriptor.resourceRelationships.some(
            (relationship) => relationship.resourceType === resource.resource_type,
          ))
        : [];
      await this.applyExternalEventRegistrations({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        destination: {
          kind: "workstream_resource_update",
          workstreamId: input.workstreamId,
          substreamId: "0",
          resourceId,
        },
        authorityGeneration: input.authorityGeneration,
        projectionVersion: input.projectionVersion,
        sourceHash: input.sourceHash,
        evaluators: descriptors.map((descriptor) => ({
          evaluatorId: uuidV7(),
          source: {
            connectorType: connection!.connector_type,
            connectionId: connection!.id,
            eventType: descriptor.eventType,
            resourceId,
          },
          when: { kind: "always" },
        })),
      });
    }
  }

  /**
   * Apply one WorkstreamDO activity/mention effect and its replay receipt in a
   * single transaction. The caller resolves current D1 identity (actor, target
   * membership, mention recipient) before the call; the object never reaches
   * back into the regional database mid-transaction, and the receipt can never
   * commit without the product row it acknowledges.
   */
  async applyWorkstreamRegionalEffect(
    input: WorkspaceRegionalEffectApplyRequest,
  ): Promise<WorkspaceRegionalEffectApplyResult> {
    await this.initialized;
    const request = WorkspaceRegionalEffectApplyRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = applyWorkstreamRegionalEnvelope(this.state.storage, request, Date.now());
    if (!result.replayed && request.envelope.effect.kind === "activity_event") {
      await this.refreshProductAlarm();
    }
    return WorkspaceRegionalEffectApplyResultSchema.parse(result);
  }

  /** Claim one notification intent without exposing SQL or physical write counters. */
  async claimWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentRequest,
  ): Promise<WorkspaceNotificationIntentClaimResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentClaimResultSchema.parse(
      claimStoredWorkspaceNotificationIntent(
        this.state.storage,
        request,
        uuidV7(),
        Date.now(),
      ),
    );
    logInfo(this.env, "workstream_notification_intent_claim", {
      workspace_id: request.workspaceId,
      notification_intent_id: request.intentId,
      workstream_id: result.outcome === "missing" ? null : result.intent.workstreamId,
      recipient_user_id: result.outcome === "missing" ? null : result.intent.recipientUserId,
      kind: result.outcome === "missing" ? null : result.intent.notificationKind,
      state: result.outcome === "missing" ? null : result.intent.state,
      lease_id: result.outcome === "claimed" ? result.leaseId : null,
      outcome: result.outcome,
    });
    // A terminal replay can mean the earlier settle committed and its
    // post-commit schedule refresh failed. Reconcile here so that failure
    // cannot strand the terminal receipt past its retention window.
    if (result.outcome === "terminal") await this.refreshSchedule(request.workspaceId);
    return result;
  }

  /** Apply one lease-fenced notification lifecycle transition. */
  async transitionWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentTransitionRequest,
  ): Promise<WorkspaceNotificationIntentTransitionResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentTransitionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentTransitionResultSchema.parse(
      transitionStoredWorkspaceNotificationIntent(this.state.storage, request, Date.now()),
    );
    logInfo(this.env, "workstream_notification_intent_transition", {
      workspace_id: request.workspaceId,
      notification_intent_id: request.intentId,
      lease_id: request.leaseId,
      transition: request.transition,
      requested_state: request.transition === "settle" ? request.state : null,
      error_code: request.transition === "settle" ? null : request.errorCode,
      current_state: result.outcome === "lease_lost" ? result.state : null,
      outcome: result.outcome,
    });
    if (
      request.transition === "settle"
      && (result.outcome === "applied"
        || (result.outcome === "lease_lost"
          && (result.state === "delivered" || result.state === "skipped")))
    ) {
      await this.refreshSchedule(request.workspaceId);
    }
    return result;
  }

  /** Derive the retention alarm target from terminal notification receipts. */
  async notificationIntentMaintenanceTarget(
    input: WorkspaceNotificationIntentMaintenanceRequest,
  ): Promise<WorkspaceNotificationIntentMaintenanceTarget> {
    await this.initialized;
    const request = WorkspaceNotificationIntentMaintenanceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceNotificationIntentMaintenanceTargetSchema.parse(
      storedWorkspaceNotificationIntentMaintenanceTarget(this.state.storage, request.workspaceId),
    );
  }

  /** Reap terminal notification receipts and return exact deleted identities. */
  async reapSettledWorkstreamNotificationIntents(
    input: WorkspaceNotificationIntentReapRequest,
  ): Promise<WorkspaceNotificationIntentReapResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentReapRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentReapResultSchema.parse(
      reapStoredWorkspaceNotificationIntents(this.state.storage, request, Date.now()),
    );
    logInfo(this.env, "workstream_notification_intent_reap", {
      workspace_id: request.workspaceId,
      reaped_intent_ids: result.reapedIntentIds,
      reaped_count: result.reapedIntentIds.length,
      outcome: result.reapedIntentIds.length > 0 ? "deleted" : "empty",
    });
    return result;
  }

  async listWorkstreams(input: WorkspaceDirectoryListRequest): Promise<WorkspaceDirectoryPage> {
    await this.initialized;
    const request = WorkspaceDirectoryListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryPageSchema.parse(listWorkspaceDirectory(this.state.storage, request));
  }

  /**
   * Summarize member attention from the authoritative workspace directory.
   * Each work stream contributes at most once even when several reasons apply.
   */
  async attention(input: WorkspaceAttentionRequest): Promise<WorkspaceAttentionResult> {
    await this.initialized;
    const request = WorkspaceAttentionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      waiting_for_you: number;
      waiting_priority: number;
      has_unread_activity: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE
           WHEN viewer.is_participant = 1 AND (
             viewer.latest_mention_attention_ordinal > viewer.seen_attention_ordinal
             OR viewer.unseen = 1
             OR directory.exact_state = 'needs_input'
           ) THEN 1 ELSE 0 END), 0) AS waiting_for_you,
         COALESCE(MAX(CASE
           WHEN viewer.is_participant = 1
            AND viewer.latest_mention_attention_ordinal > viewer.seen_attention_ordinal THEN 3
           WHEN viewer.is_participant = 1 AND directory.exact_state = 'needs_input' THEN 2
           WHEN viewer.is_participant = 1 AND viewer.unseen = 1 THEN 1
           ELSE 0 END), 0) AS waiting_priority,
         COALESCE(MAX(CASE
           WHEN (directory.scope = 'workspace' OR viewer.is_participant = 1) AND (
             directory.latest_attention_ordinal > COALESCE(
               viewer.seen_attention_ordinal,
               directory.unread_tracking_start_ordinal
             )
             OR viewer.manual_unread_from_ordinal IS NOT NULL
             OR viewer.unseen = 1
           ) THEN 1 ELSE 0 END), 0) AS has_unread_activity
       FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND directory.origin_type <> 'automation'
         AND directory.system_kind IS NULL`,
      request.userId,
    ).one();
    const waitingReason = row.waiting_priority === 3
      ? "mentioned"
      : row.waiting_priority === 2
        ? "needs_input"
        : row.waiting_priority === 1
          ? "unseen"
          : null;
    return WorkspaceAttentionSchema.parse({
      waitingForYou: row.waiting_for_you,
      waitingReason,
      hasUnreadActivity: row.has_unread_activity === 1,
    });
  }

  /**
   * Resolve a generic member-visible filter once, inside the object that owns
   * the cross-work-stream index. The caller turns each returned work-stream id
   * into one Queue event; it never probes child objects to rediscover this
   * list.
   *
   * The notes the same filter selects come back beside them because they are
   * in this database too. They are counted here and archived here — see
   * `archiveNotesForBatch` — rather than fanned out, since a note has no object
   * of its own for an event to reach.
   */
  async batchUpdateTargets(input: WorkspaceDirectoryBatchTargetsRequest) {
    await this.initialized;
    const request = WorkspaceDirectoryBatchTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryBatchTargetsResultSchema.parse({
      items: workspaceBatchTargetIds(this.state.storage, request.userId, request.filter),
      noteIds: workspaceNoteBatchTargets(
        this.state.storage,
        request.workspaceId,
        request.userId,
        request.filter,
      ),
    });
  }

  /** Freeze one target set and return only the Queue events not yet published. */
  async beginWorkstreamBatchDispatch(input: WorkspaceBatchDispatchBeginRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchBeginRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return beginWorkspaceBatchDispatch(this.state.storage, request);
  }

  /** Persist one successful Queue sendBatch chunk; redelivery is a no-op. */
  async advanceWorkstreamBatchDispatch(input: WorkspaceBatchDispatchAdvanceRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchAdvanceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return advanceWorkspaceBatchDispatch(this.state.storage, request);
  }

  /**
   * Archive the note half of one frozen batch, exactly once per operation.
   *
   * The work-stream half is frozen as rows because each id has to survive a
   * partial Queue publication and be re-sent without re-selecting. Notes need
   * no such list: they are archived in one statement in this database, so the
   * only thing a retry can get wrong is *widening* — a note touched between the
   * failed attempt and the retry entering an open-ended range like "Last hour".
   * A single count on the dispatch row closes that, and a `NULL` there is the
   * whole of "no note archive has run for this operation".
   *
   * Fenced on the same request hash and user as the dispatch it belongs to, so
   * a second filter or a second person cannot reuse an operation id to archive
   * somebody else's notes under a receipt that already exists.
   */
  async archiveNotesForBatch(
    input: WorkspaceBatchNoteArchiveRequest,
  ): Promise<WorkspaceBatchNoteArchiveResult> {
    await this.initialized;
    const request = WorkspaceBatchNoteArchiveRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = archiveWorkspaceNotesForBatch(this.state.storage, request);
    // After the commit, and only for the call that did the archiving: the push
    // sends the list as it stands now, which a replay has already sent.
    if (!result.replayed && result.archivedNoteCount > 0) this.publishSidebarList("notes");
    return result;
  }
}
