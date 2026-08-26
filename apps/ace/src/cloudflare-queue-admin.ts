import type { Env } from './env';

const LIST_PAGE_SIZE = 100;

interface CloudflareEnvelope<Result> {
  success?: boolean;
  result?: Result;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { page?: number; total_pages?: number };
}

interface CloudflareConsumer {
  dead_letter_queue?: string;
}

interface CloudflareQueue {
  queue_id?: string;
  queue_name?: string;
  consumers?: CloudflareConsumer[];
}

interface QueueMetrics {
  backlog_bytes?: number;
  backlog_count?: number;
  oldest_message_timestamp_ms?: number;
}

interface PeekedMessage {
  id?: string;
  attempts?: number;
  body?: string;
  metadata?: unknown;
  timestamp_ms?: number;
}

export interface DeadLetterQueueSummary {
  id: string;
  name: string;
  sourceQueues: string[];
  metrics: {
    backlogBytes: number;
    backlogCount: number;
    oldestMessageTimestampMs: number | null;
  } | null;
  metricsError?: string;
}

export interface DeadLetterQueueMessage {
  id: string;
  attempts: number | null;
  body: string;
  metadata: unknown;
  timestampMs: number | null;
}

function endpoint(env: Env, path = ''): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`
    + `/queues${path}`;
}

function failureDetail(body: CloudflareEnvelope<unknown> | null): string {
  return (body?.errors ?? [])
    .map((error) => [error.message, error.code === undefined ? null : `code ${error.code}`].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('; ');
}

async function request<Result>(env: Env, path: string, init?: RequestInit): Promise<{
  body: CloudflareEnvelope<Result>;
  result: Result;
}> {
  const response = await fetch(endpoint(env, path), {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.CLOUDFLARE_FLAGSHIP_API_TOKEN}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await response.json().catch(() => null) as CloudflareEnvelope<Result> | null;
  if (!response.ok || body?.success !== true || body.result === undefined) {
    const detail = failureDetail(body);
    throw new Error(`Cloudflare Queues request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return { body, result: body.result };
}

async function listAccountQueues(env: Env): Promise<CloudflareQueue[]> {
  const queues: CloudflareQueue[] = [];
  for (let page = 1; ; page += 1) {
    const { body, result } = await request<CloudflareQueue[]>(
      env,
      `?page=${page}&per_page=${LIST_PAGE_SIZE}`,
    );
    queues.push(...(Array.isArray(result) ? result : []));
    const totalPages = body.result_info?.total_pages;
    if (typeof totalPages === 'number' ? page >= totalPages : result.length < LIST_PAGE_SIZE) return queues;
  }
}

function queueIdentity(queue: CloudflareQueue): { id: string; name: string } | null {
  return typeof queue.queue_id === 'string' && queue.queue_id.length > 0
    && typeof queue.queue_name === 'string' && queue.queue_name.length > 0
    ? { id: queue.queue_id, name: queue.queue_name }
    : null;
}

async function readMetrics(env: Env, queueId: string): Promise<DeadLetterQueueSummary['metrics']> {
  const { result } = await request<QueueMetrics>(env, `/${encodeURIComponent(queueId)}/metrics`);
  return {
    backlogBytes: typeof result.backlog_bytes === 'number' ? result.backlog_bytes : 0,
    backlogCount: typeof result.backlog_count === 'number' ? result.backlog_count : 0,
    oldestMessageTimestampMs: typeof result.oldest_message_timestamp_ms === 'number'
      && result.oldest_message_timestamp_ms > 0
      ? result.oldest_message_timestamp_ms
      : null,
  };
}

/**
 * Cloudflare does not mark a Queue as a DLQ on the Queue itself. The authority
 * is the source consumer's `dead_letter_queue` field, so this deliberately
 * reports only live DLQ relationships rather than guessing from a name suffix.
 */
export async function listDeadLetterQueues(env: Env): Promise<DeadLetterQueueSummary[]> {
  const queues = await listAccountQueues(env);
  const deadLetters = activeDeadLetterQueues(queues);
  const summaries: DeadLetterQueueSummary[] = [];
  // Keep these sequential. An account can have more DLQs than a Worker may
  // hold simultaneous outbound connections, while this operator page does not
  // need to trade reliability for sub-second aggregation.
  for (const queue of deadLetters) {
    try {
      summaries.push({ ...queue, metrics: await readMetrics(env, queue.id) });
    } catch (error) {
      summaries.push({
        ...queue,
        metrics: null,
        metricsError: error instanceof Error ? error.message : 'Queue metrics are unavailable.',
      });
    }
  }
  return summaries.sort((left, right) => {
    const backlogDifference = (right.metrics?.backlogCount ?? -1) - (left.metrics?.backlogCount ?? -1);
    return backlogDifference === 0 ? left.name.localeCompare(right.name) : backlogDifference;
  });
}

function activeDeadLetterQueues(queues: CloudflareQueue[]): Array<{
  id: string;
  name: string;
  sourceQueues: string[];
}> {
  const sourcesByDeadLetterName = new Map<string, string[]>();
  for (const queue of queues) {
    if (typeof queue.queue_name !== 'string') continue;
    for (const consumer of queue.consumers ?? []) {
      if (!consumer.dead_letter_queue) continue;
      const sources = sourcesByDeadLetterName.get(consumer.dead_letter_queue) ?? [];
      sources.push(queue.queue_name);
      sourcesByDeadLetterName.set(consumer.dead_letter_queue, sources);
    }
  }

  return queues.flatMap((queue) => {
    const identity = queueIdentity(queue);
    if (!identity) return [];
    const sourceQueues = sourcesByDeadLetterName.get(identity.name);
    return sourceQueues ? [{ ...identity, sourceQueues: sourceQueues.slice().sort() }] : [];
  });
}

export async function peekDeadLetterQueue(
  env: Env,
  queueId: string,
): Promise<DeadLetterQueueMessage[]> {
  // Re-resolve the active relationships before touching a caller-supplied ID.
  // Access admission alone must not turn this endpoint into an arbitrary Queue
  // browser when the page is specifically scoped to dead letters.
  const deadLetters = activeDeadLetterQueues(await listAccountQueues(env));
  if (!deadLetters.some((queue) => queue.id === queueId)) {
    throw new Error('Cloudflare Queue is not an active dead-letter queue.');
  }
  const { result } = await request<{ messages?: PeekedMessage[] }>(
    env,
    `/${encodeURIComponent(queueId)}/messages/peek`,
    // Cloudflare documents no maximum for peek's optional batch_size and no
    // cursor. Do not invent an Ace ceiling: use the provider-defined batch and
    // report the independent backlog count beside it.
    { method: 'POST' },
  );
  return (result.messages ?? []).map((message) => ({
    id: typeof message.id === 'string' ? message.id : 'unknown',
    attempts: typeof message.attempts === 'number' ? message.attempts : null,
    body: typeof message.body === 'string' ? message.body : '',
    metadata: message.metadata ?? null,
    timestampMs: typeof message.timestamp_ms === 'number' ? message.timestamp_ms : null,
  }));
}
