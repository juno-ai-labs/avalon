import { ToolExecutionAccountSchema, ToolExecutionAccountRecordSchema, type ToolExecutionAccountRecord, type ToolAccountAttribution } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

/** Account choices live in the existing append-only receipt checkpoints. */
export const TOOL_ACCOUNT_CHECKPOINT = "execution_account";

export function toolAccountAttribution(record: ToolExecutionAccountRecord, names?: { connectionName?: string | null; userName?: string | null }): ToolAccountAttribution {
  const personal = record.account.principal.type === "user";
  return {
    connectionId: record.account.connectionId,
    connectionName: names?.connectionName ?? null,
    userId: personal ? record.account.delegatedUserId : null,
    userName: personal ? names?.userName ?? null : null,
    scope: personal ? "personal" : "workspace",
    phase: record.phase,
    fallbackFromConnectionId: record.originalAccount.connectionId === record.account.connectionId ? null : record.originalAccount.connectionId,
  };
}
export const ExecutionAccountReadSchema = z.strictObject({ runId: z.string().min(1), effectIntentId: z.string().min(1) });
export const ResourceExecutionAccountsSchema = z.strictObject({ runId: z.string().min(1), resourceKeys: z.array(z.string().min(1)) });
export const RecordExecutionAccountSchema = z.strictObject({
  effectIntentId: z.string().min(1), fence: z.strictObject({ runId: z.string().min(1), attemptId: z.string().min(1), owner: z.string().min(1) }),
  now: z.number().int().nonnegative(), phase: z.enum(["selected", "refused", "served"]),
  account: ToolExecutionAccountSchema, resourceKeys: z.array(z.string().min(1)),
});

export function parseExecutionAccountRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(zodDiagnosticCode(parsed.error, "tool_execution_account")!);
  return parsed.data;
}

export function parseToolExecutionAccountRecord(value: unknown): ToolExecutionAccountRecord {
  return parseExecutionAccountRequest(ToolExecutionAccountRecordSchema, value);
}

function recordJson(text: string): ToolExecutionAccountRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("tool_execution_account_payload_invalid"); }
  return parseToolExecutionAccountRecord(value);
}

export function readToolExecutionAccount(sql: SqlStorage, runId: string, effectIntentId: string): ToolExecutionAccountRecord | null {
  const row = sql.exec<{ member_safe_payload_json: string }>(
    `SELECT member_safe_payload_json FROM tool_effect_checkpoints
      WHERE run_id=? AND effect_intent_id=? AND phase=? ORDER BY checkpoint_index DESC LIMIT 1`,
    runId, effectIntentId, TOOL_ACCOUNT_CHECKPOINT,
  ).toArray()[0];
  return row ? recordJson(row.member_safe_payload_json) : null;
}

/** Only a completed effect establishes an account for dependent work. */
export function completedToolResourceAccounts(sql: SqlStorage, runId: string, resourceKeys: readonly string[]): ToolExecutionAccountRecord[] {
  if (resourceKeys.length === 0) return [];
  return sql.exec<{ member_safe_payload_json: string }>(
    `SELECT checkpoint.member_safe_payload_json FROM tool_effect_checkpoints checkpoint
      JOIN tool_effects effect ON effect.effect_intent_id=checkpoint.effect_intent_id
      WHERE checkpoint.run_id=? AND effect.run_id=? AND effect.status='completed' AND checkpoint.phase=?
        AND json_extract(checkpoint.member_safe_payload_json,'$.phase')='served'
        AND EXISTS (SELECT 1 FROM json_each(checkpoint.member_safe_payload_json,'$.resourceKeys') resource
          WHERE resource.value IN (SELECT value FROM json_each(?)))
      ORDER BY effect.tool_position DESC,checkpoint.checkpoint_index DESC`,
    runId, runId, TOOL_ACCOUNT_CHECKPOINT, JSON.stringify(resourceKeys),
  ).toArray().map((row) => recordJson(row.member_safe_payload_json));
}
