/**
 * The engineering MCP's tool-call audit log: one row per event, sent through
 * the `ENGINEERING_AUDIT_LAKEHOUSE` Pipeline into the
 * `avalon.engineering_mcp_audit` Iceberg table, which `query_data_lake` reads.
 * `docs/engineering-mcp.md#tool-call-audit-log` owns the row shape and the
 * fail-closed rule; `config/engineering-mcp-audit-lakehouse-stream-schema.json`
 * is the column contract the stream enforces.
 */
import type { Pipeline } from "cloudflare:pipelines";
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";

import type { AccessPrincipal } from "./access";

/** Bump with the stream schema; a reader filters on it. */
export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditLogEnvironment {
  /** Absent until the stream is provisioned and pinned; every tool call then refuses. */
  ENGINEERING_AUDIT_LAKEHOUSE?: Pipeline;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AuditOutcome = "succeeded" | "failed" | "task_created" | "cancelled";

/** What happened. The actor, time and Worker version are added on send. */
export type AuditEvent =
  | { event: "tool_call_started"; tool: string; callId: string; arguments: unknown }
  | {
    event: "tool_call_finished"; tool: string; callId: string; outcome: AuditOutcome;
    durationMs: number; errorCode?: string; taskId?: string;
  }
  | { event: "task_finished"; tool: string; taskId: string; outcome: AuditOutcome; errorCode?: string };

/** The binding is missing, so nothing can be recorded. */
export class AuditUnconfiguredError extends Error {
  constructor() {
    super("engineering_audit_unconfigured");
    this.name = "AuditUnconfiguredError";
  }
}

export function auditRow(env: AuditLogEnvironment, principal: AccessPrincipal, event: AuditEvent): Record<string, unknown> {
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    // Pipeline delivery to the table is exactly-once, but a retried send is a
    // second row; readers deduplicate on this.
    event_id: crypto.randomUUID(),
    event: event.event,
    occurred_at: new Date().toISOString(),
    tool: event.tool,
    actor_subject: principal.subject,
    actor_email: principal.email,
    actor_audience: principal.audience,
    worker_version: env.CF_VERSION_METADATA?.id ?? null,
    call_id: "callId" in event ? event.callId : null,
    task_id: "taskId" in event ? event.taskId ?? null : null,
    arguments: "arguments" in event ? event.arguments : null,
    outcome: "outcome" in event ? event.outcome : null,
    error_code: "errorCode" in event ? event.errorCode ?? null : null,
    duration_ms: "durationMs" in event ? event.durationMs : null,
  };
}

/**
 * Sends an event and resolves once the stream confirms ingestion; throws when
 * it does not, so the caller decides the policy.
 */
export async function writeAuditEvent(
  env: AuditLogEnvironment,
  principal: AccessPrincipal,
  event: AuditEvent,
): Promise<void> {
  if (!env.ENGINEERING_AUDIT_LAKEHOUSE) throw new AuditUnconfiguredError();
  await env.ENGINEERING_AUDIT_LAKEHOUSE.send([auditRow(env, principal, event)]);
}

/** For events after the effect: a failed send is logged, never surfaced. */
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

export function auditFailureCode(error: unknown): string {
  if (error instanceof AuditUnconfiguredError) return error.message;
  const platform = platformErrorCode(error);
  return platform ? `engineering_audit_unavailable:${platform}` : "engineering_audit_unavailable";
}

export function logAuditWriteFailure(principal: AccessPrincipal, event: AuditEvent, error: unknown) {
  console.error(JSON.stringify({
    event: "engineering_mcp_audit_write_failed",
    audit_event: event.event,
    tool: event.tool,
    actor_subject: principal.subject,
    ...("callId" in event ? { call_id: event.callId } : {}),
    ...("taskId" in event && event.taskId ? { task_id: event.taskId } : {}),
    error_code: auditFailureCode(error),
  }));
}
