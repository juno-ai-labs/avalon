import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { isRetiredMeetingTelemetry, TelemetryEnvelopeSchema, type TelemetryEnvelope } from "@rally/contracts/telemetry";
import type { Env } from "../env";
import { logWarn } from "../observability/logger";
import {
  telemetryDeliveryRpcCall,
  type GlobalTelemetryDeliveryRow,
  type TelemetryDestinationResult,
} from "./telemetry-delivery-contract";
import { processProfileOutbox } from "./profile-delivery";
import { symbolicateJavascriptFrames } from "./javascript-symbolication";
import { destinationCircuitAllows, recordDestinationOutcome } from "./operations";

export interface TelemetryDeliverySummary {
  selected: number;
  delivered: number;
  retried: number;
  terminal: number;
  suppressed: number;
  expired: number;
  unparseable: number;
}

interface DeliveryDatabaseRow {
  event_id: string;
  envelope_json: string;
  analytics_subject_id: string;
  workspace_analytics_id: string | null;
  normalized_timestamp: string;
  attempt_count: number;
  delete_at: string;
  subject_user_id: string | null;
  accepted_at: string;
  product_analytics_enabled: number | null;
}

interface ParsedDeliveryRow {
  row: DeliveryDatabaseRow;
  envelope: TelemetryEnvelope;
}

async function reapExpiredTelemetry(env: Env, now: string): Promise<number> {
  const tables = {
    telemetry_accepted_events: "TELEMETRY_DB",
    telemetry_delivery_receipts: "TELEMETRY_DB",
    telemetry_replay_audit: "TELEMETRY_DB",
    telemetry_crash_access_audit: "DB",
    telemetry_identity_links: "DB",
    telemetry_ingest_rate_buckets: "DB",
    telemetry_onboarding_journeys: "DB",
    telemetry_profile_jobs: "DB",
    telemetry_rejection_buckets: "DB",
  } as const;
  let expired = 0;
  for (const [table, binding] of Object.entries(tables)) {
    const db = env[binding];
    const row = await db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE delete_at <= ?`,
    ).bind(now).first<{ count: number }>();
    expired += row?.count ?? 0;
    await db.prepare(`DELETE FROM ${table} WHERE delete_at <= ?`).bind(now).run();
  }
  return expired;
}

function deliveryRow({ row, envelope }: ParsedDeliveryRow): GlobalTelemetryDeliveryRow {
  return {
    eventId: row.event_id,
    envelope,
    analyticsSubjectId: row.analytics_subject_id,
    workspaceAnalyticsId: row.workspace_analytics_id,
    normalizedTimestamp: row.normalized_timestamp,
  };
}

async function javascriptDeliveryRow(
  env: Env,
  row: ParsedDeliveryRow,
): Promise<GlobalTelemetryDeliveryRow> {
  const delivery = deliveryRow(row);
  if (delivery.envelope.name !== "javascript_exception") return delivery;
  const properties = delivery.envelope.properties as {
    process: "main" | "preload" | "renderer";
    generatedFrames: string[];
  };
  return {
    ...delivery,
    symbolicatedFrames: await symbolicateJavascriptFrames(env.TELEMETRY_PAYLOADS, {
      release: delivery.envelope.context.release,
      buildId: delivery.envelope.context.buildId,
      process: properties.process,
      generatedFrames: properties.generatedFrames,
    }),
  };
}

function backoffMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(attemptCount, 6));
}

function nextAttemptAt(row: DeliveryDatabaseRow, now: Date, retryAfterMs: number | null): string {
  const delay = retryAfterMs ?? backoffMs(row.attempt_count);
  return new Date(Math.min(Date.parse(row.delete_at), now.getTime() + delay)).toISOString();
}

/**
 * The stored envelope under the running contract, or the code naming why not.
 *
 * A row accepted by a newer contract (an enum value added, then the API rolled
 * back) fails here. It must not throw: one such row at the head of the page
 * would stall every PostHog delivery behind it.
 */
function parseStoredEnvelope(row: DeliveryDatabaseRow): { envelope: TelemetryEnvelope } | { code: string } {
  let stored: unknown;
  try {
    stored = JSON.parse(row.envelope_json);
  } catch {
    return { code: "stored_envelope_invalid" };
  }
  const parsed = TelemetryEnvelopeSchema.safeParse(stored);
  if (parsed.success) return { envelope: parsed.data as TelemetryEnvelope };
  return { code: zodDiagnosticCode(parsed.error, "stored_envelope") ?? "stored_envelope_invalid" };
}

/**
 * Parks a row the running contract cannot read on the ordinary backoff, with
 * the reason in `terminal_code`. It stays retrying rather than terminal so a
 * roll-forward to the contract that accepted it delivers it before `delete_at`.
 */
async function parkUnparseableRow(env: Env, row: DeliveryDatabaseRow, code: string, now: Date): Promise<void> {
  logWarn(env, "telemetry_delivery_row_unparseable", { event_id: row.event_id, error_code: code });
  await env.TELEMETRY_DB.prepare(
    `UPDATE telemetry_accepted_events
     SET delivery_state = 'retrying', attempt_count = attempt_count + 1,
         next_attempt_at = ?, terminal_code = ?
     WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
  ).bind(nextAttemptAt(row, now, null), code, row.event_id).run();
}

/**
 * Rows one delivery page selects, sends as one PostHog batch and settles as one
 * D1 batch. Not a guard: the shape every page has had since delivery shipped.
 */
export const TELEMETRY_DELIVERY_PAGE_SIZE = 50;

/**
 * How long one pass may keep taking pages: the Worker's cron period, five
 * minutes, transcribed from the `crons` trigger in `apps/api/wrangler.global.jsonc`
 * (read 2026-10-30). A pass that outlives its tick overlaps the next one, and two
 * passes selecting the same `pending` rows send PostHog the same events twice.
 * The pass stops before a page that would cross this line, so a tick ends with
 * at most one page in flight past it.
 */
export const TELEMETRY_DELIVERY_PASS_BUDGET_MS = 5 * 60_000;

/**
 * Service Binding calls one pass may make. A request may invoke at most 32
 * Workers, each Service Binding call counting one, and the next call throws
 * (Cloudflare, Service Bindings limits, read 2026-10-30). The budget is that
 * cap less what the rest of the same tick can spend on `TELEMETRY_DELIVERY`:
 * `processProfileOutbox` makes one call per job for up to 20 jobs, and
 * `processCrashOutbox` one per report for up to 5. A page needs up to two
 * calls, one per batch method, so the pass starts a page only while two remain.
 * D1 is not the tighter bound: a page makes about six queries against the
 * 1,000 per invocation D1 allows, and a `batch()` counts as one.
 */
export const TELEMETRY_DELIVERY_PASS_RPC_BUDGET = 32 - 20 - 5;

export interface TelemetryDeliveryOptions {
  pageSize?: number;
  passBudgetMs?: number;
  passRpcBudget?: number;
}

interface TelemetryDeliveryPageContext {
  telemetryDelivery: NonNullable<Env["TELEMETRY_DELIVERY"]>;
  postHogHost: string;
  postHogProjectToken: string;
  pageSize: number;
  captureAllowed: boolean;
  exceptionAllowed: boolean;
}

/** The last row a page read, so the next page starts after it. */
interface DeliveryCursor {
  acceptedAt: string;
  eventId: string;
}

interface DeliveryPageOutcome {
  /** True when the page was full and every row in it was settled or held. */
  continues: boolean;
  /** Service Binding calls the page made. */
  rpcCalls: number;
  /** Where the next page starts; null when the page read nothing. */
  cursor: DeliveryCursor | null;
}

/**
 * Drains the outbox toward PostHog in pages of `pageSize` rows, in acceptance
 * order, and stops at the first of: a page that is not full, a page that leaves
 * a row behind for a reason other than an identity-transition hold, the next
 * page not fitting the pass's RPC budget, or the next page carrying the pass
 * past its time budget.
 *
 * A retried page ends the pass because the destination is refusing and the
 * next page would be refused too. A row held for an identity transition is
 * paged past: it stays `pending` at the head of the order, and the cursor
 * keeps the pass from re-reading it, so the rows behind it are not held with
 * it. It is read again next tick.
 */
export async function processTelemetryOutbox(
  env: Env,
  options: TelemetryDeliveryOptions = {},
): Promise<TelemetryDeliverySummary> {
  const pageSize = options.pageSize ?? TELEMETRY_DELIVERY_PAGE_SIZE;
  const passBudgetMs = options.passBudgetMs ?? TELEMETRY_DELIVERY_PASS_BUDGET_MS;
  const passRpcBudget = options.passRpcBudget ?? TELEMETRY_DELIVERY_PASS_RPC_BUDGET;
  const passStartedAt = Date.now();
  const summary: TelemetryDeliverySummary = {
    selected: 0,
    delivered: 0,
    retried: 0,
    terminal: 0,
    suppressed: 0,
    expired: await reapExpiredTelemetry(env, new Date(passStartedAt).toISOString()),
    unparseable: 0,
  };
  const telemetryDelivery = env.TELEMETRY_DELIVERY;
  const postHogHost = env.POSTHOG_HOST;
  const postHogProjectToken = env.POSTHOG_PROJECT_TOKEN;
  if (!postHogHost
    || !postHogProjectToken
    || !telemetryDelivery) return summary;
  await processProfileOutbox(env);
  const now = new Date(passStartedAt);
  const [captureAllowed, exceptionAllowed] = await Promise.all([
    destinationCircuitAllows(env, "posthog_capture", now),
    destinationCircuitAllows(env, "posthog_javascript_exception", now),
  ]);
  if (!captureAllowed && !exceptionAllowed) return summary;
  const context: TelemetryDeliveryPageContext = {
    telemetryDelivery,
    postHogHost,
    postHogProjectToken,
    pageSize,
    captureAllowed,
    exceptionAllowed,
  };

  let longestPageMs = 0;
  let rpcCalls = 0;
  let cursor: DeliveryCursor | null = null;
  while (rpcCalls + 2 <= passRpcBudget) {
    const pageStartedAt = Date.now();
    const page = await deliverTelemetryPage(env, context, summary, cursor);
    longestPageMs = Math.max(longestPageMs, Date.now() - pageStartedAt);
    rpcCalls += page.rpcCalls;
    cursor = page.cursor;
    if (!page.continues) break;
    if (Date.now() - passStartedAt + longestPageMs > passBudgetMs) break;
  }
  return summary;
}

/** One page of the outbox, starting after `cursor`. */
async function deliverTelemetryPage(
  env: Env,
  context: TelemetryDeliveryPageContext,
  summary: TelemetryDeliverySummary,
  cursor: DeliveryCursor | null,
): Promise<DeliveryPageOutcome> {
  const now = new Date();
  const settledBefore = summary.delivered + summary.terminal + summary.suppressed + summary.unparseable;
  const pending = await env.TELEMETRY_DB.prepare(
    `SELECT e.event_id, e.envelope_json, e.analytics_subject_id, e.workspace_analytics_id,
            e.normalized_timestamp, e.attempt_count, e.delete_at, e.subject_user_id, e.accepted_at
     FROM telemetry_accepted_events e
     WHERE e.delivery_state IN ('pending', 'retrying')
       AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)
       AND e.delete_at > ?
       AND (e.accepted_at > ? OR (e.accepted_at = ? AND e.event_id > ?))
     ORDER BY e.accepted_at, e.event_id
     LIMIT ?`,
  ).bind(
    now.toISOString(),
    now.toISOString(),
    cursor?.acceptedAt ?? "",
    cursor?.acceptedAt ?? "",
    cursor?.eventId ?? "",
    context.pageSize,
  ).all<DeliveryDatabaseRow>();
  const last = pending.results.at(-1);
  const outcome = (rpcCalls: number, held: number): DeliveryPageOutcome => {
    const settled = summary.delivered + summary.terminal + summary.suppressed + summary.unparseable - settledBefore;
    return {
      continues: pending.results.length === context.pageSize && settled + held === pending.results.length,
      rpcCalls,
      cursor: last ? { acceptedAt: last.accepted_at, eventId: last.event_id } : cursor,
    };
  };

  // Read transition fences after selecting events, for only this page of subjects.
  const subjects = await env.DB.prepare(
    `SELECT u.id, u.product_analytics_enabled, EXISTS (
       SELECT 1 FROM telemetry_profile_jobs transition
       WHERE transition.subject_user_id = u.id AND transition.job_kind = 'epoch_transition'
         AND transition.state IN ('pending', 'delivering')
     ) AS transition_pending
     FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify([...new Set(pending.results.map((row) => row.subject_user_id).filter(Boolean))]))
    .all<{ id: string; product_analytics_enabled: number; transition_pending: number }>();
  const preferences = new Map(subjects.results.map((row) => [row.id, row]));
  const eligible: ParsedDeliveryRow[] = [];
  let held = 0;
  for (const row of pending.results) {
    const subject = row.subject_user_id === null ? undefined : preferences.get(row.subject_user_id);
    if (subject?.transition_pending === 1) {
      held += 1;
      continue;
    }
    row.product_analytics_enabled = subject?.product_analytics_enabled ?? null;
    const stored = parseStoredEnvelope(row);
    if ("code" in stored) {
      await parkUnparseableRow(env, row, stored.code, now);
      summary.unparseable += 1;
      continue;
    }
    const parsed = stored.envelope;
    const attributableNonessential = row.subject_user_id !== null && parsed.category !== "essential";
    if (isRetiredMeetingTelemetry(parsed) || (attributableNonessential && row.product_analytics_enabled !== 1)) {
      await env.TELEMETRY_DB.prepare(
        "DELETE FROM telemetry_accepted_events WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')",
      ).bind(row.event_id).run();
      summary.suppressed += 1;
    } else {
      eligible.push({ row, envelope: parsed });
    }
  }
  const exceptionCandidates = eligible.filter(({ envelope }) => envelope.name === "javascript_exception");
  const ordinaryCandidates = eligible.filter((row) => !exceptionCandidates.includes(row));
  const ordinary = context.captureAllowed ? ordinaryCandidates : [];
  const exceptions = context.exceptionAllowed ? exceptionCandidates : [];
  summary.selected += ordinary.length + exceptions.length;
  if (ordinary.length + exceptions.length === 0) return outcome(0, held);
  const { telemetryDelivery, postHogHost, postHogProjectToken } = context;
  const exceptionDeliveries = await Promise.all(
    exceptions.map((row) => javascriptDeliveryRow(env, row)),
  );
  for (const [rows, result, destination] of await Promise.all([
    ordinary.length > 0
      ? telemetryDeliveryRpcCall(() => telemetryDelivery.deliverTelemetryBatch({
        host: postHogHost,
        projectToken: postHogProjectToken,
        webBaseUrl: env.PUBLIC_WEB_BASE_URL,
        rows: ordinary.map(deliveryRow),
      })).then(({ postHog }) => [ordinary, postHog, "posthog_capture"] as const)
      : Promise.resolve([ordinary, null, "posthog_capture"] as const),
    exceptions.length > 0
      ? telemetryDeliveryRpcCall(() => telemetryDelivery.deliverJavascriptExceptionBatch({
        host: postHogHost,
        projectToken: postHogProjectToken,
        rows: exceptionDeliveries,
      })).then(({ postHog }) => [exceptions, postHog, "posthog_javascript_exception"] as const)
      : Promise.resolve([exceptions, null, "posthog_javascript_exception"] as const),
  ])) {
    if (result) {
      await applyDestinationResult(env, rows.map(({ row }) => row), result, now, summary);
      await recordDestinationOutcome(
        env,
        destination,
        result.result === "retry" ? "retryable" : "healthy",
        now,
      ).catch(() => undefined);
    }
  }
  return outcome((ordinary.length > 0 ? 1 : 0) + (exceptions.length > 0 ? 1 : 0), held);
}

async function applyDestinationResult(
  env: Env,
  rows: DeliveryDatabaseRow[],
  result: TelemetryDestinationResult,
  now: Date,
  summary: TelemetryDeliverySummary,
): Promise<void> {
  if (result.result === "delivered") {
    await env.TELEMETRY_DB.batch(rows.map((row) => env.TELEMETRY_DB.prepare(
      `UPDATE telemetry_accepted_events
       SET delivery_state = 'delivered', delivered_at = ?, attempt_count = attempt_count + 1,
           next_attempt_at = NULL, terminal_code = NULL
       WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
    ).bind(now.toISOString(), row.event_id)));
    summary.delivered += rows.length;
    return;
  }
  if (result.result === "terminal") {
    await env.TELEMETRY_DB.batch(rows.map((row) => env.TELEMETRY_DB.prepare(
      `UPDATE telemetry_accepted_events
       SET delivery_state = 'terminal', attempt_count = attempt_count + 1,
           next_attempt_at = NULL, terminal_code = 'destination_rejected'
       WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
    ).bind(row.event_id)));
    summary.terminal += rows.length;
    return;
  }

  await env.TELEMETRY_DB.batch(rows.map((row) => env.TELEMETRY_DB.prepare(
    `UPDATE telemetry_accepted_events
     SET delivery_state = 'retrying', attempt_count = attempt_count + 1,
         next_attempt_at = ?, terminal_code = NULL
     WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
  ).bind(nextAttemptAt(row, now, result.retryAfterMs), row.event_id)));
  summary.retried += rows.length;
}
