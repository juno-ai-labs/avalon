import type { Env } from "./env";
import { CloudflareQueryError, cloudflareResult } from "./cloudflare-api";

type Queue = { queue_id: string; queue_name: string; consumers?: Array<{ dead_letter_queue?: string }> };

async function request(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (!env.QUEUES_API_TOKEN) throw new CloudflareQueryError("queues_token_unconfigured", "QUEUES_API_TOKEN is not configured");
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/queues${path}`, {
    ...init, headers: { Authorization: `Bearer ${env.QUEUES_API_TOKEN}`, "Content-Type": "application/json" },
  });
}

async function accountQueues(env: Env): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (let page = 1; ; page++) {
    const response = await request(env, `?page=${page}&per_page=100`);
    const envelope = await response.clone().json() as { result_info?: { total_pages?: number } };
    const rows = await cloudflareResult(response, "queue_list_failed") as Queue[];
    queues.push(...rows);
    if (envelope.result_info?.total_pages !== undefined ? page >= envelope.result_info.total_pages : rows.length < 100) return queues;
  }
}

function sources(queues: Queue[], queue: Queue): string[] {
  return queues.filter((source) => source.consumers?.some((c) => c.dead_letter_queue === queue.queue_name)).map((q) => q.queue_name);
}

export async function inspectQueues(env: Env, deadLettersOnly: boolean): Promise<unknown> {
  const queues = await accountQueues(env);
  const result = [];
  for (const queue of queues) {
    const sourceQueues = sources(queues, queue);
    if (deadLettersOnly && sourceQueues.length === 0) continue;
    const metrics = await cloudflareResult(await request(env, `/${encodeURIComponent(queue.queue_id)}/metrics`), "queue_metrics_failed");
    result.push({ id: queue.queue_id, name: queue.queue_name, sourceQueues, metrics });
  }
  return result;
}

export async function peekDeadLetters(env: Env, queueId: string): Promise<unknown> {
  const queues = await accountQueues(env);
  const queue = queues.find((q) => q.queue_id === queueId);
  if (!queue || sources(queues, queue).length === 0) throw new CloudflareQueryError("queue_not_dead_letter", "Select an active dead-letter queue returned by inspect_queues");
  // Peek never acknowledges messages or leases them away from the consumer.
  return cloudflareResult(await request(env, `/${encodeURIComponent(queueId)}/messages/peek`, { method: "POST" }), "queue_peek_failed");
}
