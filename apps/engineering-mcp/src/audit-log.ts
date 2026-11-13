/**
 * The engineering MCP's tool-call audit log: one immutable JSON object per
 * event in the `ENGINEERING_AUDIT_LOG` R2 bucket, never overwritten or read
 * back by this Worker. `docs/engineering-mcp.md#tool-call-audit-log` owns the
 * record shape, the key layout and the fail-closed rule.
 */
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";

import type { AccessPrincipal } from "./access";

export const AUDIT_RECORD_SCHEMA = "rally.engineering-mcp.audit/v1";

export interface AuditLogEnvironment {
  ENGINEERING_AUDIT_LOG: R2Bucket;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AuditOutcome = "succeeded" | "failed" | "task_created" | "cancelled";

/** What happened. The actor, time and Worker version are added on write. */
export type AuditEvent =
  | { event: "tool_call_started"; tool: string; callId: string; arguments: unknown }
  | {
    event: "tool_call_finished"; tool: string; callId: string; outcome: AuditOutcome;
    durationMs: number; errorCode?: string; taskId?: string;
  }
  | { event: "task_finished"; tool: string; taskId: string; outcome: AuditOutcome; errorCode?: string };

/**
 * One object per event, under the UTC day it happened, named so a prefix
 * listing returns a day in time order. The random suffix keeps two events in
 * the same millisecond from sharing a key.
 */
export function auditObjectKey(at: Date): string {
  const iso = at.toISOString();
  return `tool-calls/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso}_${crypto.randomUUID()}.json`;
}

/** Writes an event; throws when R2 refuses, so the caller decides the policy. */
export async function writeAuditEvent(
  env: AuditLogEnvironment,
  principal: AccessPrincipal,
  event: AuditEvent,
): Promise<void> {
  const at = new Date();
  const record = {
    schema: AUDIT_RECORD_SCHEMA,
    at: at.toISOString(),
    actor: { subject: principal.subject, email: principal.email, audience: principal.audience },
    workerVersion: env.CF_VERSION_METADATA?.id ?? null,
    ...event,
  };
  await env.ENGINEERING_AUDIT_LOG.put(auditObjectKey(at), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** For events after the effect: a failed write is logged, never surfaced. */
export async function writeAuditEventOrLog(
  env: AuditLogEnvironment,
  principal: AccessPrincipal,
  event: AuditEvent,
): Promise<void> {
  try {
    await writeAuditEvent(env, principal, event);
  } catch (error) {
    logAuditWriteFailure(principal, event, error);
  }
}

export function logAuditWriteFailure(principal: AccessPrincipal, event: AuditEvent, error: unknown) {
  console.error(JSON.stringify({
    event: "engineering_mcp_audit_write_failed",
    audit_event: event.event,
    tool: event.tool,
    actor_subject: principal.subject,
    ...("callId" in event ? { call_id: event.callId } : {}),
    ...("taskId" in event && event.taskId ? { task_id: event.taskId } : {}),
    error_code: platformErrorCode(error) ?? (error instanceof Error ? error.name : "audit_write_failed"),
  }));
}
