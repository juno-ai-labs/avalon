import {
  ProductFeatureFlagFanoutMessageSchema,
  ProductFeatureFlagKeySchema,
} from '@avalon/contracts';
import { z } from 'zod';
import type { Env, FlagChangeMessage } from './env';

const FlagChangeMessageSchema = z.object({
  kind: z.literal('flagship_product_flag_changed'),
  flagKey: ProductFeatureFlagKeySchema,
}).strict();

async function fanOutRegion(
  db: D1Database,
  queue: Queue,
  flagKey: FlagChangeMessage['flagKey'],
): Promise<void> {
  let after = '';
  for (;;) {
    const page = await db.prepare(
      'SELECT id FROM workspaces WHERE id > ? ORDER BY id LIMIT 500',
    ).bind(after).all<{ id: string }>();
    const rows = page.results ?? [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      await queue.sendBatch(rows.slice(offset, offset + 100).map((row) => ({
        body: ProductFeatureFlagFanoutMessageSchema.parse({
          kind: 'product_feature_flag_changed',
          flagKey,
          workspaceId: row.id,
        }),
      })));
    }
    if (rows.length < 500) return;
    after = rows.at(-1)!.id;
  }
}

export async function consumeFlagChanges(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = FlagChangeMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      return;
    }
    try {
      await Promise.all([
        fanOutRegion(env.GLOBAL_DB, env.GLOBAL_PRODUCT_FLAG_QUEUE, parsed.data.flagKey),
        fanOutRegion(env.EU_DB, env.EU_PRODUCT_FLAG_QUEUE, parsed.data.flagKey),
      ]);
      message.ack();
    } catch {
      message.retry();
    }
  }));
}
