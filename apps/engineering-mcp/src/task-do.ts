import { DurableObject } from "cloudflare:workers";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

import type { AccessPrincipal } from "./access";
import type { Env } from "./env";
import { writeAuditEventOrLog } from "./audit-log";
import { executeEngineeringTask, toolErrorCode, toolResultFailureCode } from "./server";
import { initializeTaskSchema } from "./task-schema";
import { EngineeringTaskInputSchema, TaskResultSchema, TASK_RETENTION_MS, type EngineeringTaskInput, type TaskResult, type TaskSnapshot } from "./tasks";

type StoredTask = {
  principal: AccessPrincipal;
  snapshot: TaskSnapshot;
  name: EngineeringTaskInput["name"];
  expiresAt?: number;
};

// Storage segmentation, not a result-size cap: every chunk is retained.
const CHUNK_CHARACTERS = 32 * 1_024;
// Cloudflare's native alarm retry budget, not an application retry policy.
// https://developers.cloudflare.com/durable-objects/api/alarms/ (2026-11-10)
const ALARM_RETRIES = 6;

class TaskDataError extends Error {}

function writeJson(sql: SqlStorage, kind: "input" | "result", value: unknown) {
  const json = JSON.stringify(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + CHUNK_CHARACTERS, json.length);
    // SQLite text is UTF-8: never split a surrogate pair across text rows.
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(json.slice(offset, end));
    offset = end;
  }
  sql.exec("INSERT INTO engineering_task_payloads (kind, chunk_count) VALUES (?, ?)", kind, chunks.length);
  for (const [index, chunk] of chunks.entries()) {
    sql.exec("INSERT INTO engineering_task_chunks (kind, position, content) VALUES (?, ?, ?)",
      kind, index, chunk);
  }
}

function readJson(sql: SqlStorage, kind: "input" | "result"): unknown {
  const payload = sql.exec<{ chunk_count: number }>("SELECT chunk_count FROM engineering_task_payloads WHERE kind = ?", kind).toArray()[0];
  if (!payload) throw new TaskDataError(`engineering_task_missing_${kind}`);
  const chunks: string[] = [];
  // One ordered cursor, consumed synchronously; no per-chunk storage awaits.
  for (const row of sql.exec<{ position: number; content: string }>(
    "SELECT position, content FROM engineering_task_chunks WHERE kind = ? ORDER BY position", kind,
  )) {
    if (row.position !== chunks.length) throw new TaskDataError(`engineering_task_missing_${kind}_chunk`);
    chunks.push(row.content);
  }
  if (chunks.length !== payload.chunk_count) throw new TaskDataError(`engineering_task_missing_${kind}_chunk`);
  return JSON.parse(chunks.join(""));
}

type TaskRow = {
  task_id: string; subject: string; audience: string; email: string | null;
  name: EngineeringTaskInput["name"]; status: TaskSnapshot["status"]; status_message: string;
  created_at: number; updated_at: number; expires_at: number | null;
};

/** One execution and its result per object. Its sole alarm executes or expires
 * that task; this is separate from the regional product alarm coordinator. */
export class EngineeringTaskDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { initializeTaskSchema(ctx.storage, env.CF_VERSION_METADATA?.id ?? "unknown"); });
  }

  private loadTask(): StoredTask | undefined {
    const row = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM engineering_task WHERE singleton = 1").toArray()[0];
    if (!row) return undefined;
    return {
      principal: { subject: row.subject, audience: row.audience, email: row.email },
      name: row.name,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      snapshot: {
        taskId: row.task_id, status: row.status, statusMessage: row.status_message,
        createdAt: new Date(row.created_at).toISOString(), lastUpdatedAt: new Date(row.updated_at).toISOString(),
        ttlMs: row.expires_at === null ? null : row.expires_at - row.created_at,
      },
    };
  }

  private saveTask(task: StoredTask) {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO engineering_task
      (singleton, task_id, subject, audience, email, name, status, status_message, created_at, updated_at, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.snapshot.taskId, task.principal.subject, task.principal.audience, task.principal.email ?? null,
    task.name, task.snapshot.status, task.snapshot.statusMessage,
    Date.parse(task.snapshot.createdAt), Date.parse(task.snapshot.lastUpdatedAt), task.expiresAt ?? null);
  }

  async create(taskId: string, principal: AccessPrincipal, input: EngineeringTaskInput): Promise<TaskSnapshot> {
    const validated = EngineeringTaskInputSchema.parse(input);
    const snapshot = this.ctx.storage.transactionSync(() => {
      const existing = this.loadTask();
      if (existing) throw new Error("engineering_task_already_exists");
      const now = new Date().toISOString();
      const snapshot: TaskSnapshot = {
        taskId, status: "working", statusMessage: `Queued ${input.name}`,
        createdAt: now, lastUpdatedAt: now, ttlMs: null,
      };
      writeJson(this.ctx.storage.sql, "input", validated);
      this.saveTask({ principal, snapshot, name: input.name });
      return snapshot;
    });
    // No intervening await: SQL and the alarm coalesce into one durable commit.
    await this.ctx.storage.setAlarm(Date.now());
    return snapshot;
  }

  private owned(principal: AccessPrincipal) {
    const task = this.loadTask();
    if (!task || task.principal.subject !== principal.subject || task.principal.audience !== principal.audience
      || (task.expiresAt !== undefined && task.expiresAt <= Date.now())) return null;
    return task;
  }

  async read(principal: AccessPrincipal, includeResult = true): Promise<TaskSnapshot | null> {
    const task = this.owned(principal);
    if (!task) return null;
    return includeResult && task.snapshot.status === "completed"
      ? { ...task.snapshot, result: TaskResultSchema.parse(readJson(this.ctx.storage.sql, "result")) }
      : task.snapshot;
  }

  async cancel(principal: AccessPrincipal): Promise<boolean> {
    const task = this.owned(principal);
    if (!task) return false;
    // Retirement is irreversible. Cancellation acknowledges intent but never
    // abandons a half-retired Organization; the extension permits this.
    if (task.snapshot.status !== "working" || task.name === "retire_org") return true;
    await this.finish("cancelled");
    return true;
  }

  /** `errorCode` names a failed result, as `tool` logged it, for the audit record. */
  private async finish(status: "completed" | "cancelled", result?: TaskResult, errorCode?: string) {
    let finished: StoredTask | undefined;
    const expiresAt = this.ctx.storage.transactionSync(() => {
      const current = this.loadTask();
      if (!current || current.snapshot.status !== "working") return;
      finished = current;
      const now = Date.now();
      const expiresAt = now + TASK_RETENTION_MS;
      const snapshot: TaskSnapshot = {
        ...current.snapshot, status, lastUpdatedAt: new Date(now).toISOString(),
        statusMessage: status === "cancelled" ? "Cancelled; an in-flight read may still finish" : result?.isError ? "Tool returned an error" : "Completed",
        ttlMs: expiresAt - Date.parse(current.snapshot.createdAt),
      };
      if (result) writeJson(this.ctx.storage.sql, "result", result);
      this.ctx.storage.sql.exec("DELETE FROM engineering_task_payloads WHERE kind = 'input'");
      this.saveTask({ ...current, snapshot, expiresAt });
      return expiresAt;
    });
    if (expiresAt !== undefined) await this.ctx.storage.setAlarm(expiresAt);
    if (finished) {
      await writeAuditEventOrLog(this.env, finished.principal, {
        event: "task_finished", tool: finished.name, taskId: finished.snapshot.taskId,
        outcome: status === "cancelled" ? "cancelled" : result?.isError ? "failed" : "succeeded",
        ...(result?.isError ? { errorCode: errorCode ?? "tool_failed" } : {}),
      });
    }
  }

  override async alarm(info?: AlarmInvocationInfo) {
    let task: StoredTask | undefined;
    try {
      task = this.loadTask();
      if (!task) return;
      if (task.expiresAt !== undefined) {
        if (task.expiresAt <= Date.now()) {
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec("DELETE FROM engineering_task_payloads");
            this.ctx.storage.sql.exec("DELETE FROM engineering_task");
          });
        } else await this.ctx.storage.setAlarm(task.expiresAt);
        return;
      }
      task.snapshot = { ...task.snapshot, lastUpdatedAt: new Date().toISOString(), statusMessage: `Running ${task.name}` };
      this.saveTask(task);
      const input = EngineeringTaskInputSchema.parse(readJson(this.ctx.storage.sql, "input"));
      const { result, incomplete } = await executeEngineeringTask(this.env, task.principal, input);
      if (incomplete && (info?.retryCount ?? 0) < ALARM_RETRIES) {
        task.snapshot.statusMessage = `Retirement incomplete: ${incomplete.remaining} remaining; retrying`;
        task.snapshot.lastUpdatedAt = new Date().toISOString();
        this.saveTask(task);
        // The regional walk attempts every node. Incomplete means failed
        // work, not a page of normal progress; native failure backoff applies.
        throw new Error("engineering_retirement_incomplete");
      }
      await this.finish(
        "completed",
        incomplete ? { ...result, isError: true } : result,
        incomplete ? "engineering_retirement_incomplete" : toolResultFailureCode(result),
      );
    } catch (error) {
      // Already-terminal tasks must retry a failed cleanup, not complete again.
      if (task?.expiresAt !== undefined) throw error;
      const schemaCode = zodDiagnosticCode(error, "engineering_task_input");
      const dataCode = schemaCode ?? (error instanceof TaskDataError ? error.message
        : error instanceof SyntaxError ? "engineering_task_input_invalid_json" : undefined);
      // Stored-input failures cannot recover by retrying unchanged data.
      // Other catchable failures get the platform's retry budget first.
      if (!dataCode && (info?.retryCount ?? 0) < ALARM_RETRIES) throw error;
      const code = dataCode ?? toolErrorCode(error, "engineering_task_alarm");
      await this.finish("completed", { isError: true, content: [{ type: "text", text: code }] }, code);
    }
  }
}
