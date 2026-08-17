import { z } from "zod";

import type { Env } from "../env";
import type { PostgresAgentLoopInput } from "../workflows/postgres-agent-loop";
import { createPostgresClient, productDataAuthority } from "./runtime";

const WorkflowStartMessageSchema = z.object({
  version: z.literal(1),
  run_id: z.string().uuid(),
  workflow_instance_id: z.string().min(1).max(100),
  expected_run_revision: z.coerce.number().int().positive(),
}).strict();

const WorkflowSignalMessageSchema = z.object({
  version: z.literal(1),
  signal_id: z.string().uuid(),
  run_id: z.string().uuid(),
  workflow_instance_id: z.string().min(1).max(100),
  control_revision: z.coerce.number().int().positive(),
  signal_kind: z.enum(["steer", "interrupt", "cancel", "resume", "provider_event"]),
}).strict();

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

function safeErrorClass(error: unknown): string {
  if (error instanceof z.ZodError) return "invalid_queue_message";
  if (workflowAlreadyExists(error)) return "workflow_already_exists";
  return "workflow_control_delivery_failed";
}

export async function startPostgresAgentLoop(
  env: Env,
  input: Omit<PostgresAgentLoopInput, "version" | "region">,
): Promise<void> {
  try {
    await env.POSTGRES_AGENT_LOOP_WORKFLOW.create({
      id: input.workflowInstanceId,
      params: {
        version: 1,
        region: env.AVALON_REGION,
        ...input,
      } satisfies PostgresAgentLoopInput,
    });
  } catch (error) {
    if (!workflowAlreadyExists(error)) throw error;
  }
}

export async function signalPostgresAgentLoop(
  env: Env,
  workflowInstanceId: string,
  payload: { signalId: string; runId: string; controlRevision: number; signalKind: string },
): Promise<void> {
  const instance = await env.POSTGRES_AGENT_LOOP_WORKFLOW.get(workflowInstanceId);
  await instance.sendEvent({ type: "run-signal", payload });
}

async function drainWorkflowStarts(env: Env): Promise<number> {
  const client = createPostgresClient(env, "queue_runner");
  let completed = 0;
  try {
    const messages = await client.readQueue("workflow_starts", 32);
    for (const item of messages) {
      try {
        const message = WorkflowStartMessageSchema.parse(item.message);
        await startPostgresAgentLoop(env, {
          runId: message.run_id,
          workflowInstanceId: message.workflow_instance_id,
          expectedRunRevision: message.expected_run_revision,
        });
        await client.deleteQueueMessage("workflow_starts", item.messageId);
        completed += 1;
      } catch (error) {
        if (item.readCount >= 10) {
          const parsed = WorkflowStartMessageSchema.safeParse(item.message);
          await client.deadLetterQueueMessage({
            queueName: "workflow_starts",
            messageId: item.messageId,
            semanticKey: parsed.success ? parsed.data.run_id : `message-${item.messageId}`,
            message: item.message,
            errorClass: safeErrorClass(error),
            attempts: item.readCount,
          });
        }
      }
    }
  } finally {
    await client.close();
  }
  return completed;
}

async function drainWorkflowSignals(env: Env): Promise<number> {
  const client = createPostgresClient(env, "queue_runner");
  let completed = 0;
  try {
    const messages = await client.readQueue("workflow_signals", 32);
    for (const item of messages) {
      try {
        const message = WorkflowSignalMessageSchema.parse(item.message);
        await signalPostgresAgentLoop(env, message.workflow_instance_id, {
          signalId: message.signal_id,
          runId: message.run_id,
          controlRevision: message.control_revision,
          signalKind: message.signal_kind,
        });
        await client.deleteQueueMessage("workflow_signals", item.messageId);
        completed += 1;
      } catch (error) {
        if (item.readCount >= 10) {
          const parsed = WorkflowSignalMessageSchema.safeParse(item.message);
          await client.deadLetterQueueMessage({
            queueName: "workflow_signals",
            messageId: item.messageId,
            semanticKey: parsed.success ? parsed.data.signal_id : `message-${item.messageId}`,
            message: item.message,
            errorClass: safeErrorClass(error),
            attempts: item.readCount,
          });
        }
      }
    }
  } finally {
    await client.close();
  }
  return completed;
}

/**
 * Durable fallback for the low-latency API handoff. Queue rows are committed
 * with product state, so a Worker/Workflow outage delays work but cannot lose
 * either a start or a steering signal.
 */
export async function drainPostgresWorkflowControl(env: Env): Promise<{
  starts: number;
  signals: number;
}> {
  if (productDataAuthority(env) !== "postgres") return { starts: 0, signals: 0 };
  const [starts, signals] = await Promise.all([
    drainWorkflowStarts(env),
    drainWorkflowSignals(env),
  ]);
  return { starts, signals };
}
