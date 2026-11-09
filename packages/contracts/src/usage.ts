import { z } from "zod";
import { RegionSchema } from "./regions";

/**
 * Usage quota metering: the plans, the metered activities, the event the
 * producers send, and the arithmetic every reader shares. The numbers here are
 * product limits set by the usage quota PRD
 * (docs/PRDs/2026-10-03_usage-quota-metering/prd.md), not defensive guesses.
 */

export const PLAN_IDS = ["starter", "growth"] as const;
export const PlanIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PLANS: Readonly<Record<PlanId, { name: string; monthlyPriceUsd: number }>> = {
  starter: { name: "Starter", monthlyPriceUsd: 100 },
  growth: { name: "Growth", monthlyPriceUsd: 250 },
};

/** Each plan includes twice its price in inference (PRD summary). */
export const INCLUDED_USAGE_MULTIPLIER = 2;

/** Below this percentage left, the meter turns to the warning color (PRD decision 13). */
export const LOW_QUOTA_PERCENT = 20;

const MICROUSD_PER_USD = 1_000_000;

/** Twice the monthly price divided by four, in micro-USD (PRD goal 1). */
export function weeklyQuotaMicrousd(plan: PlanId): number {
  return (PLANS[plan].monthlyPriceUsd * INCLUDED_USAGE_MULTIPLIER * MICROUSD_PER_USD) / 4;
}

export const METERED_ACTIVITIES = [
  "agent_run",
  "sidekick_run",
  "session_import",
  "context_compaction",
  "channel_naming",
  "channel_description",
  "breakout_summary",
  "attachment_summary",
  "attachment_naming",
  "work_opportunity",
  "addressing_classifier",
  "semantic_trigger_gate",
  // No producer since the conversation suggestions were deleted (2026-11);
  // kept so a usage event queued before that deploy still parses and bills.
  "turn_disposition_classifier",
  "completion_verification",
  // Retired with the conversation suggestions, kept for the same reason.
  "suggestion_draft",
  "memory_sweep",
  "memory_embedding",
  "search_embedding",
  "image_generation",
  "audio_generation",
  "message_speech",
  "dictation",
  "document_ocr",
] as const;
export const MeteredActivitySchema = z.enum(METERED_ACTIVITIES);
export type MeteredActivity = z.infer<typeof MeteredActivitySchema>;

/**
 * Who pays for each activity. `true`: the Organization pays and it counts
 * against quota and overage. `false`: Rally pays; it is still recorded, as
 * Rally-paid usage. Adding an activity without a choice here is a type error.
 */
export const ORGANIZATION_PAYS = {
  agent_run: true,
  sidekick_run: true,
  session_import: true,
  context_compaction: true,
  channel_naming: true,
  channel_description: true,
  breakout_summary: true,
  attachment_summary: true,
  attachment_naming: true,
  work_opportunity: true,
  addressing_classifier: true,
  semantic_trigger_gate: true,
  turn_disposition_classifier: true,
  completion_verification: true,
  suggestion_draft: true,
  memory_sweep: true,
  memory_embedding: true,
  search_embedding: true,
  image_generation: true,
  audio_generation: true,
  message_speech: true,
  dictation: true,
  document_ocr: true,
} as const satisfies Record<MeteredActivity, boolean>;

/** One metered call. Carries no prompt, output or tool argument. */
export const UsageEventSchema = z.object({
  v: z.literal(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  region: RegionSchema,
  activity: MeteredActivitySchema,
  occurredAt: z.string().datetime(),
  costMicrousd: z.number().int().nonnegative(),
  model: z.string().nullable(),
  refs: z.object({
    userId: z.string().optional(),
    workstreamId: z.string().optional(),
    substreamId: z.string().optional(),
    sidekickId: z.string().optional(),
  }),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

/** What `GET /usage` returns. Allowance and spend dollars never cross the wire. */
export const OrganizationUsageSchema = z.object({
  plan: PlanIdSchema,
  quotaRemainingPercent: z.number().int().min(0).max(100),
  weekResetsAt: z.string().datetime(),
  overage: z.object({
    amountMicrousd: z.number().int().nonnegative(),
    periodStart: z.string().datetime(),
    periodEndsAt: z.string().datetime(),
    billed: z.literal(false),
  }),
});
export type OrganizationUsage = z.infer<typeof OrganizationUsageSchema>;

/** Sent on the workspace socket after a plan change; see docs/usage-metering.md. */
export const WorkspaceUsageEventSchema = z.strictObject({
  type: z.literal("workspace_usage"),
  occurredAt: z.string().datetime(),
  usage: OrganizationUsageSchema,
});
export type WorkspaceUsageEvent = z.infer<typeof WorkspaceUsageEventSchema>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The start of the 7-day quota week containing `at`, anchored to creation. */
export function usageWeekStart(createdAtMs: number, atMs: number): number {
  return createdAtMs + WEEK_MS * Math.floor((atMs - createdAtMs) / WEEK_MS);
}

export function usageWeekEnd(createdAtMs: number, atMs: number): number {
  return usageWeekStart(createdAtMs, atMs) + WEEK_MS;
}

/** The creation instant's day and time of day in the given UTC month, clamped to its last day. */
function anniversaryIn(created: Date, year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(created.getUTCDate(), lastDay),
    created.getUTCHours(),
    created.getUTCMinutes(),
    created.getUTCSeconds(),
    created.getUTCMilliseconds(),
  );
}

/**
 * The monthly overage period containing `at`: from the latest sign-up
 * anniversary at or before it to the next one (PRD decision 10).
 */
export function usagePeriod(createdAtMs: number, atMs: number): { start: number; end: number } {
  const created = new Date(createdAtMs);
  const at = new Date(atMs);
  let year = at.getUTCFullYear();
  let month = at.getUTCMonth();
  if (anniversaryIn(created, year, month) > atMs) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  const start = anniversaryIn(created, year, month);
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  return { start, end: anniversaryIn(created, nextYear, nextMonth) };
}

/** One `usage_rollups` row as the read path sees it. */
export interface UsageRollup {
  weekStart: number;
  periodStart: number;
  quotaMicrousd: number;
  organizationMicrousd: number;
}

/**
 * Derive the meter from rollups (PRD decision 7). Overage is the part of a
 * week's total above that week's quota; in a week split across two periods the
 * earlier part uses the quota first, so the answer never depends on the order
 * events arrived in.
 */
export function deriveOrganizationUsage(input: {
  plan: PlanId;
  createdAtMs: number;
  nowMs: number;
  rollups: readonly UsageRollup[];
}): OrganizationUsage {
  const { createdAtMs, nowMs } = input;
  const currentWeek = usageWeekStart(createdAtMs, nowMs);
  const period = usagePeriod(createdAtMs, nowMs);
  const weeks = new Map<number, UsageRollup[]>();
  for (const row of input.rollups) {
    const parts = weeks.get(row.weekStart) ?? [];
    parts.push(row);
    weeks.set(row.weekStart, parts);
  }
  let overage = 0;
  let remainingPercent = 100;
  for (const [weekStart, parts] of weeks) {
    parts.sort((a, b) => a.periodStart - b.periodStart);
    const quota = parts[parts.length - 1]!.quotaMicrousd;
    let spent = 0;
    for (const part of parts) {
      const over = Math.max(0, spent + part.organizationMicrousd - quota) - Math.max(0, spent - quota);
      spent += part.organizationMicrousd;
      if (part.periodStart === period.start) overage += over;
    }
    if (weekStart === currentWeek) {
      remainingPercent = quota > 0 ? Math.max(0, Math.floor(100 - (spent * 100) / quota)) : 0;
    }
  }
  return {
    plan: input.plan,
    quotaRemainingPercent: Math.min(100, remainingPercent),
    weekResetsAt: new Date(usageWeekEnd(createdAtMs, nowMs)).toISOString(),
    overage: {
      amountMicrousd: Math.round(overage),
      periodStart: new Date(period.start).toISOString(),
      periodEndsAt: new Date(period.end).toISOString(),
      billed: false,
    },
  };
}

/** Moving an Organization to a plan: an operator from Ace, or an administrator from Settings. */
export const WorkspacePlanChangeSchema = z.strictObject({ plan: PlanIdSchema });
export const WorkspacePlanResultSchema = z.strictObject({ workspaceId: z.string().uuid(), plan: PlanIdSchema });
export type WorkspacePlanResult = z.infer<typeof WorkspacePlanResultSchema>;
