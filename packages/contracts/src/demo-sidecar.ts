import { z } from 'zod';
import { IdSchema, MESSAGE_MAX_CHARACTERS, SubstreamIdSchema } from './index';

export const DemoMessageRequestSchema = z.strictObject({
  representedUserId: IdSchema,
  workstreamId: IdSchema,
  substreamId: SubstreamIdSchema,
  clientMessageId: z.string().uuid(),
  text: z.string().min(1).max(MESSAGE_MAX_CHARACTERS).refine(value => value.trim().length > 0, 'Message cannot be empty'),
});
export type DemoMessageRequest = z.infer<typeof DemoMessageRequestSchema>;
export const DemoMessageResultSchema = z.strictObject({ turnId: IdSchema });
export const DemoCatalogSchema = z.strictObject({
  workspaceId: IdSchema,
  workspaceName: z.string(),
  operatorName: z.string(),
  participants: z.array(z.strictObject({
    userId: IdSchema, name: z.string(),
    destinations: z.array(z.strictObject({ workstreamId: IdSchema, substreamId: SubstreamIdSchema, label: z.string() })),
  })),
});
export type DemoCatalog = z.infer<typeof DemoCatalogSchema>;
