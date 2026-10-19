/**
 * One-shot prompt wake-ups for a work stream.
 *
 * A run can ask to be woken later — "in two hours", or "on 12 August at 5:26pm
 * Pacific" — with the prompt it wants delivered when that instant arrives. The
 * canonical row lives in `workstream_wakeups`; the workspace scheduler Durable
 * Object owns the alarm that fires it, exactly as it already does for recurring
 * schedules and resource watches.
 *
 * This module holds everything that has no opinion about the harness: time
 * resolution, the limits, and the SQL. The tool surface lives in
 * `integrations.ts` and the firing side lives in `workstream-service.ts`, so
 * neither of those has to import the other through here.
 */
import type { ExecutionPrincipal } from "@rally/contracts";
import {
  ExecutionPrincipalSchema,
  MAXIMUM_FAILURE_AVAILABLE_VALUES,
  MAXIMUM_FAILURE_VALUE_LENGTH,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { newId } from "@rally/db";
import { z } from "zod";

import type { Env } from "../env";
import type { SchedulingObjectPort } from "../durable-objects/workstream-scheduling-protocol";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * One minute, applied to the resolved instant — so it binds an absolute `at`
 * exactly as it binds a relative `delay`.
 *
 * Second-granularity units are still accepted input: "90 sec" is a legitimate
 * wake-up. It is the resulting instant that has to clear a minute, because
 * every wake-up starts a full harness run, and anything sooner than that is
 * work the current run should simply do itself.
 */
export const MINIMUM_WAKEUP_DELAY_SECONDS = 60;
/** A year is far past any work stream's useful life; beyond it a wake-up is a lost row, not a plan. */
export const MAXIMUM_WAKEUP_DELAY_SECONDS = 365 * 24 * 60 * 60;
/** Hard, principal-independent cap: identical calls succeed or fail for reasons the model can predict. */
export const MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM = 20;
export const MAXIMUM_WAKEUP_PROMPT_LENGTH = 4_000;

export const WorkstreamWakeupRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  workstream_id: z.string().min(1),
  execution_principal_json: z.string(),
  prompt: z.string(),
  due_at: z.string(),
  status: z.enum(["pending", "fired", "cancelled"]),
  version: z.number().int().nonnegative(),
  created_at: z.string(),
});

export type WorkstreamWakeupRow = z.infer<typeof WorkstreamWakeupRowSchema>;

export interface PendingWakeup {
  wakeupId: string;
  dueAt: string;
  prompt: string;
}

/**
 * A deterministic rejection the model can act on.
 *
 * These use the harness's classified tool-failure path. A stable code keeps a
 * deterministic refusal definitive while `details.reason` carries the shortest
 * safe correction into the model-visible failed result.
 */
export class WakeupInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    reason: string,
    available?: string[],
  ) {
    super(message);
    this.name = "WakeupInputError";
    const boundedAvailable = (available ?? [])
      .filter((candidate) => candidate.length <= MAXIMUM_FAILURE_VALUE_LENGTH)
      .slice(0, MAXIMUM_FAILURE_AVAILABLE_VALUES);
    this.details = {
      reason,
      ...(boundedAvailable.length ? { available: boundedAvailable } : {}),
    };
  }

  readonly details: { reason: string; available?: string[] };
}

/** Canonicalize an IANA zone, rejecting anything `Intl` will not accept. */
export function canonicalWakeupTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new WakeupInputError(
      "wakeup_timezone_invalid",
      `Invalid IANA timezone: ${timezone}`,
      "Pass an IANA timezone such as America/Los_Angeles, or omit timezone to use this thread's local zone.",
    );
  }
}

/**
 * Every spelling of a duration unit this tool accepts.
 *
 * The list is deliberately generous about how a unit is written and strict
 * about everything else: a model that reaches for "5 min", "5m", or
 * "5 minutes" should not have to guess which one this tool wanted, but a
 * unit it invents has to fail loudly rather than be silently dropped.
 */
const DELAY_UNIT_SECONDS = new Map<string, number>([
  ["s", 1], ["sec", 1], ["secs", 1], ["second", 1], ["seconds", 1],
  ["m", 60], ["min", 60], ["mins", 60], ["minute", 60], ["minutes", 60],
  ["h", 3_600], ["hr", 3_600], ["hrs", 3_600], ["hour", 3_600], ["hours", 3_600],
  ["d", 86_400], ["day", 86_400], ["days", 86_400],
  ["w", 604_800], ["week", 604_800], ["weeks", 604_800],
]);

/** Named in every delay rejection, so a retry does not have to guess the vocabulary. */
export const ACCEPTED_DELAY_UNITS_HINT = [
  "Accepted units are seconds (s, sec, secs, second, seconds),",
  "minutes (m, min, mins, minute, minutes),",
  "hours (h, hr, hrs, hour, hours),",
  "days (d, day, days), and weeks (w, week, weeks).",
  "Write a whole number before each unit and combine larger units with smaller ones, for example",
  "\"5 minutes\", \"90 sec\", \"2 hours\", \"1h30m\", or the ISO-8601 duration \"PT2H30M\".",
  "The resulting time must be at least one minute from now.",
].join(" ");

/** Named in every `at` rejection. */
export const ACCEPTED_TIMESTAMP_HINT = [
  "Pass a full ISO-8601 date and time.",
  "Either offset-bearing and absolute, for example \"2026-08-12T17:26:00-07:00\" or \"2026-08-12T17:26:00Z\",",
  "or a local reading with no offset, for example \"2026-08-12T17:26\", paired with timezone.",
  "A date alone, a time alone, or words such as \"tomorrow\" are not accepted.",
].join(" ");

/** `<number><unit>` terms, optionally separated by spaces or commas: "1h30m", "2 hours 15 minutes". */
const DELAY_TERM = /(\d+)\s*([a-z]+)/giu;
const DELAY_GRAMMAR = /^(?:\d+\s*[a-z]+[\s,]*)+$/iu;
/** ISO-8601 duration, days and below. Weeks and months are excluded as separate grammars. */
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;

/**
 * A full ISO-8601 timestamp, offset optional.
 *
 * Deliberately not `Date.parse`, which accepts a bare date, a bare year, and a
 * pile of non-ISO strings, silently turning "2026-08-12" into midnight UTC —
 * twelve hours from what a person writing that meant.
 */
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/iu;

/**
 * Parse a human or ISO-8601 duration into whole seconds.
 *
 * Strict on every axis that could silently mean the wrong thing: a bare number
 * has no unit to trust, a fraction has no rounding this tool is entitled to
 * choose, and a repeated unit is more likely a typo than a sum.
 */
export function parseWakeupDelay(raw: string): number {
  const text = raw.trim();
  if (text.length === 0) {
    throw new WakeupInputError(
      "wakeup_delay_invalid",
      "delay is empty",
      ACCEPTED_DELAY_UNITS_HINT,
    );
  }

  const isoDuration = ISO_DURATION.exec(text.toUpperCase());
  if (isoDuration && text.toUpperCase() !== "P") {
    const [, days, hours, minutes, seconds] = isoDuration;
    if (!days && !hours && !minutes && !seconds) {
      throw new WakeupInputError(
        "wakeup_delay_invalid",
        `delay names no amount of time: ${text}`,
        ACCEPTED_DELAY_UNITS_HINT,
      );
    }
    return Number(days ?? 0) * 86_400
      + Number(hours ?? 0) * 3_600
      + Number(minutes ?? 0) * 60
      + Number(seconds ?? 0);
  }

  if (/^\d+$/u.test(text)) {
    throw new WakeupInputError(
      "wakeup_delay_unit_missing",
      `delay needs a unit: ${text} could mean seconds, minutes, or hours`,
      ACCEPTED_DELAY_UNITS_HINT,
    );
  }
  if (/\d+\s*\.\s*\d/u.test(text) || /\d\.\d/u.test(text)) {
    throw new WakeupInputError(
      "wakeup_delay_invalid",
      `delay must use whole numbers: ${text}`,
      `Combine units instead of using a fraction — write "1h30m" rather than "1.5h". ${ACCEPTED_DELAY_UNITS_HINT}`,
    );
  }
  if (!DELAY_GRAMMAR.test(text)) {
    throw new WakeupInputError(
      "wakeup_delay_invalid",
      `Could not read delay as a duration: ${text}`,
      ACCEPTED_DELAY_UNITS_HINT,
    );
  }

  let totalSeconds = 0;
  const seenUnits = new Set<number>();
  DELAY_TERM.lastIndex = 0;
  for (let term = DELAY_TERM.exec(text); term !== null; term = DELAY_TERM.exec(text)) {
    const unit = term[2]!.toLowerCase();
    const unitSeconds = DELAY_UNIT_SECONDS.get(unit);
    if (unitSeconds === undefined) {
      throw new WakeupInputError(
        "wakeup_delay_unit_unknown",
        `delay uses an unrecognized unit: ${term[2]}`,
        ACCEPTED_DELAY_UNITS_HINT,
      );
    }
    if (seenUnits.has(unitSeconds)) {
      throw new WakeupInputError(
        "wakeup_delay_invalid",
        `delay repeats the same unit: ${text}`,
        `State each unit once and add them in order, largest first. ${ACCEPTED_DELAY_UNITS_HINT}`,
      );
    }
    seenUnits.add(unitSeconds);
    totalSeconds += Number(term[1]) * unitSeconds;
  }
  return totalSeconds;
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  // formatToParts drops sub-second precision, so compare against a whole second.
  return asIfUtc - Math.floor(instant.getTime() / 1_000) * 1_000;
}

/**
 * Resolve a wall-clock reading in `timeZone` to the UTC instant it names.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so guess with the offset in force at the naive value and correct once
 * with the offset in force at the guess. Two passes is exact everywhere except
 * the hour a DST transition skips or repeats, where any answer is a choice and
 * the resolved instant is echoed back to the caller in local terms.
 */
function instantFromLocalWallClock(naiveAsIfUtcMs: number, timeZone: string): number {
  const firstGuess = naiveAsIfUtcMs - zoneOffsetMs(new Date(naiveAsIfUtcMs), timeZone);
  return naiveAsIfUtcMs - zoneOffsetMs(new Date(firstGuess), timeZone);
}

export interface WakeupInstantRequest {
  delay?: string | undefined;
  at?: string | undefined;
  timezone?: string | undefined;
  /** The work stream's local zone, used when `at` carries no offset and no `timezone` is given. */
  defaultTimezone: string;
  now: Date;
}

export interface ResolvedWakeupInstant {
  dueAt: Date;
  /** The zone the result is reported in — the requested one, else the work stream's. */
  timezone: string;
}

/**
 * Turn "in N seconds" or a timestamp into one UTC instant.
 *
 * Exactly one of `delay` and `at` must be present. An `at` that already carries
 * an offset is absolute; one without is read in `timezone`, which is how
 * "August 12th at 5:26pm Pacific" arrives without the model having to know
 * whether that date is on daylight time.
 */
export function resolveWakeupInstant(request: WakeupInstantRequest): ResolvedWakeupInstant {
  const hasDelay = request.delay !== undefined;
  const hasAt = request.at !== undefined;
  if (hasDelay && hasAt) {
    throw new WakeupInputError(
      "wakeup_time_ambiguous",
      "delay and at cannot both be set",
      `Pass delay for a relative wake-up or at for a specific time, never both. ${ACCEPTED_DELAY_UNITS_HINT} ${ACCEPTED_TIMESTAMP_HINT}`,
    );
  }
  if (!hasDelay && !hasAt) {
    throw new WakeupInputError(
      "wakeup_time_missing",
      "A wake-up needs a time",
      `Pass delay for a relative wake-up, or at for a specific time. ${ACCEPTED_DELAY_UNITS_HINT} ${ACCEPTED_TIMESTAMP_HINT}`,
    );
  }

  const timezone = canonicalWakeupTimezone(request.timezone ?? request.defaultTimezone);
  const dueAt = hasDelay
    ? new Date(request.now.getTime() + parseWakeupDelay(request.delay!) * 1_000)
    : resolveTimestamp(request.at!, request.timezone, timezone);
  // Both bounds below apply to the resolved instant, so either form can trip
  // them. Quote the grammar of the form the caller actually used — telling a
  // caller who passed `at` about duration units is not a recovery path.
  const formHint = hasDelay ? ACCEPTED_DELAY_UNITS_HINT : ACCEPTED_TIMESTAMP_HINT;

  const delayMs = dueAt.getTime() - request.now.getTime();
  if (delayMs < MINIMUM_WAKEUP_DELAY_SECONDS * 1_000) {
    throw new WakeupInputError(
      "wakeup_too_soon",
      `That time is ${Math.round(delayMs / 1_000)} seconds away, and a wake-up must be at least ${MINIMUM_WAKEUP_DELAY_SECONDS} seconds away`,
      `Pick a time at least ${MINIMUM_WAKEUP_DELAY_SECONDS} seconds from now, or do the work in this run instead of scheduling it. ${formHint}`,
    );
  }
  if (delayMs > MAXIMUM_WAKEUP_DELAY_SECONDS * 1_000) {
    throw new WakeupInputError(
      "wakeup_too_distant",
      `That time is ${Math.round(delayMs / 86_400_000)} days away, and a wake-up must be within ${MAXIMUM_WAKEUP_DELAY_SECONDS / 86_400} days`,
      `Pick a time within one year from now. ${formHint}`,
    );
  }
  return { dueAt, timezone };
}

/** Read one exact ISO-8601 timestamp, offset-bearing or local. */
function resolveTimestamp(
  raw: string,
  requestedTimezone: string | undefined,
  timezone: string,
): Date {
  const text = raw.trim();
  const parsed = ISO_TIMESTAMP.exec(text);
  if (!parsed) {
    throw new WakeupInputError(
      "wakeup_time_invalid",
      `Could not read at as an ISO-8601 timestamp: ${text}`,
      ACCEPTED_TIMESTAMP_HINT,
    );
  }
  const [, year, month, day, hour, minute, second, millisecond, offset] = parsed;
  const fields = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? "0"),
    millisecond: Number((millisecond ?? "").padEnd(3, "0") || "0"),
  };
  const asIfUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  );
  // Date.UTC rolls a bad field over rather than failing — month 13 becomes the
  // next January, 31 February becomes March. Round-trip it so an impossible
  // date is rejected instead of quietly becoming a different one.
  const roundTripped = new Date(asIfUtc);
  if (
    roundTripped.getUTCFullYear() !== fields.year
    || roundTripped.getUTCMonth() !== fields.month - 1
    || roundTripped.getUTCDate() !== fields.day
    || roundTripped.getUTCHours() !== fields.hour
    || roundTripped.getUTCMinutes() !== fields.minute
    || roundTripped.getUTCSeconds() !== fields.second
  ) {
    throw new WakeupInputError(
      "wakeup_time_invalid",
      `at names a date or time that does not exist: ${text}`,
      ACCEPTED_TIMESTAMP_HINT,
    );
  }

  if (!offset) {
    // A local reading with no `timezone` is resolved in the work stream's own
    // zone, which is the reading whoever wrote it would expect.
    return new Date(instantFromLocalWallClock(asIfUtc, timezone));
  }
  if (requestedTimezone !== undefined) {
    // The offset and the zone are two answers to the same question. Picking one
    // silently is how a wake-up lands seven hours from where it was meant.
    throw new WakeupInputError(
      "wakeup_time_ambiguous",
      `at already carries the UTC offset ${offset}, so timezone would be a second, conflicting answer`,
      `Either drop timezone and keep the offset in at, or drop the offset from at and keep timezone. ${ACCEPTED_TIMESTAMP_HINT}`,
    );
  }
  if (offset.toUpperCase() === "Z") return new Date(asIfUtc);
  const offsetSign = offset.startsWith("-") ? -1 : 1;
  const offsetHours = Number(offset.slice(1, 3));
  const offsetMinutes = Number(offset.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new WakeupInputError(
      "wakeup_time_invalid",
      `at carries an impossible UTC offset: ${offset}`,
      ACCEPTED_TIMESTAMP_HINT,
    );
  }
  return new Date(asIfUtc - offsetSign * (offsetHours * 3_600_000 + offsetMinutes * 60_000));
}

/** Render an instant the way a person reading the transcript would write it. */
export function formatWakeupLocalTime(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${timezone}`;
}

/**
 * The scheduling rows, reached through the object rather than routed SQL.
 *
 * Every function below took a `D1Database` whose statements were rewritten onto
 * `_runtime_wakeups`, a compatibility view whose INSTEAD OF triggers renamed
 * `wakeup_id` to `id`, invented `workspace_id` and `workstream_id` from the
 * object's identity row, and converted unix milliseconds to ISO-8601 in both
 * directions. They take a port now: the same intents, one round trip each, and
 * the compare-and-swap that used to be spelled out in a `WHERE … version = ?`
 * clause is a read and a write inside one object transaction.
 *
 * The ISO strings survive at this boundary rather than in the rows. A wake-up's
 * `due_at` reaches a member, an alarm and a tool result as text, so the object's
 * unix milliseconds are formatted here, once, on the way out.
 */

export async function countPendingWorkstreamWakeups(
  scheduling: SchedulingObjectPort,
): Promise<number> {
  return scheduling.pendingWakeupCount();
}

export async function listPendingWorkstreamWakeups(
  scheduling: SchedulingObjectPort,
): Promise<PendingWakeup[]> {
  const rows = await scheduling.pendingWakeups({
    limit: MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM,
  });
  return rows.map((row) => ({
    wakeupId: row.wakeup_id,
    dueAt: new Date(row.due_at).toISOString(),
    prompt: row.prompt,
  }));
}

export async function findWorkstreamWakeupByIdempotencyKey(
  scheduling: SchedulingObjectPort,
  idempotencyKey: string,
): Promise<{ wakeupId: string; dueAt: string; prompt: string; status: string } | null> {
  const row = await scheduling.wakeupByIdempotencyKey({ idempotencyKey });
  return row
    ? {
      wakeupId: row.wakeup_id,
      dueAt: new Date(row.due_at).toISOString(),
      prompt: row.prompt,
      status: row.status,
    }
    : null;
}

/**
 * Insert one pending wake-up.
 *
 * The unique idempotency key makes a replayed tool receipt resolve to the row
 * the first attempt created instead of scheduling a second wake-up. The routed
 * statement learned which had happened by reading `meta.changes` and then
 * re-reading the table; the operation answers it directly, and answers the
 * third case — an archived work stream, which the routed version expressed as a
 * `SELECT … FROM workstreams WHERE archived_at IS NULL` that simply inserted
 * nothing — as its own outcome rather than as an indistinguishable zero.
 */
export async function createWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  input: {
    harnessRunId: string;
    executionPrincipal: ExecutionPrincipal;
    prompt: string;
    dueAt: Date;
    idempotencyKey: string;
  },
): Promise<{ wakeupId: string; created: boolean }> {
  const now = Date.now();
  const { outcome, wakeupId } = await scheduling.scheduleWakeup({
    wakeupId: newId(),
    createdByRunId: input.harnessRunId,
    executionPrincipalJson: JSON.stringify(input.executionPrincipal),
    prompt: input.prompt,
    dueAt: input.dueAt.getTime(),
    idempotencyKey: input.idempotencyKey,
    now,
  });
  if (outcome === "workstream_archived") throw new Error("workstream_wakeup_target_unavailable");
  return { wakeupId, created: outcome === "scheduled" };
}

/**
 * Undo an insert whose alarm could not be armed.
 *
 * Arming needs the row to exist, so the two cannot be one atomic step. When the
 * second half fails, removing the first is what keeps the states honest: either
 * a wake-up exists with an alarm behind it, or it does not exist and the caller
 * was told so. A pending row with no alarm is the one outcome that lies.
 */
export async function deleteUnarmedWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  input: { wakeupId: string },
): Promise<void> {
  await scheduling.deleteUnarmedWakeup({ wakeupId: input.wakeupId });
}

export async function cancelWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  input: { wakeupId: string },
): Promise<"cancelled" | "not_pending" | "not_found"> {
  return scheduling.cancelWakeup({ wakeupId: input.wakeupId, now: Date.now() });
}

/**
 * Take exclusive ownership of a due wake-up.
 *
 * Claiming before the run starts biases the whole path to at-most-once: a
 * crash after the claim loses a wake-up, where a crash after an unclaimed
 * launch would start the same prompt twice and repeat whatever external writes
 * it makes. A launch that fails cleanly releases the claim below.
 */
export async function claimDueWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  row: Pick<WorkstreamWakeupRow, "id" | "version">,
): Promise<boolean> {
  return scheduling.claimDueWakeup({
    wakeupId: row.id,
    expectedVersion: row.version,
    now: Date.now(),
  });
}

/** Undo a claim whose run never started, so the next alarm retries it. */
export async function releaseClaimedWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  row: Pick<WorkstreamWakeupRow, "id">,
): Promise<void> {
  await scheduling.releaseClaimedWakeup({ wakeupId: row.id, now: Date.now() });
}

export async function loadWorkstreamWakeup(
  scheduling: SchedulingObjectPort,
  workspaceId: string,
  workstreamId: string,
  wakeupId: string,
): Promise<WorkstreamWakeupRow | null> {
  const row = await scheduling.wakeup({ wakeupId });
  if (!row) return null;
  // The identity columns the view fabricated from the object's own root row.
  // They are still the shape callers pass around, so they are supplied here
  // from the identity the caller used to reach the object — which is the only
  // place they were ever true.
  return WorkstreamWakeupRowSchema.parse({
    id: row.wakeup_id,
    workspace_id: workspaceId,
    workstream_id: workstreamId,
    execution_principal_json: row.execution_principal_json,
    prompt: row.prompt,
    due_at: new Date(row.due_at).toISOString(),
    status: row.status,
    version: row.version,
    created_at: new Date(row.created_at).toISOString(),
  });
}

export function wakeupExecutionPrincipal(row: WorkstreamWakeupRow): ExecutionPrincipal {
  return ExecutionPrincipalSchema.parse(JSON.parse(row.execution_principal_json));
}

/**
 * Reconcile a workspace's alarm index against its own tables.
 *
 * Every canonical mutation of a due time has to do this, or the row sits in its
 * durable authority until some unrelated target wakes the same workspace.
 */
export async function refreshWorkspaceSchedule(
  env: Pick<Env, "DB" | "WORKSPACE_DOS" | "AVALON_REGION" | "APP_ENV">,
  workspaceId: string,
): Promise<void> {
  // Focused unit environments omit the namespace deliberately — the same
  // allowance `withWorkspaceRuntimeDatabase` makes, and for the same reason:
  // binding it pulls this workspace's whole SQL surface into the test. The
  // environment contract requires it before request dispatch, so production
  // never reaches this branch.
  if (!env.WORKSPACE_DOS) return;
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  await workspace.refreshSchedule(workspaceId);
}

/**
 * Arm the object that holds this conversation's wake-ups.
 *
 * That is the conversation whose run scheduled them — the main child, a
 * Breakout, or a Sidekick run child — the same object the scheduling port
 * wrote to. This once took no substream id, back when every wake-up lived in
 * the main child; once the tools wrote a child's wake-ups to the child, an
 * arm sent to the main child reconciled an object with no such row while the
 * one that held it went unarmed.
 *
 * This is still needed beside the endpoint's own arming, which is deliberately
 * best-effort and swallowed: the endpoint cannot fail a committed write just
 * because the alarm did not set, so somebody outside the transaction has to be
 * able to see that failure and roll the row back.
 */
export async function refreshAgentTimerAlarm(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  substreamId: string,
): Promise<void> {
  const agent = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(
      env.AVALON_REGION,
      asWorkspaceId(workspaceId),
      asWorkstreamId(workstreamId),
      asSubstreamId(substreamId),
    ),
  );
  await agent.refreshTimerAlarm({
    workspaceId: asWorkspaceId(workspaceId),
    workstreamId: asWorkstreamId(workstreamId),
    substreamId: asSubstreamId(substreamId),
  });
}
