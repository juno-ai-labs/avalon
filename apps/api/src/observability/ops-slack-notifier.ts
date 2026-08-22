/**
 * Operator notifications, posted to a Slack channel by a small internal app.
 *
 * Every diagnostic in this Worker is a structured log row, and the saved
 * Workers Logs views are where an operator is expected to look. Nothing in
 * that arrangement reaches out: a workspace alarm hot-looped for hours on
 * 2026-08-22 writing an error row a second, and the first person to read one
 * was chasing a different bug. This is the reach-out — one bounded
 * `chat.postMessage` per notice, beside the log row and never instead of it —
 * for the handful of events that mean a thing has stopped working rather than
 * hiccuped.
 *
 * Deliberately not the Avalon Slack app: that app is a product surface with a
 * connection lifecycle of its own, and an operator channel must not depend on
 * the connector it may be reporting on. Deliberately not an incoming webhook
 * either: a webhook's credential is its URL path, and the platform's automatic
 * tracing records every outbound fetch as `url.full` — which Global exports —
 * whereas a bot token travels in a header, which no span captures. That is
 * the shape every other provider secret here has. `docs/ops-alerting.md` is
 * the module document.
 */
import type { Env } from "../env";
import { withDeadline } from "../lib/deadline";
import { logInfo, logWarn, type LogEnv } from "./logger";

export type OpsNotificationDelivery = "sent" | "skipped" | "failed";

export interface OpsNotification {
  /** Stable snake_case identity, the same `event` the log row beside it carries. */
  event: string;
  /** One plain sentence saying what happened and what, if anything, is owed. */
  summary: string;
  /** Codes, counts, and opaque ids only — this text leaves Avalon. */
  fields?: Record<string, string | number | boolean | null>;
}

export type OpsNotifierEnv = LogEnv & Pick<Env, "APP_ENV" | "OPS_SLACK_BOT_TOKEN" | "OPS_SLACK_CHANNEL_ID">;

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
/** One POST, bounded: a notification must never hold the caller's invocation open. */
const OPS_NOTIFICATION_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARS = 32_000;
const MAX_FIELD_CHARS = 200;

/** Both halves of the destination, or nothing: a token with no channel has nowhere to post. */
export function opsNotificationsConfigured(env: Pick<Env, "OPS_SLACK_BOT_TOKEN" | "OPS_SLACK_CHANNEL_ID">): boolean {
  return Boolean(env.OPS_SLACK_BOT_TOKEN?.trim()) && Boolean(env.OPS_SLACK_CHANNEL_ID?.trim());
}

/**
 * Post one notice, or say why not. Never throws: the caller has already
 * recorded the event in the log, and a notification that could take down the
 * path it describes would be a second incident.
 *
 * `"skipped"` is the ordinary answer everywhere outside a deployed region and
 * everywhere the secrets are absent — every local and test environment, and a
 * region whose operator has not set it up.
 */
export async function notifyOps(
  env: OpsNotifierEnv,
  notice: OpsNotification,
  request: typeof fetch = fetch,
): Promise<OpsNotificationDelivery> {
  // Local and test traffic never reaches the operator channel: the sandbox has
  // full network access, and a developer's `.dev.vars` carrying the secrets
  // would page the channel from a laptop. The same guard Resend has.
  if (env.APP_ENV !== "production" && env.APP_ENV !== "staging") return "skipped";
  if (!opsNotificationsConfigured(env)) return "skipped";
  const token = env.OPS_SLACK_BOT_TOKEN!.trim();
  const channel = env.OPS_SLACK_CHANNEL_ID!.trim();
  const failed = (fields: Record<string, unknown>): "failed" => {
    logWarn(env, "ops_notification_failed", { notice_event: notice.event, ...fields });
    return "failed";
  };
  let response: Response;
  try {
    response = await withDeadline(OPS_NOTIFICATION_TIMEOUT_MS, (signal) => request(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text: renderOpsNotification(env.AVALON_REGION, notice) }),
      signal,
    }));
  } catch (error) {
    return failed({ code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed" });
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return failed({ code: "response_unreadable", status: response.status });
  }
  if (!response.ok) return failed({ code: "http_error", status: response.status });
  if (body.length > MAX_RESPONSE_CHARS) return failed({ code: "response_too_large", status: response.status });
  // Slack answers 200 with `ok: false` and a code such as `channel_not_found`
  // or `invalid_auth` — a code, so it may be logged.
  let parsed: { ok?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(body) as { ok?: unknown; error?: unknown };
  } catch {
    return failed({ code: "response_malformed", status: response.status });
  }
  if (parsed.ok !== true) {
    const code = typeof parsed.error === "string" && /^[a-z0-9_]{1,80}$/u.test(parsed.error) ? parsed.error : "slack_error";
    return failed({ code, status: response.status });
  }
  logInfo(env, "ops_notification_sent", { notice_event: notice.event });
  return "sent";
}

/**
 * The message as Slack renders it: region and event first, so a channel
 * shared by both regions reads at a glance. Every value is escaped for
 * `mrkdwn`, so no field can form a mention, a link, or a channel-wide ping.
 */
export function renderOpsNotification(region: string, notice: OpsNotification): string {
  const lines = [
    `:rotating_light: *[${escapeMrkdwn(region)}]* \`${escapeMrkdwn(notice.event)}\``,
    escapeMrkdwn(notice.summary),
  ];
  for (const [key, value] of Object.entries(notice.fields ?? {})) {
    lines.push(`• ${escapeMrkdwn(oneLine(key))}: ${escapeMrkdwn(bounded(oneLine(String(value))))}`);
  }
  return lines.join("\n");
}

/** A value stays on its own line: a newline inside one would start a line the reader takes for a field. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Cut at the cap with a visible mark, so a reader knows there was more. */
function bounded(value: string): string {
  return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
}

/** The three characters Slack's `mrkdwn` reads as markup, per its formatting reference. */
function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
