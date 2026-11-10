import type { Env } from "./env";
import { CloudflareQueryError, cloudflareResult } from "./cloudflare-api";

type QueueEnvironment = Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "QUEUES_API_TOKEN">;

type Queue = { queue_id: string; queue_name: string; consumers?: Array<{ dead_letter_queue?: string }> };

async function request(env: QueueEnvironment, path: string, init?: RequestInit): Promise<Response> {
  if (!env.QUEUES_API_TOKEN) throw new CloudflareQueryError("queues_token_unconfigured", "QUEUES_API_TOKEN is not configured");
  try {
    return await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/queues${path}`, {
      ...init, headers: { Authorization: `Bearer ${env.QUEUES_API_TOKEN}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    throw new CloudflareQueryError("queue_request_failed", "Cloudflare Queues could not be reached");
  }
}

async function accountQueues(env: QueueEnvironment): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (let page = 1; ; page++) {
    const response = await request(env, `?page=${page}&per_page=100`);
    const rows = await cloudflareResult(response, "queue_list_failed") as Queue[];
    queues.push(...rows);
    if (rows.length < 100) return queues;
  }
}

function sources(queues: Queue[], queue: Queue): string[] {
  return queues.filter((source) => source.consumers?.some((c) => c.dead_letter_queue === queue.queue_name)).map((q) => q.queue_name);
}

export async function inspectQueues(env: QueueEnvironment, deadLettersOnly: boolean): Promise<unknown> {
  const queues = await accountQueues(env);
  return Promise.all(queues.filter((queue) => !deadLettersOnly || sources(queues, queue).length > 0).map(async (queue) => {
    const summary = { id: queue.queue_id, name: queue.queue_name, sourceQueues: sources(queues, queue) };
    try {
      const metrics = await cloudflareResult(await request(env, `/${encodeURIComponent(queue.queue_id)}/metrics`), "queue_metrics_failed");
      return { ...summary, metrics };
    } catch (error) {
      return { ...summary, metrics: null, metricsError: error instanceof CloudflareQueryError ? error.code : "queue_metrics_request_failed" };
    }
  }));
}

export async function peekDeadLetters(env: QueueEnvironment, queueId: string): Promise<unknown> {
  const queues = await accountQueues(env);
  const queue = queues.find((q) => q.queue_id === queueId);
  if (!queue || sources(queues, queue).length === 0) throw new CloudflareQueryError("queue_not_dead_letter", "Select an active dead-letter queue returned by inspect_queues");
  // Peek never acknowledges messages or leases them away from the consumer.
  return cloudflareResult(await request(env, `/${encodeURIComponent(queueId)}/messages/peek`, { method: "POST" }), "queue_peek_failed");
}
