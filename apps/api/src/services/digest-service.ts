import {
  DigestScheduleSchema,
  ExecutionPrincipalSchema,
  type DigestDeliveryTargetType,
  type DigestSchedule,
  type UpdateDigestScheduleRequest,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { logWarn } from "../observability/logger";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";
import { declaredUserDeliveryTargetType, resolveFrozenDeliveryIdentity } from "./user-delivery";
import { emitProductUsageTelemetry, telemetryCountBucket } from "../telemetry/product-usage";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";

/** RRULE weekday codes, indexed the way `Date#getDay` numbers them. */
const RRULE_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * The id a never-saved digest reports. The contract types `id` as a UUID so the
 * client can hold one shape either way; this value says "nothing is stored yet"
 * without the client needing a nullable field it would have to branch on.
 */
export const DIGEST_UNSAVED_ID = "00000000-0000-4000-8000-000000000000";

interface DigestScheduleRow {
  id: string;
  workspace_id: string;
  user_id: string;
  day_mask: number;
  enabled: number;
  version: number;
  created_at: string;
}

interface DeliveryTargetRow {
  target_type: string;
  connection_id: string | null;
  email_address: string | null;
  status: "active" | "needs_input" | "disabled";
  last_delivered_at: string | null;
  connector_display_name: string | null;
}

/**
 * One RRULE per delivery time.
 *
 * A single rule cannot carry a list of times: BYHOUR and BYMINUTE multiply out,
 * so 09:00 plus 12:30 would also produce 09:30 and 12:00. Emitting one rule per
 * time says exactly what was asked for, and the workspace scheduler already
 * advances, retries and disables each `schedules` row on its own.
 */
export function digestRRule(days: number[], minuteOfDay: number): string {
  const byDay = [...new Set(days)].sort((left, right) => left - right)
    .map((day) => RRULE_WEEKDAYS[day]).join(",");
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `FREQ=WEEKLY;BYDAY=${byDay};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`;
}

/** Bit 0 is Sunday through bit 6 Saturday. */
export function dayMaskFromDays(days: number[]): number {
  return days.reduce((mask, day) => mask | (1 << day), 0);
}

export function daysFromDayMask(mask: number): number[] {
  return RRULE_WEEKDAYS.flatMap((_code, day) => (mask & (1 << day)) === 0 ? [] : [day]);
}

/**
 * The `schedules` rows a digest's configuration implies, as statements to batch.
 *
 * Derived state, always rebuilt rather than reconciled: working out which row
 * belonged to which time would cost more than recreating all of them. A disabled
 * digest keeps its configuration and produces no rows at all, so re-enabling it
 * is a save rather than a rebuild and the scheduler carries nothing that can
 * fire in the meantime.
 */
function digestScheduleRowStatements(
  env: Env,
  input: {
    workspaceId: string;
    digestScheduleId: string;
    enabled: boolean;
    days: number[];
    times: number[];
    timezone: string;
    at: string;
  },
): D1PreparedStatement[] {
  const clear = env.DB.prepare("DELETE FROM schedules WHERE digest_schedule_id = ?")
    .bind(input.digestScheduleId);
  if (!input.enabled || input.days.length === 0) return [clear];
  return [clear, ...input.times.flatMap((minuteOfDay) => {
    const rrule = digestRRule(input.days, minuteOfDay);
    const nextRunAt = nextRRuleOccurrence(rrule, input.timezone, new Date(input.at), new Date(input.at));
    if (!nextRunAt) return [];
    return [env.DB.prepare(
      `INSERT INTO schedules
         (id, workspace_id, automation_subscription_id, connector_connection_id,
          digest_schedule_id, schedule_type, rrule, interval_seconds, timezone,
          next_run_at, last_run_at, enabled, version, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, 'calendar', ?, NULL, ?, ?, NULL, 1, 1, ?, ?)`,
    ).bind(
      newId(), input.workspaceId, input.digestScheduleId, rrule, input.timezone,
      nextRunAt.toISOString(), input.at, input.at,
    )];
  })];
}

/**
 * Re-derives a person's digest schedule rows after their account timezone
 * changes.
 *
 * A digest's times are wall-clock times in its owner's day, so moving timezone
 * moves every occurrence. Nothing about the configuration changes — the same
 * days, the same times — only the instants they resolve to, which is exactly
 * what the derived rows hold.
 *
 * Every workspace, not just the one the request came from: `users.timezone` is
 * one column for the whole account, so a person in two workspaces in this region
 * would otherwise keep receiving one of their digests at the old local time.
 *
 * Best effort. If this does not run, or does not finish, the reconciler repairs
 * the drift on the next cron tick — it compares each derived row's timezone
 * against the account and rebuilds what disagrees.
 */
export async function rebuildDigestSchedulesForTimezone(
  env: Env,
  input: { userId: string; timezone: string },
): Promise<void> {
  const memberships = await env.DB.prepare(
    `SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active'`,
  ).bind(input.userId).all<{ workspace_id: string }>();
  const digests: Array<{ id: string; workspace_id: string; enabled: number; day_mask: number }> = [];
  for (const membership of memberships.results ?? []) {
    const workspaceEnv = withWorkspaceRuntimeDatabase(env, membership.workspace_id);
    const digest = await workspaceEnv.DB.prepare(
      `SELECT id, workspace_id, enabled, day_mask FROM digest_schedules
        WHERE workspace_id = ? AND user_id = ?`,
    ).bind(membership.workspace_id, input.userId).first<{
      id: string; workspace_id: string; enabled: number; day_mask: number;
    }>();
    if (digest) digests.push(digest);
  }

  for (const digest of digests) {
    const workspaceEnv = withWorkspaceRuntimeDatabase(env, digest.workspace_id);
    const times = await workspaceEnv.DB.prepare(
      "SELECT minute_of_day FROM digest_schedule_times WHERE digest_schedule_id = ? ORDER BY minute_of_day ASC",
    ).bind(digest.id).all<{ minute_of_day: number }>();
    await workspaceEnv.DB.batch(digestScheduleRowStatements(workspaceEnv, {
      workspaceId: digest.workspace_id,
      digestScheduleId: digest.id,
      enabled: digest.enabled === 1,
      days: daysFromDayMask(digest.day_mask),
      times: (times.results ?? []).map((row) => Number(row.minute_of_day)),
      timezone: input.timezone,
      at: nowIso(),
    }));
  }
  await Promise.all([...new Set(digests.map((digest) => digest.workspace_id))]
    .map((workspaceId) => refreshWorkspaceSchedule(env, workspaceId)));
}

/** What a person gets before they have chosen anything: weekdays at 09:00, by email. */
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_MINUTE_OF_DAY = 9 * 60;
/** Bounded so one cron tick cannot spend its whole budget on a large workspace. */
const RECONCILE_LIMIT = 200;

interface MemberWithoutDigestRow {
  workspace_id: string;
  user_id: string;
  email: string | null;
  timezone: string;
}

/**
 * Gives everyone a digest, and keeps every digest's derived rows in step.
 *
 * A digest is on by default: a person should not have to discover a settings
 * screen to be told what they missed. That is done here rather than at the four
 * places a membership is created, because a reconciler covers the path someone
 * adds next as well as the four that exist today, and because it repairs a
 * half-written save instead of leaving it.
 *
 * Two passes, both idempotent, both "make derived state match intent":
 *
 * 1. An active member with no digest at all gets the default. Absence is
 *    unambiguous — switching a digest off keeps its row with `enabled = 0` — so
 *    this can never resurrect something somebody turned off.
 * 2. An enabled digest with days and times but no `schedules` rows gets them.
 *    That is the state a fresh default lands in, and the state a save leaves if
 *    it fails between writing the configuration and deriving the rows.
 */
export async function reconcileDigestDefaults(env: Env): Promise<{
  created: number;
  derived: number;
}> {
  const at = nowIso();
  const regionalDatabase = workspaceRegionalDatabase(env);
  const cursor = await regionalDatabase.prepare(
    `SELECT after_workspace_id, after_user_id FROM digest_reconciliation_control WHERE id = 1`,
  ).first<{ after_workspace_id: string; after_user_id: string }>();
  const members = await regionalDatabase.prepare(
    `SELECT m.workspace_id, m.user_id, u.email, u.timezone
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.status = 'active'
        AND (m.workspace_id > ? OR (m.workspace_id = ? AND m.user_id > ?))
      ORDER BY m.workspace_id, m.user_id
      LIMIT ?`,
  ).bind(
    cursor?.after_workspace_id ?? "",
    cursor?.after_workspace_id ?? "",
    cursor?.after_user_id ?? "",
    RECONCILE_LIMIT,
  ).all<MemberWithoutDigestRow>();

  let created = 0;
  let derived = 0;
  const workspaces = new Set<string>();
  for (const member of members.results ?? []) {
    const workspaceEnv = withWorkspaceRuntimeDatabase(env, member.workspace_id);
    let digest = await workspaceEnv.DB.prepare(
      `SELECT id, workspace_id, enabled, day_mask FROM digest_schedules
        WHERE workspace_id = ? AND user_id = ?`,
    ).bind(member.workspace_id, member.user_id).first<{
      id: string; workspace_id: string; enabled: number; day_mask: number;
    }>();
    if (!digest) {
      if (!member.email?.trim()) continue;
      const scheduleId = newId();
      const inserted = await workspaceEnv.DB.batch([
        workspaceEnv.DB.prepare(
        `INSERT INTO digest_schedules
           (id, workspace_id, user_id, day_mask, enabled,
            execution_principal_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)
         ON CONFLICT DO NOTHING`,
        ).bind(
        scheduleId, member.workspace_id, member.user_id, dayMaskFromDays(DEFAULT_DAYS),
        JSON.stringify({ type: "user", userId: member.user_id }), at, at,
      ),
        workspaceEnv.DB.prepare(
        `INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day)
         SELECT id, ? FROM digest_schedules WHERE workspace_id = ? AND user_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(DEFAULT_MINUTE_OF_DAY, member.workspace_id, member.user_id),
      // Frozen against the account address the same way a saved target is, so a
      // default and a chosen destination behave identically from here on.
        workspaceEnv.DB.prepare(
        `INSERT INTO digest_delivery_targets
           (id, workspace_id, digest_schedule_id, user_id, target_type, connection_id,
            provider_tenant_id, provider_user_id, email_address, status, created_at, updated_at)
         SELECT ?, d.workspace_id, d.id, d.user_id, 'email', NULL, NULL, NULL, ?, 'active', ?, ?
           FROM digest_schedules d
          WHERE d.workspace_id = ? AND d.user_id = ?
         ON CONFLICT DO NOTHING`,
        ).bind(newId(), member.email.trim(), at, at, member.workspace_id, member.user_id),
      ]);
      if (Number(inserted[0]?.meta.changes ?? 0) > 0) created += 1;
      digest = await workspaceEnv.DB.prepare(
        `SELECT id, workspace_id, enabled, day_mask FROM digest_schedules
          WHERE workspace_id = ? AND user_id = ?`,
      ).bind(member.workspace_id, member.user_id).first<{
        id: string; workspace_id: string; enabled: number; day_mask: number;
      }>();
    }
    if (!digest || digest.enabled !== 1 || digest.day_mask <= 0) continue;
    const times = await workspaceEnv.DB.prepare(
      "SELECT minute_of_day FROM digest_schedule_times WHERE digest_schedule_id = ? ORDER BY minute_of_day ASC",
    ).bind(digest.id).all<{ minute_of_day: number }>();
    if (times.results.length === 0) continue;
    const scheduleState = await workspaceEnv.DB.prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN timezone = ? THEN 0 ELSE 1 END) AS timezone_mismatches
         FROM schedules WHERE digest_schedule_id = ?`,
    ).bind(member.timezone, digest.id).first<{ count: number; timezone_mismatches: number | null }>();
    if (Number(scheduleState?.count ?? 0) > 0
      && Number(scheduleState?.timezone_mismatches ?? 0) === 0) continue;
    await workspaceEnv.DB.batch(digestScheduleRowStatements(workspaceEnv, {
      workspaceId: digest.workspace_id,
      digestScheduleId: digest.id,
      enabled: true,
      days: daysFromDayMask(digest.day_mask),
      times: (times.results ?? []).map((row) => Number(row.minute_of_day)),
      timezone: member.timezone,
      at: nowIso(),
    }));
    workspaces.add(digest.workspace_id);
    derived += 1;
  }

  const last = members.results.at(-1);
  await regionalDatabase.prepare(
    `UPDATE digest_reconciliation_control
        SET after_workspace_id = ?, after_user_id = ?, updated_at = ? WHERE id = 1`,
  ).bind(
    members.results.length < RECONCILE_LIMIT ? "" : last?.workspace_id ?? "",
    members.results.length < RECONCILE_LIMIT ? "" : last?.user_id ?? "",
    at,
  ).run();

  // One refresh per workspace, after its rows exist: the Durable Object reads
  // D1, so refreshing per digest would just recompute the same alarm N times.
  await Promise.all([...workspaces].map((workspaceId) =>
    refreshWorkspaceSchedule(env, workspaceId).catch((error: unknown) => {
      logWarn(env, "digest_alarm_refresh_failed", {
        workspace_id: workspaceId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    })));

  return { created, derived };
}

export class DigestService {
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(
    env: Env,
    auth: AuthContext,
  ) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
  }

  /**
   * The caller's digest. A person who has never configured one gets an
   * unsaved default rather than a 404, so the settings screen has something
   * coherent to render before anything exists.
   */
  async get(): Promise<DigestSchedule> {
    const row = await this.loadRow();
    if (!row) return await this.defaultSchedule();
    const [times, targets, timing, timezone] = await Promise.all([
      this.loadTimes(row.id),
      this.loadTargets(row.id),
      this.loadTiming(row.id),
      this.accountTimezone(),
    ]);
    return DigestScheduleSchema.parse({
      id: row.id,
      enabled: row.enabled === 1,
      days: daysFromDayMask(row.day_mask),
      times,
      timezone,
      deliveryTargets: targets,
      nextRunAt: timing.nextRunAt,
      lastDeliveredAt: timing.lastDeliveredAt,
    });
  }

  /**
   * Replaces the caller's digest wholesale.
   *
   * The order matters: destinations are resolved and frozen *before* anything is
   * written, so a destination that has gone away fails the request rather than
   * leaving a schedule that fires into nowhere. Schedule rows are then rebuilt
   * from scratch — deriving them is cheap, and reconciling them in place would
   * mean tracking which `schedules` row belonged to which time.
   */
  async replace(input: UpdateDigestScheduleRequest): Promise<DigestSchedule> {
    const days = [...new Set(input.days)].sort((left, right) => left - right);
    const times = [...new Set(input.times)].sort((left, right) => left - right);
    const targets = await this.resolveDeliveryTargets(input.deliveryTargets);
    const timezone = await this.accountTimezone();

    const at = nowIso();
    const existing = await this.loadRow();
    const scheduleId = existing?.id ?? newId();
    const principal = ExecutionPrincipalSchema.parse({ type: "user", userId: this.auth.userId });

    await this.env.DB.batch([
      existing
        ? this.env.DB.prepare(
            `UPDATE digest_schedules
                SET day_mask = ?, enabled = ?, execution_principal_json = ?,
                    version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          ).bind(
            dayMaskFromDays(days), input.enabled ? 1 : 0,
            JSON.stringify(principal), at, scheduleId, this.auth.workspaceId,
          )
        : this.env.DB.prepare(
            `INSERT INTO digest_schedules
               (id, workspace_id, user_id, day_mask, enabled,
                execution_principal_json, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          ).bind(
            scheduleId, this.auth.workspaceId, this.auth.userId, dayMaskFromDays(days),
            input.enabled ? 1 : 0, JSON.stringify(principal), at, at,
          ),
      this.env.DB.prepare("DELETE FROM digest_schedule_times WHERE digest_schedule_id = ?").bind(scheduleId),
      ...times.map((minuteOfDay) => this.env.DB.prepare(
        "INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day) VALUES (?, ?)",
      ).bind(scheduleId, minuteOfDay)),
      this.env.DB.prepare("DELETE FROM digest_delivery_targets WHERE digest_schedule_id = ?").bind(scheduleId),
      ...targets.map((target) => this.env.DB.prepare(
        `INSERT INTO digest_delivery_targets
           (id, workspace_id, digest_schedule_id, user_id, target_type, connection_id,
            provider_tenant_id, provider_user_id, email_address, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(
        newId(), this.auth.workspaceId, scheduleId, this.auth.userId, target.type,
        target.connectionId, target.providerTenantId, target.providerUserId,
        target.emailAddress, at, at,
      )),
      ...digestScheduleRowStatements(this.env, {
        workspaceId: this.auth.workspaceId,
        digestScheduleId: scheduleId,
        enabled: input.enabled,
        days,
        times,
        timezone,
        at,
      }),
    ]);
    // The alarm is recomputed after the write, never before: the Durable Object
    // reads D1, so refreshing early would compute the alarm from the old rows.
    await refreshWorkspaceSchedule(this.env, this.auth.workspaceId);
    const schedule = await this.get();
    const cadence = !input.enabled || days.length === 0 || times.length === 0
      ? "disabled" as const
      : days.length === 7
        ? times.length === 1 ? "daily" as const : "multiple_daily" as const
        : times.length === 1 ? "weekly" as const : "multiple_weekly" as const;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: "digest_schedule_updated",
      properties: {
        enabled: schedule.enabled,
        dayCount: telemetryCountBucket(days.length),
        timeCount: telemetryCountBucket(times.length),
        cadence,
        deliveryTargetTypes: targets.map((target) => target.type).slice(0, 2),
        result: "success",
      },
      operationId: scheduleId,
      eventId: newId(),
    }).catch(() => undefined);
    return schedule;
  }

  /** The account timezone a digest runs in. There is no second copy of it. */
  private async accountTimezone(): Promise<string> {
    const row = await this.env.DB.prepare("SELECT timezone FROM users WHERE id = ?")
      .bind(this.auth.userId).first<{ timezone: string }>();
    return row?.timezone ?? "America/Los_Angeles";
  }

  /**
   * What the settings screen renders in the window between joining a workspace
   * and the cron tick that writes the real row.
   *
   * It shows what the reconciler is about to create, not something different —
   * same days, same time, same on-by-default, same email destination. Anyone who
   * opened Settings in that gap would otherwise read "Digests are off", then find
   * one running the next time they looked.
   */
  private async defaultSchedule(): Promise<DigestSchedule> {
    const email = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(this.auth.userId).first<{ email: string | null }>();
    const address = email?.email?.trim();
    return DigestScheduleSchema.parse({
      id: DIGEST_UNSAVED_ID,
      // The reconciler skips a member with no address, so this mirrors that too.
      enabled: Boolean(address),
      days: DEFAULT_DAYS,
      times: [DEFAULT_MINUTE_OF_DAY],
      timezone: await this.accountTimezone(),
      deliveryTargets: address
        ? [{ type: "email", connectionId: null, displayName: address, status: "active", lastDeliveredAt: null }]
        : [],
      nextRunAt: null,
      lastDeliveredAt: null,
    });
  }

  private async loadRow(): Promise<DigestScheduleRow | null> {
    return await this.env.DB.prepare(
      `SELECT id, workspace_id, user_id, day_mask, enabled, version, created_at
         FROM digest_schedules WHERE workspace_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId).first<DigestScheduleRow>();
  }

  private async loadTimes(scheduleId: string): Promise<number[]> {
    const result = await this.env.DB.prepare(
      "SELECT minute_of_day FROM digest_schedule_times WHERE digest_schedule_id = ? ORDER BY minute_of_day ASC",
    ).bind(scheduleId).all<{ minute_of_day: number }>();
    return (result.results ?? []).map((row) => Number(row.minute_of_day));
  }

  private async loadTargets(scheduleId: string): Promise<DigestSchedule["deliveryTargets"]> {
    const result = await this.env.DB.prepare(
      `SELECT t.target_type, t.connection_id, t.email_address, t.status, t.last_delivered_at,
              c.display_name AS connector_display_name
         FROM digest_delivery_targets t
         LEFT JOIN connector_connections c ON c.id = t.connection_id
        WHERE t.digest_schedule_id = ?
        ORDER BY t.target_type ASC`,
    ).bind(scheduleId).all<DeliveryTargetRow>();
    return (result.results ?? []).map((row) => ({
      type: row.target_type as DigestDeliveryTargetType,
      connectionId: row.connection_id,
      displayName: row.email_address ?? row.connector_display_name ?? row.target_type,
      status: row.status,
      lastDeliveredAt: row.last_delivered_at,
    }));
  }

  private async loadTiming(scheduleId: string): Promise<{
    nextRunAt: string | null;
    lastDeliveredAt: string | null;
  }> {
    const [next, last] = await Promise.all([
      this.env.DB.prepare(
        `SELECT MIN(next_run_at) AS next_run_at FROM schedules
          WHERE digest_schedule_id = ? AND enabled = 1`,
      ).bind(scheduleId).first<{ next_run_at: string | null }>(),
      this.env.DB.prepare(
        `SELECT MAX(updated_at) AS delivered_at FROM digest_deliveries
          WHERE digest_schedule_id = ? AND status = 'delivered'`,
      ).bind(scheduleId).first<{ delivered_at: string | null }>(),
    ]);
    return { nextRunAt: next?.next_run_at ?? null, lastDeliveredAt: last?.delivered_at ?? null };
  }

  /**
   * Turns the destinations someone chose into the identities to freeze.
   *
   * Nothing here enumerates connectors. `email` is the built-in default; every
   * other destination is a connection whose connector declares a `userDelivery`
   * surface, resolved through exactly the same eligibility the settings screen
   * was offered. A connector that starts declaring a surface becomes selectable
   * with no change to this file.
   */
  private async resolveDeliveryTargets(
    targets: UpdateDigestScheduleRequest["deliveryTargets"],
  ): Promise<Array<{
    type: DigestDeliveryTargetType;
    connectionId: string | null;
    providerTenantId: string | null;
    providerUserId: string | null;
    emailAddress: string | null;
  }>> {
    const seen = new Set<string>();
    const resolved: Array<{
      type: DigestDeliveryTargetType;
      connectionId: string | null;
      providerTenantId: string | null;
      providerUserId: string | null;
      emailAddress: string | null;
    }> = [];
    for (const target of targets) {
      if (seen.has(target.type)) {
        throw new ApiError(422, "duplicate_delivery_target", "Each destination can only be chosen once");
      }
      seen.add(target.type);
      if (target.type === "email") {
        resolved.push({
          type: "email",
          connectionId: null,
          providerTenantId: null,
          providerUserId: null,
          emailAddress: await this.accountEmailAddress(),
        });
        continue;
      }
      if (!target.connectionId) {
        throw new ApiError(422, "delivery_connection_required", "This destination needs a connection");
      }
      const identity = await resolveFrozenDeliveryIdentity(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        connectionId: target.connectionId,
        targetType: target.type,
      });
      if (!identity) {
        throw new ApiError(
          422,
          "delivery_target_unavailable",
          "Connect your Avalon account in the selected destination before sending digests to it",
        );
      }
      resolved.push({
        type: target.type,
        connectionId: identity.connectionId,
        providerTenantId: identity.providerTenantId,
        providerUserId: identity.providerUserId,
        emailAddress: null,
      });
    }
    return resolved;
  }

  /**
   * Frozen at save time against the account address, exactly as automation email
   * delivery is: a digest must keep going to the address that was agreed to,
   * not follow a later profile edit.
   */
  private async accountEmailAddress(): Promise<string> {
    const row = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(this.auth.userId).first<{ email: string | null }>();
    const email = row?.email?.trim();
    if (!email) {
      throw new ApiError(422, "email_delivery_unavailable", "Your Avalon account has no email address to send digests to");
    }
    return email;
  }
}

/**
 * The destinations one person can pick right now: email, plus every healthy
 * connection whose connector declares a personal delivery surface they have
 * linked themselves to. The settings screen renders this list verbatim, so a
 * new connector appears without a UI change.
 */
export function digestDeliveryTargetTypeForConnector(
  env: Env,
  connectorType: string,
): DigestDeliveryTargetType | null {
  return declaredUserDeliveryTargetType(env, connectorType);
}
