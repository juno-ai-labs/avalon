import { describe, expect, it, vi } from 'vitest';
import { consumeFlagChanges } from '../src/queues';
import { createTestBatch, createTestD1Database, createTestEnv, createTestQueue } from './helpers/cloudflare-test';

function database(ids: string[], binds: Array<[string, number]> = []): D1Database {
  const sorted = [...ids].sort();
  return createTestD1Database({
    prepare: vi.fn(() => ({
      bind: vi.fn((after: string, limit: number) => {
        binds.push([after, limit]);
        return {
          all: vi.fn(async () => ({
            results: sorted.filter((id) => id > after).slice(0, limit).map((id) => ({ id })),
          })),
        };
      }),
    })),
  });
}

describe('Ace product-flag fanout', () => {
  it('sends one key-only message per workspace to each regional queue', async () => {
    const globalSend = vi.fn(async () => undefined);
    const euSend = vi.fn(async () => undefined);
    const ack = vi.fn();
    const env = createTestEnv({
      GLOBAL_DB: database(['11111111-1111-4111-8111-111111111111']),
      EU_DB: database(['22222222-2222-4222-8222-222222222222']),
      GLOBAL_PRODUCT_FLAG_QUEUE: createTestQueue({ sendBatch: globalSend }),
      EU_PRODUCT_FLAG_QUEUE: createTestQueue({ sendBatch: euSend }),
    });
    await consumeFlagChanges(createTestBatch({
      queue: 'avalon-product-feature-flag-changes',
      messages: [{ body: { kind: 'flagship_product_flag_changed', flagKey: 'meeting-recording-enabled' }, ack, retry: vi.fn() }],
    }), env);

    expect(globalSend).toHaveBeenCalledWith([{ body: {
      kind: 'product_feature_flag_changed', flagKey: 'meeting-recording-enabled', workspaceId: '11111111-1111-4111-8111-111111111111',
    } }]);
    expect(euSend).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('deduplicates flag keys and advances its workspace cursor across pages', async () => {
    const ids = Array.from({ length: 205 }, (_value, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const binds: Array<[string, number]> = [];
    const globalDb = database(ids, binds);
    const globalBatches: MessageSendRequest[][] = [];
    const globalSend = async (batch: Iterable<MessageSendRequest>): Promise<void> => {
      globalBatches.push([...batch]);
    };
    const euSend = vi.fn(async () => undefined);
    const messages = [
      { body: { kind: 'flagship_product_flag_changed', flagKey: 'meeting-recording-enabled' }, ack: vi.fn(), retry: vi.fn() },
      { body: { kind: 'flagship_product_flag_changed', flagKey: 'meeting-recording-enabled' }, ack: vi.fn(), retry: vi.fn() },
      { body: { kind: 'flagship_product_flag_changed', flagKey: 'suggested-work-enabled' }, ack: vi.fn(), retry: vi.fn() },
    ];
    const env = createTestEnv({
      GLOBAL_DB: globalDb,
      EU_DB: database([]),
      GLOBAL_PRODUCT_FLAG_QUEUE: createTestQueue({ sendBatch: globalSend }),
      EU_PRODUCT_FLAG_QUEUE: createTestQueue({ sendBatch: euSend }),
    });

    await consumeFlagChanges(createTestBatch({
      queue: 'avalon-product-feature-flag-changes',
      messages,
    }), env);

    expect(binds).toEqual([
      ['', 100],
      ['00000000-0000-4000-8000-000000000099', 100],
      ['00000000-0000-4000-8000-000000000199', 100],
    ]);
    const bodies = globalBatches.flatMap((batch) => batch.map((entry) => entry.body as {
      workspaceId: string; flagKey: string;
    }));
    expect(bodies).toHaveLength(410);
    expect(new Set(bodies.map((body) => `${body.workspaceId}:${body.flagKey}`)).size).toBe(410);
    expect(globalBatches.every((batch) => batch.length <= 100)).toBe(true);
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
    expect(euSend).not.toHaveBeenCalled();
  });
});
