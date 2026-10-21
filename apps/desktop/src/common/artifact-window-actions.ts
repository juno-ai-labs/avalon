import { z } from 'zod';

/** The detached renderer names an operation, never a resource or API path. */
export const ArtifactWindowActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read') }),
  z.strictObject({ type: z.literal('versions') }),
  z.strictObject({ type: z.literal('pin-state') }),
  z.strictObject({ type: z.literal('link') }),
  z.strictObject({ type: z.literal('rename'), title: z.string().trim().min(1).max(300) }),
  z.strictObject({ type: z.literal('pin'), pinned: z.boolean() }),
  z.strictObject({ type: z.literal('archive') }),
  z.strictObject({ type: z.literal('open') }),
  z.strictObject({ type: z.literal('data') }),
  z.strictObject({ type: z.literal('table'), table: z.string().min(1) }),
  z.strictObject({ type: z.literal('site-preview'), version: z.number().int().positive(), pagePath: z.string() }),
  z.strictObject({ type: z.literal('content'), version: z.number().int().positive().optional(), original: z.boolean().optional() }),
]);
export type ArtifactWindowAction = z.infer<typeof ArtifactWindowActionSchema>;
