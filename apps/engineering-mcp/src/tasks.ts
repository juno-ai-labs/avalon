import { ProtocolError, ProtocolErrorCode, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RetireEngineeringOrgInputSchema } from "@rally/contracts/engineering-inspection";

import type { AccessPrincipal } from "./access";
import type { Env } from "./env";
import { LAKEHOUSE_TABLES } from "./lakehouse";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const TASK_CARRIER = "ai.rally/engineering-task";
export const TASK_METHODS = ["tasks/get", "tasks/cancel", "tasks/update"] as const;
// The SDK reserves the old core tasks/* methods and refuses them in the modern
// era even when registered with an extension schema. The HTTP adapter maps the
// three extension methods onto these private dispatch names.
export function taskDispatchMethod(method: string) { return `rally/${method}`; }
// Selected by the team on 2026-11-10: seven days after completion.
export const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const EngineeringTaskInputSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("query_data_lake"), arguments: z.object({ lakehouse: z.enum(LAKEHOUSE_TABLES), sql: z.string().min(1) }) }),
  z.object({ name: z.literal("retire_org"), arguments: RetireEngineeringOrgInputSchema }),
]);
export type EngineeringTaskInput = z.infer<typeof EngineeringTaskInputSchema>;

export const TaskResultSchema = z.object({
  resultType: z.literal("complete").default("complete"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
});
export type TaskResult = z.input<typeof TaskResultSchema>;

export const TaskSnapshotSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(["working", "completed", "cancelled"]),
  statusMessage: z.string(),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
  ttlMs: z.number().nullable(),
  result: TaskResultSchema.optional(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

export function acceptsTasks(ctx: ServerContext): boolean {
  return z.object({
    "io.modelcontextprotocol/clientCapabilities": z.object({ extensions: z.object({ [TASKS_EXTENSION]: z.object({}) }) }),
  }).safeParse(ctx.mcpReq.envelope).success;
}

function taskStub(env: Env, taskId: string) {
  if (!env.ENGINEERING_TASKS) throw new Error("engineering_tasks_unconfigured");
  return env.ENGINEERING_TASKS.get(env.ENGINEERING_TASKS.idFromName(taskId));
}

export async function createTaskCarrier(env: Env, principal: AccessPrincipal, input: EngineeringTaskInput) {
  const taskId = crypto.randomUUID();
  const task = TaskSnapshotSchema.parse(await taskStub(env, taskId).create(taskId, principal, input));
  // SDK v2 validates CallToolResult and stamps resultType="complete". Keep its
  // request validation and Origin checks; the HTTP adapter unwraps this carrier
  // into the extension's CreateTaskResult *after* SDK serialization.
  return { content: [], _meta: { [TASK_CARRIER]: task } };
}

export function registerTaskMethods(server: McpServer, env: Env, principal: AccessPrincipal) {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
  const params = z.object({ taskId: z.uuid() });
  function requireCapability(ctx: ServerContext) {
    if (!acceptsTasks(ctx)) {
      throw new ProtocolError(-32021, "Missing required client capability", {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      });
    }
  }
  async function read(taskId: string, ctx: ServerContext, includeResult = true) {
    requireCapability(ctx);
    const task = await taskStub(env, taskId).read(principal, includeResult);
    if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "task_not_found");
    return TaskSnapshotSchema.parse(task);
  }
  server.server.setRequestHandler(taskDispatchMethod("tasks/get"), { params }, async ({ taskId }, ctx) => read(taskId, ctx));
  server.server.setRequestHandler(taskDispatchMethod("tasks/cancel"), { params }, async ({ taskId }, ctx) => {
    requireCapability(ctx);
    if (!await taskStub(env, taskId).cancel(principal)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "task_not_found");
    }
    return {};
  });
  server.server.setRequestHandler(taskDispatchMethod("tasks/update"), {
    params, // The SDK lifts inputResponses into ctx.mcpReq before validation.
  }, async ({ taskId }, ctx) => {
    await read(taskId, ctx, false);
    // These tools never request input. The extension ignores unknown keys.
    return {};
  });
}
