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

const SidebarAttentionMessageSchema = z.object({
  version: z.literal(1),
  attention_event_id: z.coerce.number().int().positive(),
  workspace_id: z.string().uuid(),
  workstream_id: z.string().uuid(),
  access_revision: z.coerce.number().int().positive(),
}).strict();

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

function safeErrorClass(error: unknown): string {
  if (error instanceof z.ZodError) return "invalid_queue_message";
  if (workflowAlreadyExists(error)) return "workflow_already_exists";
  return "workflow_control_delivery_failed";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function requestHash(value: unknown): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  ));
}

async function withQueueLeaseRenewal<T>(
  client: ReturnType<typeof createPostgresClient>,
  queueName: string,
  semanticKey: string,
  messageId: number,
  requestHash: Uint8Array,
  claimToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let wakeStop: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => { wakeStop = resolve; });
  const renewer = (async () => {
    while (!stopped) {
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
        stoppedPromise,
      ]);
      if (stopped) return;
      if (!await client.renewQueueMessage({
        queueName, semanticKey, messageId, requestHash, claimToken,
      })) {
        throw new Error("queue_lease_lost");
      }
    }
  })();
  try {
    const result = await Promise.race([operation(), renewer.then(() => {
      throw new Error("queue_lease_renewer_stopped_early");
    })]);
    return result;
  } finally {
    stopped = true;
    wakeStop?.();
    await renewer;
  }
}

async function claimQueueDelivery(
  client: ReturnType<typeof createPostgresClient>,
  queueName: string,
  messageId: number,
  semanticKey: string,
  message: unknown,
): Promise<{
  alreadyCompleted: boolean;
  busy: boolean;
  hash: Uint8Array;
  claimToken?: string;
}> {
  const hash = await requestHash(message);
  const state = await client.claimQueueInbox({
    queueName,
    semanticKey,
    messageId,
    requestHash: hash,
  });
  return {
    alreadyCompleted: state.state === "completed",
    busy: state.state === "busy",
    hash,
    ...(state.claimToken ? { claimToken: state.claimToken } : {}),
  };
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
      const parsed = WorkflowStartMessageSchema.safeParse(item.message);
      const semanticKey = parsed.success ? parsed.data.run_id : `message-${item.messageId}`;
      let delivery: Awaited<ReturnType<typeof claimQueueDelivery>> | undefined;
      try {
        delivery = await claimQueueDelivery(
          client, "workflow_starts", item.messageId, semanticKey, item.message,
        );
        if (delivery.busy) continue;
        if (!delivery.alreadyCompleted) {
          if (!delivery.claimToken) throw new Error("workflow_start_claim_token_missing");
          if (!parsed.success) throw parsed.error;
          const message = parsed.data;
          await withQueueLeaseRenewal(
            client, "workflow_starts", semanticKey, item.messageId,
            delivery.hash, delivery.claimToken, () =>
            startPostgresAgentLoop(env, {
              runId: message.run_id,
              workflowInstanceId: message.workflow_instance_id,
              expectedRunRevision: message.expected_run_revision,
            }),
          );
          if (!await client.completeQueueInbox({
            queueName: "workflow_starts",
            semanticKey,
            messageId: item.messageId,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
            resultRef: message.run_id,
          })) throw new Error("workflow_start_inbox_completion_failed");
        }
        await client.deleteQueueMessage("workflow_starts", item.messageId);
        completed += 1;
      } catch (error) {
        if (item.readCount >= 10 && delivery?.claimToken) {
          await client.deadLetterQueueMessage({
            queueName: "workflow_starts",
            messageId: item.messageId,
            semanticKey,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
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
      const parsed = WorkflowSignalMessageSchema.safeParse(item.message);
      const semanticKey = parsed.success ? parsed.data.signal_id : `message-${item.messageId}`;
      let delivery: Awaited<ReturnType<typeof claimQueueDelivery>> | undefined;
      try {
        delivery = await claimQueueDelivery(
          client, "workflow_signals", item.messageId, semanticKey, item.message,
        );
        if (delivery.busy) continue;
        if (!delivery.alreadyCompleted) {
          if (!delivery.claimToken) throw new Error("workflow_signal_claim_token_missing");
          if (!parsed.success) throw parsed.error;
          const message = parsed.data;
          await withQueueLeaseRenewal(
            client, "workflow_signals", semanticKey, item.messageId,
            delivery.hash, delivery.claimToken, () =>
            signalPostgresAgentLoop(env, message.workflow_instance_id, {
              signalId: message.signal_id,
              runId: message.run_id,
              controlRevision: message.control_revision,
              signalKind: message.signal_kind,
            }),
          );
          if (!await client.completeQueueInbox({
            queueName: "workflow_signals",
            semanticKey,
            messageId: item.messageId,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
            resultRef: message.signal_id,
          })) throw new Error("workflow_signal_inbox_completion_failed");
        }
        await client.deleteQueueMessage("workflow_signals", item.messageId);
        completed += 1;
      } catch (error) {
        if (item.readCount >= 10 && delivery?.claimToken) {
          await client.deadLetterQueueMessage({
            queueName: "workflow_signals",
            messageId: item.messageId,
            semanticKey,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
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

async function drainSidebarAttention(env: Env): Promise<number> {
  const client = createPostgresClient(env, "queue_runner");
  let completed = 0;
  try {
    const messages = await client.readQueue("sidebar_attention", 32);
    for (const item of messages) {
      const parsed = SidebarAttentionMessageSchema.safeParse(item.message);
      const semanticKey = parsed.success
        ? String(parsed.data.attention_event_id)
        : `message-${item.messageId}`;
      let delivery: Awaited<ReturnType<typeof claimQueueDelivery>> | undefined;
      try {
        delivery = await claimQueueDelivery(
          client, "sidebar_attention", item.messageId, semanticKey, item.message,
        );
        if (delivery.busy) continue;
        if (!delivery.alreadyCompleted) {
          if (!delivery.claimToken) throw new Error("sidebar_attention_claim_token_missing");
          if (!parsed.success) throw parsed.error;
          const message = parsed.data;
          const result = await withQueueLeaseRenewal(
            client, "sidebar_attention", semanticKey, item.messageId,
            delivery.hash, delivery.claimToken,
            () => client.materializeAttentionMentions(message.attention_event_id),
          );
          if (result.completed === true && !await client.completeQueueInbox({
            queueName: "sidebar_attention",
            semanticKey,
            messageId: item.messageId,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
          })) throw new Error("sidebar_attention_inbox_completion_failed");
        }
        await client.deleteQueueMessage("sidebar_attention", item.messageId);
        completed += 1;
      } catch (error) {
        if (item.readCount >= 10 && delivery?.claimToken) {
          await client.deadLetterQueueMessage({
            queueName: "sidebar_attention",
            messageId: item.messageId,
            semanticKey,
            requestHash: delivery.hash,
            claimToken: delivery.claimToken,
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
  sidebarAttention: number;
}> {
  if (productDataAuthority(env) !== "postgres") return { starts: 0, signals: 0, sidebarAttention: 0 };
  const [starts, signals, sidebarAttention] = await Promise.all([
    drainWorkflowStarts(env),
    drainWorkflowSignals(env),
    drainSidebarAttention(env),
  ]);
  return { starts, signals, sidebarAttention };
}
