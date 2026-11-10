import { DurableObject } from "cloudflare:workers";

import type { AccessPrincipal } from "./access";
import type { Env } from "./env";
import { executeEngineeringTask } from "./server";
import { EngineeringTaskInputSchema, TaskResultSchema, TASK_RETENTION_MS, type EngineeringTaskInput, type TaskResult, type TaskSnapshot } from "./tasks";

type StoredTask = {
  principal: AccessPrincipal;
  snapshot: TaskSnapshot;
  name: EngineeringTaskInput["name"];
  expiresAt?: number;
};

// Storage segmentation, not a result-size cap: every chunk is retained. Small
// chunks also work on runtimes predating the SQLite KV value-limit increase.
const CHUNK_CHARACTERS = 32 * 1_024;
// Cloudflare's native alarm retry budget, not an application retry policy.
// https://developers.cloudflare.com/durable-objects/api/alarms/ (2026-11-10)
const ALARM_RETRIES = 6;

async function writeJson(storage: DurableObjectStorage | DurableObjectTransaction, key: string, value: unknown) {
  const json = JSON.stringify(value);
  const count = Math.ceil(json.length / CHUNK_CHARACTERS);
  for (let index = 0; index < count; index++) {
    await storage.put(`${key}:${index}`, json.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS));
  }
  await storage.put(`${key}:count`, count);
}

async function readJson(storage: DurableObjectStorage, key: string): Promise<unknown> {
  const count = await storage.get<number>(`${key}:count`);
  if (count === undefined) throw new Error(`engineering_task_missing_${key}`);
  const chunks: string[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = await storage.get<string>(`${key}:${index}`);
    if (chunk === undefined) throw new Error(`engineering_task_missing_${key}_chunk`);
    chunks.push(chunk);
  }
  return JSON.parse(chunks.join(""));
}

async function deleteJson(storage: DurableObjectStorage | DurableObjectTransaction, key: string) {
  const count = await storage.get<number>(`${key}:count`) ?? 0;
  for (let index = 0; index < count; index++) await storage.delete(`${key}:${index}`);
  await storage.delete(`${key}:count`);
}

/** One execution and its result per object. Its sole alarm executes or expires
 * that task; this is separate from the regional product alarm coordinator. */
export class EngineeringTaskDO extends DurableObject<Env> {
  async create(taskId: string, principal: AccessPrincipal, input: EngineeringTaskInput): Promise<TaskSnapshot> {
    const validated = EngineeringTaskInputSchema.parse(input);
    return this.ctx.storage.transaction(async (storage) => {
      const existing = await storage.get<StoredTask>("task");
      if (existing) throw new Error("engineering_task_already_exists");
      const now = new Date().toISOString();
      const snapshot: TaskSnapshot = {
        taskId, status: "working", statusMessage: `Queued ${input.name}`,
        createdAt: now, lastUpdatedAt: now, ttlMs: null,
      };
      await writeJson(storage, "input", validated);
      await storage.put<StoredTask>("task", { principal, snapshot, name: input.name });
      await storage.setAlarm(Date.now());
      return snapshot;
    });
  }

  private async owned(principal: AccessPrincipal) {
    const task = await this.ctx.storage.get<StoredTask>("task");
    if (!task || task.principal.subject !== principal.subject || task.principal.audience !== principal.audience
      || (task.expiresAt !== undefined && task.expiresAt <= Date.now())) return null;
    return task;
  }

  async read(principal: AccessPrincipal, includeResult = true): Promise<TaskSnapshot | null> {
    const task = await this.owned(principal);
    if (!task) return null;
    return includeResult && task.snapshot.status === "completed"
      ? { ...task.snapshot, result: TaskResultSchema.parse(await readJson(this.ctx.storage, "result")) }
      : task.snapshot;
  }

  async cancel(principal: AccessPrincipal): Promise<boolean> {
    const task = await this.owned(principal);
    if (!task) return false;
    // Retirement is irreversible. Cancellation acknowledges intent but never
    // abandons a half-retired Organization; the extension permits this.
    if (task.snapshot.status !== "working" || task.name === "retire_org") return true;
    await this.finish(task, "cancelled");
    return true;
  }

  private async finish(task: StoredTask, status: "completed" | "cancelled", result?: TaskResult) {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<StoredTask>("task");
      if (!current || current.snapshot.status !== "working") return;
      const now = Date.now();
      const expiresAt = now + TASK_RETENTION_MS;
      const snapshot: TaskSnapshot = {
        ...task.snapshot, status, lastUpdatedAt: new Date(now).toISOString(),
        statusMessage: status === "cancelled" ? "Cancelled; an in-flight read may still finish" : result?.isError ? "Tool returned an error" : "Completed",
        ttlMs: expiresAt - Date.parse(task.snapshot.createdAt),
      };
      if (result) await writeJson(storage, "result", result);
      await deleteJson(storage, "input");
      await storage.put<StoredTask>("task", { ...task, snapshot, expiresAt });
      await storage.setAlarm(expiresAt);
    });
  }

  override async alarm(info?: AlarmInvocationInfo) {
    const task = await this.ctx.storage.get<StoredTask>("task");
    if (!task) return;
    if (task.expiresAt !== undefined) {
      if (task.expiresAt <= Date.now()) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(task.expiresAt);
      return;
    }
    task.snapshot = { ...task.snapshot, lastUpdatedAt: new Date().toISOString(), statusMessage: `Running ${task.name}` };
    await this.ctx.storage.put("task", task);
    const input = EngineeringTaskInputSchema.parse(await readJson(this.ctx.storage, "input"));
    const { result, incomplete } = await executeEngineeringTask(this.env, task.principal, input);
    if (incomplete && (info?.retryCount ?? 0) < ALARM_RETRIES) {
      task.snapshot.statusMessage = `Retirement incomplete: ${incomplete.remaining} remaining; retrying`;
      task.snapshot.lastUpdatedAt = new Date().toISOString();
      await this.ctx.storage.put("task", task);
      // The underlying retirement journal resumes completed children/nodes.
      // Native alarm backoff owns retries; no extra scheduler or retry queue.
      throw new Error("engineering_retirement_incomplete");
    }
    await this.finish(task, "completed", incomplete ? { ...result, isError: true } : result);
  }
}
