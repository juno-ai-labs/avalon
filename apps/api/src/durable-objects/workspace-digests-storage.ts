import {
  WorkspaceDigestClaimResultSchema,
  WorkspaceDigestCursorSchema,
  WorkspaceDigestDefaultResultSchema,
  WorkspaceDigestDeliveryContextSchema,
  WorkspaceDigestDeliveryTargetsSchema,
  WorkspaceDigestFireScheduleSchema,
  WorkspaceDigestReleaseClaimResultSchema,
  WorkspaceDigestReplaceResultSchema,
  WorkspaceDigestRowStateSchema,
  WorkspaceDigestSettingsSchema,
  WorkspaceDigestSettleResultSchema,
  WorkspaceDigestTargetOutcomeResultSchema,
  WorkspaceDigestTerminalContextSchema,
  type WorkspaceDigestClaimRequest,
  type WorkspaceDigestClaimResult,
  type WorkspaceDigestCursor,
  type WorkspaceDigestDefaultRequest,
  type WorkspaceDigestDefaultResult,
  type WorkspaceDigestDeliveryContext,
  type WorkspaceDigestDeliveryRunningRequest,
  type WorkspaceDigestDeliveryTargets,
  type WorkspaceDigestDeliveryTargetsRequest,
  type WorkspaceDigestDeliveryWorkstreamRequest,
  type WorkspaceDigestFireSchedule,
  type WorkspaceDigestReleaseClaimRequest,
  type WorkspaceDigestReleaseClaimResult,
  type WorkspaceDigestReplaceRequest,
  type WorkspaceDigestReplaceResult,
  type WorkspaceDigestReplaceRowsRequest,
  type WorkspaceDigestRowState,
  type WorkspaceDigestRowStateRequest,
  type WorkspaceDigestSettingsRequest,
  type WorkspaceDigestSettings,
  type WorkspaceDigestSettleRequest,
  type WorkspaceDigestSettleResult,
  type WorkspaceDigestSummaryRequest,
  type WorkspaceDigestTargetDeliveredRequest,
  type WorkspaceDigestTargetFailedRequest,
  type WorkspaceDigestTargetOutcomeResult,
  type WorkspaceDigestTerminalContext,
  type WorkspaceDigestTerminalContextRequest,
} from "./workspace-digests-protocol";

interface DigestScheduleRow extends Record<string, SqlStorageValue> {
  id: string;
  day_mask: number;
  enabled: number;
}

function scheduleRowFor(
  storage: DurableObjectStorage,
  workspaceId: string,
  userId: string,
): DigestScheduleRow | undefined {
  return storage.sql.exec<DigestScheduleRow>(
    `SELECT id, day_mask, enabled FROM digest_schedules
      WHERE workspace_id = ? AND user_id = ?`,
    workspaceId,
    userId,
  ).toArray()[0];
}

function scheduleTimes(storage: DurableObjectStorage, digestScheduleId: string): number[] {
  return storage.sql.exec<{ minute_of_day: number }>(
    `SELECT minute_of_day FROM digest_schedule_times
      WHERE digest_schedule_id = ? ORDER BY minute_of_day ASC`,
    digestScheduleId,
  ).toArray().map((row) => Number(row.minute_of_day));
}

/**
 * Rewrite the derived `schedules` rows for one digest, inside the caller's
 * transaction. Always rebuilt rather than reconciled: working out which row
 * belonged to which configured time would cost more than recreating them.
 */
function writeDerivedScheduleRows(
  storage: DurableObjectStorage,
  input: {
    workspaceId: string;
    digestScheduleId: string;
    timezone: string;
    rows: ReadonlyArray<{ id: string; rrule: string; nextRunAt: string }>;
    at: string;
  },
): void {
  storage.sql.exec(`DELETE FROM schedules WHERE digest_schedule_id = ?`, input.digestScheduleId);
  for (const row of input.rows) {
    storage.sql.exec(
      `INSERT INTO schedules
         (id, workspace_id, connector_connection_id,
          digest_schedule_id, schedule_type, rrule, interval_seconds, timezone,
          next_run_at, last_run_at, enabled, version, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'calendar', ?, NULL, ?, ?, NULL, 1, 1, ?, ?)`,
      row.id,
      input.workspaceId,
      input.digestScheduleId,
      row.rrule,
      input.timezone,
      row.nextRunAt,
      input.at,
      input.at,
    );
  }
}

/** The settings surface's read, minus the connector-joined delivery targets. */
export function workspaceDigestSettings(
  storage: DurableObjectStorage,
  request: WorkspaceDigestSettingsRequest,
): WorkspaceDigestSettings {
  const schedule = scheduleRowFor(storage, request.workspaceId, request.userId);
  if (!schedule) {
    return WorkspaceDigestSettingsSchema.parse({
      schedule: null,
      times: [],
      nextRunAt: null,
      lastDeliveredAt: null,
    });
  }
  const next = storage.sql.exec<{ next_run_at: string | null }>(
    `SELECT MIN(next_run_at) AS next_run_at FROM schedules
      WHERE digest_schedule_id = ? AND enabled = 1`,
    schedule.id,
  ).toArray()[0];
  const last = storage.sql.exec<{ delivered_at: string | null }>(
    `SELECT MAX(updated_at) AS delivered_at FROM digest_deliveries
      WHERE digest_schedule_id = ? AND status = 'delivered'`,
    schedule.id,
  ).toArray()[0];
  return WorkspaceDigestSettingsSchema.parse({
    schedule: {
      id: schedule.id,
      dayMask: schedule.day_mask,
      enabled: schedule.enabled === 1,
    },
    times: scheduleTimes(storage, schedule.id),
    nextRunAt: next?.next_run_at ?? null,
    lastDeliveredAt: last?.delivered_at ?? null,
  });
}

/**
 * Replace one person's digest wholesale: the configuration row, its times, its
 * frozen destinations, and the derived `schedules` rows, in one transaction.
 *
 * The existence check decides create-or-update inside the same critical
 * section as the write. As a read here and a batch afterwards, two first saves
 * racing each other both read "nothing yet" and both inserted, and
 * `UNIQUE (workspace_id, user_id)` turned the loser into a 500.
 */
export function replaceWorkspaceDigestSchedule(
  storage: DurableObjectStorage,
  request: WorkspaceDigestReplaceRequest,
): WorkspaceDigestReplaceResult {
  return storage.transactionSync(() => {
    const existing = scheduleRowFor(storage, request.workspaceId, request.userId);
    const scheduleId = existing?.id ?? request.scheduleId;
    if (existing) {
      storage.sql.exec(
        `UPDATE digest_schedules
            SET day_mask = ?, enabled = ?, execution_principal_json = ?,
                version = version + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        request.dayMask,
        request.enabled ? 1 : 0,
        request.executionPrincipalJson,
        request.at,
        scheduleId,
        request.workspaceId,
      );
    } else {
      storage.sql.exec(
        `INSERT INTO digest_schedules
           (id, workspace_id, user_id, day_mask, enabled,
            execution_principal_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        scheduleId,
        request.workspaceId,
        request.userId,
        request.dayMask,
        request.enabled ? 1 : 0,
        request.executionPrincipalJson,
        request.at,
        request.at,
      );
    }
    storage.sql.exec(`DELETE FROM digest_schedule_times WHERE digest_schedule_id = ?`, scheduleId);
    for (const minuteOfDay of request.times) {
      storage.sql.exec(
        `INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day) VALUES (?, ?)`,
        scheduleId,
        minuteOfDay,
      );
    }
    storage.sql.exec(`DELETE FROM digest_delivery_targets WHERE digest_schedule_id = ?`, scheduleId);
    for (const target of request.targets) {
      storage.sql.exec(
        `INSERT INTO digest_delivery_targets
           (id, workspace_id, digest_schedule_id, user_id, target_type, connection_id,
            provider_tenant_id, provider_user_id, email_address, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        target.id,
        request.workspaceId,
        scheduleId,
        request.userId,
        target.targetType,
        target.connectionId,
        target.providerTenantId,
        target.providerUserId,
        target.emailAddress,
        request.at,
        request.at,
      );
    }
    writeDerivedScheduleRows(storage, {
      workspaceId: request.workspaceId,
      digestScheduleId: scheduleId,
      timezone: request.timezone,
      rows: request.scheduleRows,
      at: request.at,
    });
    return WorkspaceDigestReplaceResultSchema.parse({
      scheduleId,
      outcome: existing ? "updated" : "created",
    });
  });
}

/**
 * Give a member the on-by-default digest, or answer with the one they have.
 *
 * Absence is the only thing that creates: switching a digest off keeps its row
 * with `enabled = 0`, so this can never resurrect something somebody turned
 * off. The routed version was three `ON CONFLICT DO NOTHING` statements whose
 * "did I create it?" answer was a physical write counter; here the existence
 * check and the writes are one transaction and the answer is the branch taken.
 */
export function ensureDefaultWorkspaceDigestSchedule(
  storage: DurableObjectStorage,
  request: WorkspaceDigestDefaultRequest,
): WorkspaceDigestDefaultResult {
  return storage.transactionSync(() => {
    const existing = scheduleRowFor(storage, request.workspaceId, request.userId);
    if (existing) {
      return WorkspaceDigestDefaultResultSchema.parse({
        created: false,
        schedule: {
          id: existing.id,
          dayMask: existing.day_mask,
          enabled: existing.enabled === 1,
        },
        times: scheduleTimes(storage, existing.id),
      });
    }
    storage.sql.exec(
      `INSERT INTO digest_schedules
         (id, workspace_id, user_id, day_mask, enabled,
          execution_principal_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`,
      request.scheduleId,
      request.workspaceId,
      request.userId,
      request.dayMask,
      request.executionPrincipalJson,
      request.at,
      request.at,
    );
    storage.sql.exec(
      `INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day) VALUES (?, ?)`,
      request.scheduleId,
      request.minuteOfDay,
    );
    // Frozen against the account address the same way a saved target is, so a
    // default and a chosen destination behave identically from here on.
    storage.sql.exec(
      `INSERT INTO digest_delivery_targets
         (id, workspace_id, digest_schedule_id, user_id, target_type, connection_id,
          provider_tenant_id, provider_user_id, email_address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'email', NULL, NULL, NULL, ?, 'active', ?, ?)`,
      request.targetId,
      request.workspaceId,
      request.scheduleId,
      request.userId,
      request.emailAddress,
      request.at,
      request.at,
    );
    return WorkspaceDigestDefaultResultSchema.parse({
      created: true,
      schedule: { id: request.scheduleId, dayMask: request.dayMask, enabled: true },
      times: [request.minuteOfDay],
    });
  });
}

/** How the derived rows stand against the account timezone, for the reconciler's skip check. */
export function workspaceDigestScheduleRowState(
  storage: DurableObjectStorage,
  request: WorkspaceDigestRowStateRequest,
): WorkspaceDigestRowState {
  const state = storage.sql.exec<{ count: number; timezone_mismatches: number | null }>(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN timezone = ? THEN 0 ELSE 1 END) AS timezone_mismatches
       FROM schedules WHERE digest_schedule_id = ?`,
    request.timezone,
    request.digestScheduleId,
  ).toArray()[0];
  return WorkspaceDigestRowStateSchema.parse({
    rowCount: Number(state?.count ?? 0),
    timezoneMismatches: Number(state?.timezone_mismatches ?? 0),
  });
}

/** Rebuild one digest's derived `schedules` rows — a timezone move, or a repair. */
export function replaceWorkspaceDigestScheduleRows(
  storage: DurableObjectStorage,
  request: WorkspaceDigestReplaceRowsRequest,
): void {
  storage.transactionSync(() => {
    writeDerivedScheduleRows(storage, {
      workspaceId: request.workspaceId,
      digestScheduleId: request.digestScheduleId,
      timezone: request.timezone,
      rows: request.rows,
      at: request.at,
    });
  });
}

/** What the scheduler needs before it may fire an occurrence. */
export function workspaceDigestScheduleForFire(
  storage: DurableObjectStorage,
  request: { workspaceId: string; scheduleId: string },
): WorkspaceDigestFireSchedule {
  const row = storage.sql.exec<{
    id: string;
    user_id: string;
    enabled: number;
    execution_principal_json: string;
  }>(
    `SELECT id, user_id, enabled, execution_principal_json
       FROM digest_schedules WHERE id = ? AND workspace_id = ?`,
    request.scheduleId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceDigestFireScheduleSchema.parse({
    schedule: row
      ? {
        id: row.id,
        userId: row.user_id,
        enabled: row.enabled === 1,
        executionPrincipalJson: row.execution_principal_json,
      }
      : null,
  });
}

/**
 * Where the next digest starts reading: the highest point this schedule has
 * committed to covering.
 *
 * "Committed" includes a delivery that is still `planned` or `running`, not
 * just a settled one — two configured times a minute apart, or one slow run,
 * would otherwise both start from the last *settled* cursor and summarize the
 * same events into consecutive emails. `failed` is excluded, which is what
 * folds an undelivered window into the next digest rather than losing it. The
 * maximum rather than the newest row, because a retried or late occurrence can
 * settle out of order and the cursor must never move backwards.
 */
export function latestWorkspaceDigestCursor(
  storage: DurableObjectStorage,
  request: { workspaceId: string; digestScheduleId: string },
): WorkspaceDigestCursor {
  const row = storage.sql.exec<{ cursor_through: number | null }>(
    `SELECT MAX(cursor_through) AS cursor_through
       FROM digest_deliveries
      WHERE digest_schedule_id = ?
        AND status IN ('delivered', 'empty', 'planned', 'running')`,
    request.digestScheduleId,
  ).toArray()[0];
  return WorkspaceDigestCursorSchema.parse({
    cursorThrough: row?.cursor_through == null ? null : Number(row.cursor_through),
  });
}

/** Claim one occurrence, or learn a retried alarm already did. */
export function claimWorkspaceDigestDelivery(
  storage: DurableObjectStorage,
  request: WorkspaceDigestClaimRequest,
): WorkspaceDigestClaimResult {
  const claimed = storage.sql.exec<{ id: string }>(
    `INSERT INTO digest_deliveries
       (id, workspace_id, digest_schedule_id, user_id, planned_for,
        cursor_from, cursor_through, event_count, highlight_count,
        harness_run_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    request.deliveryId,
    request.workspaceId,
    request.digestScheduleId,
    request.userId,
    request.plannedFor,
    request.cursorFrom,
    request.cursorThrough,
    request.eventCount,
    request.highlightCount,
    request.status,
    request.at,
    request.at,
  ).toArray()[0];
  return WorkspaceDigestClaimResultSchema.parse({
    outcome: claimed ? "claimed" : "already_planned",
  });
}

/** Record which hidden work stream this occurrence executes in. */
export function recordWorkspaceDigestDeliveryWorkstream(
  storage: DurableObjectStorage,
  request: WorkspaceDigestDeliveryWorkstreamRequest,
): void {
  storage.sql.exec(
    `UPDATE digest_deliveries SET workstream_id = ?, updated_at = ? WHERE id = ?`,
    request.workstreamId,
    request.at,
    request.deliveryId,
  );
}

/** The launch succeeded: the claim graduates from `planned` to `running`. */
export function markWorkspaceDigestDeliveryRunning(
  storage: DurableObjectStorage,
  request: WorkspaceDigestDeliveryRunningRequest,
): void {
  storage.sql.exec(
    `UPDATE digest_deliveries SET status = 'running', harness_run_id = ?, updated_at = ?
      WHERE id = ? AND status = 'planned'`,
    request.harnessRunId,
    request.at,
    request.deliveryId,
  );
}

/** Undo a claim whose launch never started, so the scheduler's retry gets another go. */
export function releaseWorkspaceDigestDeliveryClaim(
  storage: DurableObjectStorage,
  request: WorkspaceDigestReleaseClaimRequest,
): WorkspaceDigestReleaseClaimResult {
  const released = storage.sql.exec<{ id: string }>(
    `DELETE FROM digest_deliveries WHERE id = ? AND status = 'planned' RETURNING id`,
    request.deliveryId,
  ).toArray()[0];
  return WorkspaceDigestReleaseClaimResultSchema.parse({
    outcome: released ? "released" : "kept",
  });
}

/** One occurrence as settlement, the trigger context, and the delivery note read it. */
export function workspaceDigestDeliveryContext(
  storage: DurableObjectStorage,
  request: { workspaceId: string; deliveryId: string },
): WorkspaceDigestDeliveryContext {
  const row = storage.sql.exec<{
    id: string;
    user_id: string;
    planned_for: string;
    event_count: number;
    highlight_count: number;
    status: string;
    workstream_id: string | null;
  }>(
    `SELECT id, user_id, planned_for, event_count, highlight_count, status, workstream_id
       FROM digest_deliveries WHERE id = ? AND workspace_id = ?`,
    request.deliveryId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceDigestDeliveryContextSchema.parse({
    delivery: row
      ? {
        id: row.id,
        userId: row.user_id,
        plannedFor: row.planned_for,
        eventCount: Number(row.event_count),
        highlightCount: Number(row.highlight_count),
        status: row.status,
        workstreamId: row.workstream_id,
      }
      : null,
  });
}

/** Keep what the run wrote, before delivery decides what happens to it. */
export function recordWorkspaceDigestSummary(
  storage: DurableObjectStorage,
  request: WorkspaceDigestSummaryRequest,
): void {
  storage.sql.exec(
    `UPDATE digest_deliveries SET summary_markdown = ?, updated_at = ? WHERE id = ?`,
    request.summaryMarkdown,
    request.at,
    request.deliveryId,
  );
}

/**
 * Settle one occurrence, exactly once.
 *
 * A compare-and-set with its witness rather than a guarded UPDATE whose
 * counter nobody read: two settlement attempts of the same workflow step can
 * run concurrently, and before this the loser re-emitted the terminal
 * telemetry and re-appended the delivery note as though it had settled.
 */
export function settleWorkspaceDigestDelivery(
  storage: DurableObjectStorage,
  request: WorkspaceDigestSettleRequest,
): WorkspaceDigestSettleResult {
  return storage.transactionSync(() => {
    const settled = storage.sql.exec<{ id: string }>(
      `UPDATE digest_deliveries
          SET status = ?, error_json = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('delivered', 'failed')
        RETURNING id`,
      request.status,
      request.errorJson,
      request.at,
      request.deliveryId,
    ).toArray()[0];
    if (settled) return WorkspaceDigestSettleResultSchema.parse({ outcome: "settled" });
    const exists = storage.sql.exec<{ id: string }>(
      `SELECT id FROM digest_deliveries WHERE id = ?`,
      request.deliveryId,
    ).toArray()[0];
    return WorkspaceDigestSettleResultSchema.parse({
      outcome: exists ? "already_settled" : "not_found",
    });
  });
}

/** What the terminal telemetry event says about this occurrence's destinations and history. */
export function workspaceDigestTerminalContext(
  storage: DurableObjectStorage,
  request: WorkspaceDigestTerminalContextRequest,
): WorkspaceDigestTerminalContext {
  const targets = storage.sql.exec<{ target_type: string }>(
    `SELECT DISTINCT target_type FROM digest_delivery_targets target
       JOIN digest_deliveries delivery ON delivery.digest_schedule_id = target.digest_schedule_id
      WHERE delivery.id = ? ORDER BY target_type LIMIT 2`,
    request.deliveryId,
  ).toArray();
  const prior = storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM digest_deliveries current
       JOIN digest_deliveries previous ON previous.digest_schedule_id = current.digest_schedule_id
      WHERE current.id = ? AND previous.status = 'delivered' AND previous.id <> current.id`,
    request.deliveryId,
  ).toArray()[0];
  return WorkspaceDigestTerminalContextSchema.parse({
    targetTypes: targets.map((row) => row.target_type),
    priorDeliveredCount: Number(prior?.count ?? 0),
  });
}

/** The frozen destinations one occurrence goes to, in settle order. */
export function workspaceDigestDeliveryTargets(
  storage: DurableObjectStorage,
  request: WorkspaceDigestDeliveryTargetsRequest,
): WorkspaceDigestDeliveryTargets {
  const rows = storage.sql.exec<{
    id: string;
    target_type: string;
    connection_id: string | null;
    provider_tenant_id: string | null;
    provider_user_id: string | null;
    email_address: string | null;
    last_delivered_delivery_id: string | null;
  }>(
    `SELECT t.id, t.target_type, t.connection_id, t.provider_tenant_id, t.provider_user_id,
            t.email_address, t.last_delivered_delivery_id
       FROM digest_delivery_targets t
       JOIN digest_deliveries d ON d.id = ?
      WHERE t.digest_schedule_id = d.digest_schedule_id
        AND t.workspace_id = ? AND t.user_id = ?
        AND t.status IN ('active', 'needs_input')
      ORDER BY t.target_type ASC`,
    request.deliveryId,
    request.workspaceId,
    request.userId,
  ).toArray();
  return WorkspaceDigestDeliveryTargetsSchema.parse({
    targets: rows.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      connectionId: row.connection_id,
      providerTenantId: row.provider_tenant_id,
      providerUserId: row.provider_user_id,
      emailAddress: row.email_address,
      lastDeliveredDeliveryId: row.last_delivered_delivery_id,
    })),
  });
}

/** One destination received this digest; its own record is what makes a retry skip it. */
export function markWorkspaceDigestTargetDelivered(
  storage: DurableObjectStorage,
  request: WorkspaceDigestTargetDeliveredRequest,
): WorkspaceDigestTargetOutcomeResult {
  const updated = storage.sql.exec<{ id: string }>(
    `UPDATE digest_delivery_targets
        SET status = 'active', last_delivered_at = ?, last_delivered_delivery_id = ?,
            last_error_json = NULL, updated_at = ?
      WHERE id = ?
      RETURNING id`,
    request.at,
    request.deliveryId,
    request.at,
    request.targetId,
  ).toArray()[0];
  return WorkspaceDigestTargetOutcomeResultSchema.parse({
    outcome: updated ? "recorded" : "target_not_found",
  });
}

/**
 * Record why a destination did not receive this digest.
 *
 * Only a permanent rejection moves the status: writing `active`
 * unconditionally would promote a target that a previous permanent rejection
 * had already parked in `needs_input`, and the settings screen would stop
 * showing that it needs attention.
 */
export function markWorkspaceDigestTargetFailed(
  storage: DurableObjectStorage,
  request: WorkspaceDigestTargetFailedRequest,
): WorkspaceDigestTargetOutcomeResult {
  const updated = storage.sql.exec<{ id: string }>(
    `UPDATE digest_delivery_targets
        SET status = CASE WHEN ? THEN 'needs_input' ELSE status END,
            last_error_json = ?, updated_at = ?
      WHERE id = ?
      RETURNING id`,
    request.permanent ? 1 : 0,
    request.errorJson,
    request.at,
    request.targetId,
  ).toArray()[0];
  return WorkspaceDigestTargetOutcomeResultSchema.parse({
    outcome: updated ? "recorded" : "target_not_found",
  });
}
