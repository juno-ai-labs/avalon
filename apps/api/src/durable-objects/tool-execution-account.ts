import { ToolExecutionAccountSchema, ToolExecutionAccountRecordSchema, type ToolExecutionAccountRecord } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

/** Account choices live in the existing append-only receipt checkpoints. */
export const TOOL_ACCOUNT_CHECKPOINT = "execution_account";

export const ExecutionAccountReadSchema = z.strictObject({ runId: z.string().min(1), effectIntentId: z.string().min(1) });
export const RecordExecutionAccountSchema = z.strictObject({
  effectIntentId: z.string().min(1), fence: z.strictObject({ runId: z.string().min(1), attemptId: z.string().min(1), owner: z.string().min(1) }),
  now: z.number().int().nonnegative(), phase: z.enum(["selected", "refused", "served"]),
  account: ToolExecutionAccountSchema,
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
