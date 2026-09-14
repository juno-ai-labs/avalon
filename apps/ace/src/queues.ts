import { configuredRegions } from "@rally/contracts/regions";
import { regionalDatabase, regionalFlagQueue } from "./regional-api";
import {
  ProductFeatureFlagFanoutMessageSchema,
  ProductFeatureFlagKeySchema,
} from '@rally/contracts';
import { z } from 'zod';
import type { Env, FlagChangeMessage } from './env';

const FlagChangeMessageSchema = z.object({
  kind: z.literal('flagship_product_flag_changed'),
  flagKey: ProductFeatureFlagKeySchema,
}).strict();

// Queue sendBatch accepts at most 100 messages, checked 2026-08-24:
// https://developers.cloudflare.com/queues/configuration/javascript-apis/#sendbatch
export const QUEUE_SEND_BATCH_MAX_MESSAGES = 100;

async function fanOutRegion(
  db: D1Database,
  queue: Queue,
  flagKeys: readonly FlagChangeMessage['flagKey'][],
): Promise<void> {
  let after = '';
  for (;;) {
    // A closed workspace — retired by an operator, or abandoned by its last
    // member — has nobody connected to receive a flag, and its objects refuse
    // the notification. Left in, every flag save produced one message per
    // closed workspace forever.
    const page = await db.prepare(
      'SELECT id FROM workspaces WHERE id > ? AND abandoned_at IS NULL ORDER BY id LIMIT ?',
    ).bind(after, QUEUE_SEND_BATCH_MAX_MESSAGES).all<{ id: string }>();
    const rows = page.results ?? [];
    const messages = rows.flatMap((row) => flagKeys.map((flagKey) => ({
      body: ProductFeatureFlagFanoutMessageSchema.parse({
          kind: 'product_feature_flag_changed',
          flagKey,
          workspaceId: row.id,
      }),
    })));
    for (let offset = 0; offset < messages.length; offset += QUEUE_SEND_BATCH_MAX_MESSAGES) {
      await queue.sendBatch(messages.slice(offset, offset + QUEUE_SEND_BATCH_MAX_MESSAGES));
    }
    if (rows.length < QUEUE_SEND_BATCH_MAX_MESSAGES) return;
    after = rows.at(-1)!.id;
  }
}

export async function consumeFlagChanges(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const valid: Array<{ message: Message<unknown>; flagKey: FlagChangeMessage['flagKey'] }> = [];
  for (const message of batch.messages) {
    const parsed = FlagChangeMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    valid.push({ message, flagKey: parsed.data.flagKey });
  }
  if (valid.length === 0) return;
  const flagKeys = [...new Set(valid.map((entry) => entry.flagKey))];
  try {
    await Promise.all([
      ...configuredRegions.map((region) => fanOutRegion(regionalDatabase(env, region), regionalFlagQueue(env, region), flagKeys)),
    ]);
    for (const { message } of valid) message.ack();
  } catch {
    for (const { message } of valid) message.retry();
  }
}
