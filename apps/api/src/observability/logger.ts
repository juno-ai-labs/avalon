import { platformErrorCode } from "@rally/contracts/platform-diagnostics";
import { codeShaped, describeZodIssues, isDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { Context } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import type { Env } from "../env";
import { asApiError } from "../lib/api-error";
import { ObjectPortError } from "../runtime/object-port-error";

const REDACTED = "[REDACTED]";
const sensitiveKey = /token|secret|authorization|cookie|credential|code_verifier|prompt|email_?body|connector_?content|file_?content|model_?context/i;

function isFullyMaskedShape(value: unknown): boolean {
  if (value === "***" || value === -1) return true;
  if (Array.isArray(value)) return value.every(isFullyMaskedShape);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isFullyMaskedShape);
  }
  return false;
}

export function redact(value: unknown, depth = 0): unknown {
  // Request validation records a parsed body's complete shape after replacing
  // every leaf with one of these two sentinels. It is already content-free, so
  // preserve it verbatim: applying the generic sensitive-key and depth rules a
  // second time would turn fields such as `token` into a different marker or
  // erase the very nesting this diagnostic exists to expose.
  if (isFullyMaskedShape(value)) return value;
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

/** A developer-authored constant: the one shape a thrown message was always trusted in. */
const STABLE_CODE = /^[a-z][a-z0-9_]{0,119}$/u;

/**
 * A reason reduced to what `diagnosticErrorCode` passes through unchanged, for
 * an error thrown so that its message becomes the log's code. Narrower than
 * `codeShaped` from `@rally/contracts`, whose class keeps `:` `.` and `-`,
 * which this logger would read as not a code and replace with the fallback.
 */
export function stableCode(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 120);
}

/**
 * Extract a stable error code without copying an arbitrary provider/runtime
 * message into an indexed log field.
 *
 * Two errors carry structure that is safe to keep. A `ZodError` raised on this
 * side of any RPC hop still has its issues, and their paths and codes are
 * schema shape rather than content, so they ride behind the caller's own code
 * instead of being replaced by it: `external_event_delivery_failed` becomes
 * `external_event_delivery_failed:event.eventSequence:invalid_type`. And a
 * message `parseRpcInput` composed — a label, `_invalid`, the issues — is how a
 * Durable Object's rejection arrives across the hop, so `isDiagnosticCode`
 * admits that family beside the bare constant this always admitted.
 *
 * An `ObjectPortError` carries the conversation object's own refusal code
 * beside a sentence written for members. The code is the reason, so it is
 * kept when it has that same bare constant shape; read as a message, every
 * refusal reduced to the caller's fallback.
 *
 * Nothing wider. A message is not trusted because it is code-shaped: the
 * tree throws `memory_table_value_type:${column.name}:string`, an R2 key
 * after a colon, a target id, and `${component}_schema_hash_mismatch:${version}`,
 * and each of those in an indexed field or the OTel `error.type` is either a
 * member's value or one distinct grouping key per object. Those still reduce
 * to the caller's fallback, as they always did.
 */
export function diagnosticErrorCode(error: unknown, fallback: string): string {
  // Also an object's ApiError, which arrives as a plain Error after its RPC hop.
  const api = asApiError(error);
  if (api) return api.diagnosticCode ?? api.code;
  if (error instanceof ObjectPortError && STABLE_CODE.test(error.code)) return error.code;
  if (error instanceof z.ZodError) return codeShaped(`${fallback}:${describeZodIssues(error)}`);
  if (!(error instanceof Error)) return fallback;
  const direct = error.message.trim();
  if (STABLE_CODE.test(direct) || isDiagnosticCode(direct)) return direct;
  const tagged = /\(([a-z][a-z0-9._]{0,119})\)/u.exec(direct)?.[1];
  if (tagged) return tagged.replaceAll(".", "_");
  const platform = platformErrorCode(error);
  return platform ? `${fallback}:${platform}` : fallback;
}

export function logEvent(
  c: Context<HonoAppEnv>,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  // The request context is authoritative for correlation: a caller must not be
  // able to relabel which request an entry belongs to, or which workspace it
  // authenticated as. Both are absent on an unauthenticated route — a connector
  // OAuth callback carries no session, and an error thrown before
  // `requestContext` has no request id — so they are spread only when present,
  // leaving a caller that knows the workspace able to fill the gap rather than
  // having its value overwritten with `undefined`.
  const requestId = c.get("requestId");
  const workspaceId = c.get("auth")?.workspaceId;
  logRequestEvent(c.env, {
    ...(requestId == null ? {} : { requestId }),
    ...(workspaceId == null ? {} : { workspaceId }),
  }, level, event, fields);
}

export function logRequestEvent(
  env: LogEnv,
  correlation: { requestId?: string; workspaceId?: string },
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  logStructuredEvent(env, level, event, {
    ...fields,
    ...(correlation.requestId === undefined ? {} : { request_id: correlation.requestId }),
    ...(correlation.workspaceId === undefined ? {} : { workspace_id: correlation.workspaceId }),
  });
}

// Fields that read like a log line when a diagnostic carries them, in the order
// a reader expects them. Everything else stays a field only: the summary exists
// to identify the row, not to reproduce it. Adding a name here is safe whatever
// it is, because the summary is derived from the redacted fields rather than
// the caller's — a name that starts matching `sensitiveKey` reads `[REDACTED]`
// in the summary too, instead of printing the plaintext beside the hidden
// field.
const SUMMARY_FIELDS = ["method", "path", "status", "code", "error_code", "flow", "phase", "component"] as const;

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
  const redacted = redact(rest) as Record<string, unknown>;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message: typeof provided === "string" && provided.length > 0
      ? redact(provided) as string
      : summarizeEvent(event, redacted),
    region: env.AVALON_REGION,
    app_version: env.APP_VERSION ?? "unknown",
    build_sha: env.BUILD_SHA ?? null,
    ...redacted,
  };
  // Workers Logs indexes the properties of a logged object as structured
  // fields, and treats `message` as the row's summary. Serializing the entry
  // first would collapse every diagnostic into that one string, making the
  // release dashboards unable to filter on fields such as `event` or `code`;
  // omitting `message` keeps the fields but empties the log list. These are the
  // only `console` calls in this Worker, which `no-console` enforces everywhere
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
