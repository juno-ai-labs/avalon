import { z } from 'zod';
import { IdSchema, SubstreamIdSchema } from './identifiers';
import { deferredZodSchema } from "./deferred-zod-schema";

export const MessageIssueTargetSchema = deferredZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), parentId: IdSchema, substreamId: SubstreamIdSchema }),
  z.strictObject({ kind: z.literal('channel'), channelId: IdSchema }),
]));
export type MessageIssueTarget = z.infer<typeof MessageIssueTargetSchema>;

export const CreateMessageIssueSchema = deferredZodSchema(() => z.strictObject({
  id: IdSchema,
  target: MessageIssueTargetSchema,
  messageId: z.string().min(1),
  blockId: z.string().min(1).optional(),
  description: z.string().trim().min(1),
}));
export type CreateMessageIssue = z.infer<typeof CreateMessageIssueSchema>;

export const MessageIssueReceiptSchema = deferredZodSchema(() => z.strictObject({ id: IdSchema, createdAt: z.string() }));
export type MessageIssueReceipt = z.infer<typeof MessageIssueReceiptSchema>;
