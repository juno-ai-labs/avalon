import type { Context } from "hono";
import type { HonoAppEnv } from "../env";

const REDACTED = "[REDACTED]";
const sensitiveKey = /token|secret|authorization|cookie|credential|code_verifier|email_body|file_content|model_context/i;

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

export function logEvent(
  c: Context<HonoAppEnv>,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const configured = c.env.LOG_LEVEL ?? "info";
  const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  if (rank[level] < rank[configured]) return;
  const auth = c.get("auth");
  const entry = redact({
    timestamp: new Date().toISOString(),
    level,
    event,
    request_id: c.get("requestId"),
    workspace_id: auth?.workspaceId,
    region: c.env.AVALON_REGION,
    ...fields,
  });
  const serialized = JSON.stringify(entry);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else if (level === "debug") console.debug(serialized);
  else console.info(serialized);
}
