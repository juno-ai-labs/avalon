import {
  type Workstream,
} from "@rally/contracts";
import type { z } from "zod";

import { WorkspaceDoConnections } from "./workspace-do-connections";
import {
  SELECT_WORKSPACE_DIRECTORY,
  advanceWorkspaceDirectoryVersion,
  internalDirectoryItem,
  mapDirectoryWorkstream,
  mapDirectoryWorkstreams,
  pinnedWorkspaceDirectoryRows,
  MAX_WORKSPACE_PINS_PER_USER,
  rewriteWorkspacePinOrder,
  workspaceDirectoryVisible,
  workspaceTerminalScheduleTargets,
  type WorkspaceDirectoryRow,
} from "./workspace-directory-storage";
import { epoch } from "./workspace-projection";
import {
  WorkspaceDirectoryExistsRequestSchema,
  WorkspaceDirectoryDueRequestSchema,
  WorkspaceDirectoryLookupRequestSchema,
  WorkspaceDirectoryLookupResultSchema,
  WorkspaceDirectoryRecentRequestSchema,
  WorkspaceDirectoryReadableIdsRequestSchema,
  WorkspaceDirectoryReadableIdsResultSchema,
  WorkspaceDirectoryDeliveryAuthorityRequestSchema,
  WorkspaceDirectoryExposeRunRequestSchema,
  WorkspaceDirectoryOwnedAutomationsRequestSchema,
  WorkspaceDirectoryOwnedAutomationsSchema,
  WorkspaceDirectoryDeliveryAuthoritySchema,
  WorkspaceDirectoryNotificationRequestSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceDirectoryPinRequestSchema,
  WorkspaceDirectoryPlannedAutomationRequestSchema,
  WorkspaceDirectoryPlannedRequestSchema,
  WorkspaceDirectoryReorderPinsRequestSchema,
  WorkspaceDirectoryResourceAccessRequestSchema,
  WorkspaceDirectoryResourceAccessResultSchema,
  WorkspaceDirectoryResourceRequestSchema,
  WorkspaceDirectoryResourceResultSchema,
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryVisibilityRequestSchema,
  WorkspaceDirectoryVisibleIdsRequestSchema,
  WorkspaceDirectoryVisibleIdsPageSchema,
  type WorkspaceDirectoryDueRequest,
  type WorkspaceDirectoryExistsRequest,
  type WorkspaceDirectoryLookupRequest,
  type WorkspaceDirectoryLookupResult,
  type WorkspaceDirectoryRecentRequest,
  type WorkspaceDirectoryReadableIdsRequest,
  type WorkspaceDirectoryReadableIdsResult,
  type WorkspaceDirectoryPinRequest,
  type WorkspaceDirectoryPlannedAutomationRequest,
  type WorkspaceDirectoryPlannedRequest,
  type WorkspaceDirectoryReorderPinsRequest,
  type WorkspaceDirectoryResourceAccessRequest,
  type WorkspaceDirectoryResourceAccessResult,
  type WorkspaceDirectoryNotificationRequest,
  type WorkspaceDirectoryNotificationState,
  type WorkspaceDirectoryResourceRequest,
  type WorkspaceDirectoryResourceResult,
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceDirectoryVisibilityRequest,
  type WorkspaceDirectoryVisibleIdsRequest,
  type WorkspaceDirectoryVisibleIdsPage,
} from "./workspace-directory-protocol";

/**
 * One regional synchronization and command/control object per workspace.
 *
 * The Electron app keeps one hibernating socket here for workspace-wide query
 * invalidations, directory pages, and user writes. Message commands name their
 * target branch. WorkspaceDO SQL is authoritative for cross-workstream serving
 * state; regional D1 retains only identity, membership, routing,
 * migration/control, and operational audit/telemetry.
 *
 * The class is the last link of a chain split across `workspace-do-*.ts`; see
 * `workspace-do-core.ts` for why it is shaped that way. This file holds the
 * directory *reads* — the cursor-paged lists, visibility answers, pins, and
 * lookups every other surface's writes are eventually seen through.
 */
export class WorkspaceDO extends WorkspaceDoConnections {
  /** See {@link WorkspaceDoCore.selfInstance}: only this link can answer it. */
  protected override selfInstance(): WorkspaceDO {
    return this;
  }

  async canReadWorkstream(input: WorkspaceDirectoryVisibilityRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDirectoryVisible(this.state.storage, request.userId, request.workstreamId);
  }

  async readableWorkstreamIds(
    input: WorkspaceDirectoryReadableIdsRequest,
  ): Promise<WorkspaceDirectoryReadableIdsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryReadableIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.workstream_id`,
      request.userId,
      JSON.stringify(request.workstreamIds),
    ).toArray();
    return WorkspaceDirectoryReadableIdsResultSchema.parse({
      items: rows.map((row) => row.workstream_id),
    });
  }

  async visibleWorkstreamIds(input: WorkspaceDirectoryVisibleIdsRequest): Promise<WorkspaceDirectoryVisibleIdsPage> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibleIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 0 AND directory.scope = 'workspace')
              OR viewer.is_participant = 1)
         AND (? IS NULL OR directory.workstream_id > ?)
       ORDER BY directory.workstream_id
       LIMIT ?`,
      request.userId,
      request.includeSystem ? 1 : 0,
      request.participantsOnly ? 1 : 0,
      request.after ?? null,
      request.after ?? null,
      request.limit + 1,
    ).toArray();
    const hasMore = rows.length > request.limit;
    if (hasMore) rows.pop();
    return WorkspaceDirectoryVisibleIdsPageSchema.parse({
      items: rows.map((row) => row.workstream_id),
      nextCursor: hasMore ? rows.at(-1)?.workstream_id ?? null : null,
    });
  }

  /** Maintenance fence used before a D1 route may advertise an active child. */
  async hasWorkstreamDirectory(input: WorkspaceDirectoryExistsRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryExistsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return Boolean(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0]);
  }

  async plannedWorkstream(input: WorkspaceDirectoryPlannedRequest): Promise<Workstream | null> {
    await this.initialized;
    const request = WorkspaceDirectoryPlannedRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.userId;
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.automation_subscription_id = ?
         AND directory.planned_for = ? AND directory.archived_at IS NULL
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.source_updated_at DESC, directory.workstream_id LIMIT 1`,
      viewerId,
      viewerId,
      request.automationSubscriptionId,
      epoch(request.plannedFor),
    ).toArray()[0];
    return row ? mapDirectoryWorkstream(this.state.storage.sql, row, request.workspaceId) : null;
  }

  /** Exact idempotency lookup for the scheduler, independent of any member's visibility. */
  async plannedAutomationWorkstream(
    input: WorkspaceDirectoryPlannedAutomationRequest,
  ): Promise<Workstream | null> {
    await this.initialized;
    const request = WorkspaceDirectoryPlannedAutomationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.automation_subscription_id = ?
         AND directory.planned_for = ? AND directory.archived_at IS NULL
       ORDER BY directory.source_updated_at DESC, directory.workstream_id LIMIT 1`,
      "",
      "",
      request.automationSubscriptionId,
      epoch(request.plannedFor),
    ).toArray()[0];
    return row ? mapDirectoryWorkstream(this.state.storage.sql, row, request.workspaceId) : null;
  }

  async pinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!workspaceDirectoryVisible(this.state.storage, request.userId, request.workstreamId)) {
      throw new Error("workstream_not_found");
    }
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const alreadyPinned = this.state.storage.sql.exec<{ one: number }>(
        `SELECT 1 AS one FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ?`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (!alreadyPinned) {
        const count = this.state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workspace_workstream_pins WHERE user_id = ?`,
          request.userId,
        ).one().count;
        if (count >= MAX_WORKSPACE_PINS_PER_USER) throw new Error("workstream_pin_limit_reached");
      }
      const inserted = this.state.storage.sql.exec<{ workstream_id: string }>(
        `INSERT OR IGNORE INTO workspace_workstream_pins
           (user_id, workstream_id, position, created_at, updated_at)
         VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_workstream_pins
                                  WHERE user_id = ?), 0), ?, ?)
         RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
        request.userId,
        now,
        now,
      ).toArray().length === 1;
      if (inserted) advanceWorkspaceDirectoryVersion(this.state.storage, now);
      return inserted;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
    ) };
  }

  async unpinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const removed = this.state.storage.sql.exec<{ workstream_id: string }>(
        `DELETE FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ? RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (removed) {
        rewriteWorkspacePinOrder(this.state.storage, request.userId, [], now);
        advanceWorkspaceDirectoryVersion(this.state.storage, now);
      }
      return removed;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
    ) };
  }

  async reorderWorkstreamPins(
    input: WorkspaceDirectoryReorderPinsRequest,
  ): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryReorderPinsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      rewriteWorkspacePinOrder(this.state.storage, request.userId, request.workstreamIds, now);
      advanceWorkspaceDirectoryVersion(this.state.storage, now);
    });
    await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
    ) };
  }

  async notificationDirectoryState(
    input: WorkspaceDirectoryNotificationRequest,
  ): Promise<WorkspaceDirectoryNotificationState | null> {
    await this.initialized;
    const request = WorkspaceDirectoryNotificationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      authority_generation: number;
      waterline: number;
      listable: number;
      title: string;
      email_address: string | null;
    }>(
      `SELECT directory.authority_generation, viewer.waterline,
              viewer.listable, directory.title, directory.email_address
         FROM workspace_workstream_directory directory
         JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE directory.workstream_id = ? AND directory.archived_at IS NULL`,
      request.userId,
      request.workstreamId,
    ).toArray()[0];
    return row ? WorkspaceDirectoryNotificationStateSchema.parse({
      authorityGeneration: row.authority_generation,
      viewerVersion: row.waterline,
      listable: row.listable === 1,
      title: row.title,
      emailAddress: row.email_address,
    }) : null;
  }

  /**
   * The fence a delivery into a work stream writes behind.
   *
   * Read from the directory rather than from the room itself: the directory is
   * what a re-authorization bumps, so a delivery that read the room would learn
   * about the change only after writing into it. Returns null for a work stream
   * this workspace does not have, which a caller must treat as "do not write"
   * rather than "generation 1".
   */
  async workstreamDeliveryAuthority(
    input: z.input<typeof WorkspaceDirectoryDeliveryAuthorityRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceDirectoryDeliveryAuthoritySchema> | null> {
    await this.initialized;
    const request = WorkspaceDirectoryDeliveryAuthorityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      authority_generation: number;
      archived_at: number | null;
    }>(
      `SELECT authority_generation, archived_at
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0];
    return row ? WorkspaceDirectoryDeliveryAuthoritySchema.parse({
      authorityGeneration: row.authority_generation,
      archived: row.archived_at !== null,
    }) : null;
  }

  /**
   * Reveal an automation occurrence's own work stream in the sidebar.
   *
   * Creates nothing. The run finished in a work stream that already exists and
   * already holds its whole transcript; every listing query hides it because
   * `origin_type = 'automation'`, and this stops that one row being hidden. A
   * reader who takes the disposition's name literally will look for a creation
   * path that is deliberately absent.
   *
   * Idempotent because it is a boolean: a delivery retry after a crash has
   * nothing to duplicate.
   */
  async exposeAutomationRunWorkstream(
    input: z.input<typeof WorkspaceDirectoryExposeRunRequestSchema>,
  ): Promise<{ exposed: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = WorkspaceDirectoryExposeRunRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      origin_type: string;
      archived_at: number | null;
    }>(
      `SELECT origin_type, archived_at
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0];
    if (!row) return { exposed: false, outcomeCode: "workstream_not_found" };
    // Only a run's own work stream. Exposing anything else would mean this RPC
    // could unhide a room whose visibility somebody decided deliberately.
    if (row.origin_type !== "automation") {
      return { exposed: false, outcomeCode: "workstream_not_an_automation_run" };
    }
    // An archived run stays archived: a person archives an exposed run like any
    // other work stream, and a later occurrence must not undo that.
    if (row.archived_at !== null) return { exposed: false, outcomeCode: "workstream_archived" };
    this.state.storage.sql.exec(
      request.scope === null
        ? `UPDATE workspace_workstream_directory
              SET automation_exposed = 1
            WHERE workstream_id = ?`
        : `UPDATE workspace_workstream_directory
              SET automation_exposed = 1, scope = ?
            WHERE workstream_id = ?`,
      ...(request.scope === null
        ? [request.workstreamId]
        : [request.scope, request.workstreamId]),
    );
    return { exposed: true, outcomeCode: "workstream_exposed" };
  }

  /** Every automation this work stream owns, whatever its lifecycle. */
  async automationsOwnedByWorkstream(
    input: z.input<typeof WorkspaceDirectoryOwnedAutomationsRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceDirectoryOwnedAutomationsSchema>> {
    await this.initialized;
    const request = WorkspaceDirectoryOwnedAutomationsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ automation_id: string; lifecycle: string }>(
      `SELECT automation_id, lifecycle FROM automation_directory
        WHERE owning_workstream_id = ? ORDER BY automation_id`,
      request.workstreamId,
    ).toArray();
    return WorkspaceDirectoryOwnedAutomationsSchema.parse({
      automations: rows.map((row) => ({
        automationId: row.automation_id,
        lifecycle: row.lifecycle,
      })),
    });
  }

  async workstreamsForResource(
    input: WorkspaceDirectoryResourceRequest,
  ): Promise<WorkspaceDirectoryResourceResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT link.workstream_id FROM workspace_workstream_resource_links link
       JOIN workspace_workstream_directory directory
         ON directory.workstream_id = link.workstream_id
       WHERE link.resource_id = ? AND directory.archived_at IS NULL
         AND (? = 0 OR link.watch_enabled = 1)
       ORDER BY link.workstream_id`,
      request.resourceId,
      request.watchedOnly ? 1 : 0,
    ).toArray();
    return WorkspaceDirectoryResourceResultSchema.parse({
      workstreamIds: rows.map((row) => row.workstream_id),
    });
  }

  /** Internal cross-workstream lookup; never exposes viewer-specific state. */
  async lookupWorkstreamDirectory(
    input: WorkspaceDirectoryLookupRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryLookupRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      "",
      "",
      JSON.stringify(request.workstreamIds),
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({
      items: rows.map(internalDirectoryItem),
    });
  }

  async recentWorkstreamDirectory(
    input: WorkspaceDirectoryRecentRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryRecentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.audience.scope === "user" ? request.audience.userId : "";
    const audienceScope = request.audience.scope;
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 'workspace' AND directory.scope = 'workspace')
           OR (? = 'user' AND (
             (? = 0 AND directory.scope = 'workspace')
             OR viewer.is_participant = 1
           )))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
      viewerId,
      viewerId,
      request.includeSystem ? 1 : 0,
      audienceScope,
      audienceScope,
      request.participantsOnly ? 1 : 0,
      request.limit,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({ items: rows.map(internalDirectoryItem) });
  }

  async dueWorkstreamDirectory(input: WorkspaceDirectoryDueRequest): Promise<string[]> {
    await this.initialized;
    const request = WorkspaceDirectoryDueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const column = request.kind === "terminal" ? "next_terminal_action_at" : "next_wakeup_due_at";
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_directory
        WHERE archived_at IS NULL AND ${column} IS NOT NULL AND ${column} <= ?
        ORDER BY ${column}, workstream_id LIMIT ?`,
      epoch(request.through),
      request.limit,
    ).toArray().map((row) => row.workstream_id);
  }

  async workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryScheduleTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceTerminalScheduleTargets(this.state.storage);
  }

  async resourceAccess(
    input: WorkspaceDirectoryResourceAccessRequest,
  ): Promise<WorkspaceDirectoryResourceAccessResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceAccessRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      workstream_id: string;
      scope: "personal" | "workspace";
      created_by_user_id: string | null;
      automation_subscription_id: string | null;
      is_participant: number;
    }>(
      `SELECT directory.workstream_id, directory.scope, directory.created_by_user_id,
              directory.automation_subscription_id,
              COALESCE(viewer.is_participant, 0) AS is_participant
         FROM workspace_workstream_resource_links link
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = link.workstream_id
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE link.resource_id = ? AND directory.archived_at IS NULL
        ORDER BY directory.workstream_id`,
      request.userId,
      request.resourceId,
    ).toArray();
    return WorkspaceDirectoryResourceAccessResultSchema.parse({
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        scope: row.scope,
        createdByUserId: row.created_by_user_id,
        automationSubscriptionId: row.automation_subscription_id,
        isParticipant: row.is_participant === 1,
      })),
    });
  }
}
