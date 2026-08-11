import type { Context } from "hono";
import type { HonoAppEnv } from "../env";
import type { Env } from "../env";

const REDACTED = "[REDACTED]";
const sensitiveKey = /token|secret|authorization|cookie|credential|code_verifier|prompt|email_?body|connector_?content|file_?content|model_?context/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redact(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// Everything the logger reads off the environment. Callers that hold a full
// `Env` satisfy it; the narrow shape keeps helpers callable from code that only
// receives the observability bindings.
export type LogEnv = Pick<Env, "LOG_LEVEL" | "AVALON_REGION" | "APP_VERSION" | "BUILD_SHA">;

// `message` is the one reserved key: it becomes the row summary rather than an
// ordinary field, so it has to be a string. Typing it that way is what keeps a
// caller from putting a structured value in the slot and losing it — the
// runtime falls back to the derived summary, which cannot carry it.
export type LogFields = Record<string, unknown> & { message?: string };

export function logEvent(
  c: Context<HonoAppEnv>,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const auth = c.get("auth");
  logStructuredEvent(c.env, level, event, {
    request_id: c.get("requestId"),
    workspace_id: auth?.workspaceId,
    ...fields,
  });
}

// Fields that read like a log line when a diagnostic carries them, in the order
// a reader expects them. Everything else stays a field only: the summary exists
// to identify the row, not to reproduce it.
const SUMMARY_FIELDS = ["method", "path", "status", "code"] as const;

// Workers Logs renders the log list's message column from the entry's `message`
// field. An entry that omits one lists as a blank row that has to be expanded
// before it says anything, so give every diagnostic a one-line summary of the
// fields it already carries.
export function summarizeEvent(event: string, fields: LogFields = {}): string {
  const parts: string[] = [event];
  for (const key of SUMMARY_FIELDS) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") parts.push(String(value));
  }
  if (typeof fields.duration_ms === "number") parts.push(`${fields.duration_ms}ms`);
  return parts.join(" ");
}

export function logStructuredEvent(
  env: LogEnv,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const configured = env.LOG_LEVEL ?? "info";
  const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  if (rank[level] < rank[configured]) return;
  // `message` is typed as a string, so the only value the fallback can discard
  // is one an untyped caller forced into the slot; an empty string still falls
  // back rather than listing the row blank.
  const { message: provided, ...rest } = fields;
  const entry = redact({
    timestamp: new Date().toISOString(),
    level,
    event,
    message: typeof provided === "string" && provided.length > 0 ? provided : summarizeEvent(event, fields),
    region: env.AVALON_REGION,
    app_version: env.APP_VERSION ?? "unknown",
    build_sha: env.BUILD_SHA ?? null,
    ...rest,
  });
  // Workers Logs indexes the properties of a logged object as structured
  // fields, and treats `message` as the row's summary. Serializing the entry
  // first would collapse every diagnostic into that one string, making the
  // release dashboards unable to filter on fields such as `event` or `code`;
  // omitting `message` keeps the fields but empties the log list. These are the
  // only `console` calls in the Worker, which `no-console` enforces everywhere
  // else so no diagnostic can reach Workers Logs unindexed or unsummarized.
  /* eslint-disable no-console */
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else if (level === "debug") console.debug(entry);
  else console.info(entry);
  /* eslint-enable no-console */
}

export function logDebug(env: LogEnv, event: string, fields: LogFields = {}): void {
  logStructuredEvent(env, "debug", event, fields);
}

export function logInfo(env: LogEnv, event: string, fields: LogFields = {}): void {
  logStructuredEvent(env, "info", event, fields);
}

export function logWarn(env: LogEnv, event: string, fields: LogFields = {}): void {
  logStructuredEvent(env, "warn", event, fields);
}

export function logError(env: LogEnv, event: string, fields: LogFields = {}): void {
  logStructuredEvent(env, "error", event, fields);
}
