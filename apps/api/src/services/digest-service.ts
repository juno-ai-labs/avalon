import {
  DigestScheduleSchema,
  ExecutionPrincipalSchema,
  asWorkspaceId,
  type DigestDeliveryTargetType,
  type DigestSchedule,
  type UpdateDigestScheduleRequest,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { AuthContext, Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceDigestDefaultResultSchema,
  WorkspaceDigestReplaceResultSchema,
  WorkspaceDigestRowStateSchema,
  WorkspaceDigestSettingsSchema,
  type WorkspaceDigestReplaceRequest,
} from "../durable-objects/workspace-digests-protocol";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { logWarn } from "../observability/logger";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";
import { declaredUserDeliveryTargetType, resolveFrozenDeliveryIdentity } from "./user-delivery";
import { emitProductUsageTelemetry, telemetryCountBucket } from "../telemetry/product-usage";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";

/** The WorkspaceDO that owns this workspace's digest tables. */
function workspaceDigests(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/** RRULE weekday codes, indexed the way `Date#getDay` numbers them. */
const RRULE_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * The id a never-saved digest reports. The contract types `id` as a UUID so the
 * client can hold one shape either way; this value says "nothing is stored yet"
 * without the client needing a nullable field it would have to branch on.
 */
export const DIGEST_UNSAVED_ID = "00000000-0000-4000-8000-000000000000";

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
 * The `schedules` rows a digest's configuration implies, as values for the
 * object to write.
 *
 * Derived state, always rebuilt rather than reconciled: working out which row
 * belonged to which time would cost more than recreating all of them. A disabled
 * digest keeps its configuration and produces no rows at all, so re-enabling it
 * is a save rather than a rebuild and the scheduler carries nothing that can
 * fire in the meantime. The recurrence arithmetic stays here — the object writes
 * exactly what it is handed, so the policy for *when* a digest fires does not
 * move into the authority that stores it.
 */
function derivedDigestScheduleRows(input: {
  enabled: boolean;
  days: number[];
  times: number[];
  timezone: string;
  at: string;
}): WorkspaceDigestReplaceRequest["scheduleRows"] {
  if (!input.enabled || input.days.length === 0) return [];
  return input.times.flatMap((minuteOfDay) => {
    const rrule = digestRRule(input.days, minuteOfDay);
    const nextRunAt = nextRRuleOccurrence(rrule, input.timezone, new Date(input.at), new Date(input.at));
    if (!nextRunAt) return [];
    return [{ id: newId(), rrule, nextRunAt: nextRunAt.toISOString() }];
  });
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
  // Focused unit environments omit the namespace deliberately — the same
  // allowance `refreshWorkspaceSchedule` makes, and for the same reason. The
  // environment contract requires it before request dispatch, so production
  // never reaches this branch.
  if (!env.WORKSPACE_DOS) return;
  const memberships = await env.DB.prepare(
    `SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active'`,
  ).bind(input.userId).all<{ workspace_id: string }>();
  const rebuilt: string[] = [];
  for (const membership of memberships.results ?? []) {
    const workspace = await workspaceDigests(env, membership.workspace_id);
    const settings = WorkspaceDigestSettingsSchema.parse(await workspace.digestSettings({
      workspaceId: membership.workspace_id,
      userId: input.userId,
    }));
    if (!settings.schedule) continue;
    const at = nowIso();
    await workspace.replaceDigestScheduleRows({
      workspaceId: membership.workspace_id,
      digestScheduleId: settings.schedule.id,
      timezone: input.timezone,
      rows: derivedDigestScheduleRows({
        enabled: settings.schedule.enabled,
        days: daysFromDayMask(settings.schedule.dayMask),
        times: settings.times,
        timezone: input.timezone,
        at,
      }),
      at,
    });
    rebuilt.push(membership.workspace_id);
  }
  await Promise.all([...new Set(rebuilt)]
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
  // The same focused-environment allowance as `rebuildDigestSchedulesForTimezone`.
  if (!env.WORKSPACE_DOS) return { created: 0, derived: 0 };
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
    const workspace = await workspaceDigests(env, member.workspace_id);
    const settings = WorkspaceDigestSettingsSchema.parse(await workspace.digestSettings({
      workspaceId: member.workspace_id,
      userId: member.user_id,
    }));
    let digest = settings.schedule;
    let times = settings.times;
    if (!digest) {
      if (!member.email?.trim()) continue;
      const ensured = WorkspaceDigestDefaultResultSchema.parse(
        await workspace.ensureDefaultDigestSchedule({
          workspaceId: member.workspace_id,
          userId: member.user_id,
          scheduleId: newId(),
          targetId: newId(),
          dayMask: dayMaskFromDays(DEFAULT_DAYS),
          minuteOfDay: DEFAULT_MINUTE_OF_DAY,
          emailAddress: member.email.trim(),
          executionPrincipalJson: JSON.stringify({ type: "user", userId: member.user_id }),
          at,
        }),
      );
      if (ensured.created) created += 1;
      digest = ensured.schedule;
      times = ensured.times;
    }
    if (!digest.enabled || digest.dayMask <= 0) continue;
    if (times.length === 0) continue;
    const rowState = WorkspaceDigestRowStateSchema.parse(await workspace.digestScheduleRowState({
      workspaceId: member.workspace_id,
      digestScheduleId: digest.id,
      timezone: member.timezone,
    }));
    if (rowState.rowCount > 0 && rowState.timezoneMismatches === 0) continue;
    const derivedAt = nowIso();
    await workspace.replaceDigestScheduleRows({
      workspaceId: member.workspace_id,
      digestScheduleId: digest.id,
      timezone: member.timezone,
      rows: derivedDigestScheduleRows({
        enabled: true,
        days: daysFromDayMask(digest.dayMask),
        times,
        timezone: member.timezone,
        at: derivedAt,
      }),
      at: derivedAt,
    });
    workspaces.add(member.workspace_id);
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
    const workspace = await workspaceDigests(this.env, this.auth.workspaceId);
    const settings = WorkspaceDigestSettingsSchema.parse(await workspace.digestSettings({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
    if (!settings.schedule) return await this.defaultSchedule();
    const [targets, timezone] = await Promise.all([
      this.loadTargets(settings.schedule.id),
      this.accountTimezone(),
    ]);
    return DigestScheduleSchema.parse({
      id: settings.schedule.id,
      enabled: settings.schedule.enabled,
      days: daysFromDayMask(settings.schedule.dayMask),
      times: settings.times,
      timezone,
      deliveryTargets: targets,
      nextRunAt: settings.nextRunAt,
      lastDeliveredAt: settings.lastDeliveredAt,
    });
  }

  /**
   * Replaces the caller's digest wholesale.
   *
   * The order matters: destinations are resolved and frozen *before* anything is
   * written, so a destination that has gone away fails the request rather than
   * leaving a schedule that fires into nowhere. Schedule rows are then rebuilt
   * from scratch — deriving them is cheap, and reconciling them in place would
   * mean tracking which `schedules` row belonged to which time. The whole write
   * — configuration, times, frozen destinations, derived rows — is one object
   * transaction, and the object decides create-versus-update inside it, so two
   * first saves racing each other converge instead of the loser 500ing on
   * `UNIQUE (workspace_id, user_id)`.
   */
  async replace(input: UpdateDigestScheduleRequest): Promise<DigestSchedule> {
    const days = [...new Set(input.days)].sort((left, right) => left - right);
    const times = [...new Set(input.times)].sort((left, right) => left - right);
    const targets = await this.resolveDeliveryTargets(input.deliveryTargets);
    const timezone = await this.accountTimezone();

    const at = nowIso();
    const principal = ExecutionPrincipalSchema.parse({ type: "user", userId: this.auth.userId });

    const workspace = await workspaceDigests(this.env, this.auth.workspaceId);
    const saved = WorkspaceDigestReplaceResultSchema.parse(await workspace.replaceDigestSchedule({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      scheduleId: newId(),
      dayMask: dayMaskFromDays(days),
      enabled: input.enabled,
      executionPrincipalJson: JSON.stringify(principal),
      times,
      targets: targets.map((target) => ({
        id: newId(),
        targetType: target.type,
        connectionId: target.connectionId,
        providerTenantId: target.providerTenantId,
        providerUserId: target.providerUserId,
        emailAddress: target.emailAddress,
      })),
      scheduleRows: derivedDigestScheduleRows({
        enabled: input.enabled,
        days,
        times,
        timezone,
        at,
      }),
      timezone,
      at,
    }));
    const scheduleId = saved.scheduleId;
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

  /**
   * The frozen destinations with their connector display names. This is the
   * one digest statement still on the workspace runtime facade: it joins
   * `digest_delivery_targets` to `connector_connections`, a table the
   * connectors domain owns, and splitting the join is that domain's
   * conversion to make — both tables live in the same WorkspaceDO, so the
   * routed statement still reaches one database.
   */
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
