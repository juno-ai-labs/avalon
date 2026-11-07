import type { EngineeringOperator } from "@rally/contracts/engineering-inspection";
import type { Env } from "../env";
import { diagnosticErrorCode } from "../observability/logger";

/** Same independent audit authority as impersonation: an attempt precedes effects. */
export async function auditedEngineeringWrite<T>(env: Env, operator: EngineeringOperator, entry: {
  action: "create_org" | "create_channel" | "create_thread" | "send_message" | "pause_sidekick" | "resume_sidekick"
    | "dump_thread_transcripts" | "retire_threads" | "retire_org";
  orgId: string;
  /** The user an action is taken as; an Organization-wide operator operation has none and targets the Organization. */
  representedUserId?: string;
  operationId: string;
  threadId?: string;
  breakoutId?: string;
  sidekickId?: string;
}, run: () => Promise<T>, receipt: (result: T) => Record<string, unknown>): Promise<T> {
  const attemptId = crypto.randomUUID();
  const record = async (phase: "attempt" | "result", outcome: string, result: Record<string, unknown> = {}) => {
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
          target_type, target_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'system', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`engineering:${attemptId}:${phase}`, entry.orgId, entry.threadId ?? null,
      `engineering.${entry.action}.${phase}`,
      entry.representedUserId === undefined ? "workspace" : "represented_user",
      entry.representedUserId ?? entry.orgId,
      JSON.stringify({ operator, ...entry, outcome, ...result }), entry.operationId, new Date().toISOString()).run();
  };
  await record("attempt", "attempted");
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // A cross-authority failure can follow a commit; the original operation ID
    // remains the recovery key, rather than claiming the write never happened.
    await record("result", "failed_or_uncertain", { errorCode: diagnosticErrorCode(error, "engineering_write_failed") });
    throw error;
  }
  await record("result", "admitted", receipt(result));
  return result;
}
