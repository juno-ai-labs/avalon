import { describe, expect, it, vi } from 'vitest';
import { consumeFlagChanges } from '../src/queues';
import { createTestBatch, createTestD1Database, createTestEnv, createTestQueue } from './helpers/cloudflare-test';

function database(ids: string[]): D1Database {
  return createTestD1Database({
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: ids.map((id) => ({ id })) })) })),
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
      messages: [{ body: { kind: 'flagship_product_flag_changed', flagKey: 'hypersight-enabled' }, ack, retry: vi.fn() }],
    }), env);

    expect(globalSend).toHaveBeenCalledWith([{ body: {
      kind: 'product_feature_flag_changed', flagKey: 'hypersight-enabled', workspaceId: '11111111-1111-4111-8111-111111111111',
    } }]);
    expect(euSend).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });
});
