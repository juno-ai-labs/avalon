import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDeadLetterQueues, peekDeadLetterQueue } from '../src/cloudflare-queue-admin';
import type { Env } from '../src/env';
import { createTestEnv } from './helpers/cloudflare-test';

function env(): Env {
  return createTestEnv({
    CLOUDFLARE_ACCOUNT_ID: 'account/id',
    CLOUDFLARE_FLAGSHIP_API_TOKEN: 'ace-secret',
  });
}

function cloudflare(result: unknown, extras: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, result, ...extras });
}

const accountQueues = [
  {
    queue_id: 'source-id',
    queue_name: 'avalon-global-activities',
    consumers: [
      { dead_letter_queue: 'avalon-global-activities-dead-letter' },
      { dead_letter_queue: 'avalon-global-activities-dead-letter' },
    ],
  },
  {
    queue_id: 'dead-letter-id',
    queue_name: 'avalon-global-activities-dead-letter',
    consumers: [],
  },
  {
    queue_id: 'ordinary-id',
    queue_name: 'looks-like-a-dead-letter',
    consumers: [],
  },
];

describe('Cloudflare dead-letter Queue administration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds active dead-letter relationships and reads their realtime backlog metrics', async () => {
    const cloudflareFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(cloudflare(accountQueues, { result_info: { page: 1, total_pages: 1 } }))
      .mockResolvedValueOnce(cloudflare({
        backlog_bytes: 4096,
        backlog_count: 3,
        oldest_message_timestamp_ms: 1_723_000_000_000,
      }));

    await expect(listDeadLetterQueues(env())).resolves.toEqual([{
      id: 'dead-letter-id',
      name: 'avalon-global-activities-dead-letter',
      sourceQueues: ['avalon-global-activities'],
      metrics: {
        backlogBytes: 4096,
        backlogCount: 3,
        oldestMessageTimestampMs: 1_723_000_000_000,
      },
    }]);
    expect(cloudflareFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/queues?page=1&per_page=100',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ace-secret' }) }),
    );
    expect(cloudflareFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/queues/dead-letter-id/metrics',
      expect.any(Object),
    );
  });

  it('does not classify an unreferenced queue by its name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      cloudflare(accountQueues.slice(2), { result_info: { page: 1, total_pages: 1 } }),
    );
    await expect(listDeadLetterQueues(env())).resolves.toEqual([]);
  });

  it('keeps every DLQ visible when one realtime metrics request fails', async () => {
    const queues = [
      ...accountQueues,
      {
        queue_id: 'second-source-id',
        queue_name: 'avalon-regional-events',
        consumers: [{ dead_letter_queue: 'avalon-regional-events-dead-letter' }],
      },
      {
        queue_id: 'second-dead-letter-id',
        queue_name: 'avalon-regional-events-dead-letter',
        consumers: [],
      },
    ];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(cloudflare(queues, { result_info: { page: 1, total_pages: 1 } }))
      .mockResolvedValueOnce(Response.json({
        success: false,
        errors: [{ code: 10_001, message: 'metrics temporarily unavailable' }],
      }, { status: 503 }))
      .mockResolvedValueOnce(cloudflare({ backlog_bytes: 100, backlog_count: 1 }));

    await expect(listDeadLetterQueues(env())).resolves.toEqual([
      {
        id: 'second-dead-letter-id',
        name: 'avalon-regional-events-dead-letter',
        sourceQueues: ['avalon-regional-events'],
        metrics: { backlogBytes: 100, backlogCount: 1, oldestMessageTimestampMs: null },
      },
      {
        id: 'dead-letter-id',
        name: 'avalon-global-activities-dead-letter',
        sourceQueues: ['avalon-global-activities'],
        metrics: null,
        metricsError: 'Cloudflare Queues request failed (503): metrics temporarily unavailable · code 10001',
      },
    ]);
  });

  it('peeks without an Ace-chosen batch cap, leasing messages, or exposing purge refs', async () => {
    const cloudflareFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(cloudflare(accountQueues, { result_info: { page: 1, total_pages: 1 } }))
      .mockResolvedValueOnce(cloudflare({ messages: [{
        id: 'message-id',
        attempts: 6,
        body: '{"kind":"activity"}',
        metadata: { 'CF-Content-Type': 'json' },
        ref: 'purge-capability-must-stay-server-side',
        timestamp_ms: 1_723_000_000_000,
      }] }));

    await expect(peekDeadLetterQueue(env(), 'dead-letter-id')).resolves.toEqual([{
      id: 'message-id',
      attempts: 6,
      body: '{"kind":"activity"}',
      metadata: { 'CF-Content-Type': 'json' },
      timestampMs: 1_723_000_000_000,
    }]);
    expect(cloudflareFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account%2Fid/queues/dead-letter-id/messages/peek',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(cloudflareFetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('refuses to peek at a queue that is not an active dead-letter target', async () => {
    const cloudflareFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      cloudflare(accountQueues, { result_info: { page: 1, total_pages: 1 } }),
    );
    await expect(peekDeadLetterQueue(env(), 'ordinary-id')).rejects.toThrow(
      'not an active dead-letter queue',
    );
    expect(cloudflareFetch).toHaveBeenCalledTimes(1);
  });
});
