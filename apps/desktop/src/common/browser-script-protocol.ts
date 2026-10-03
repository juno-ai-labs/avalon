import { z } from 'zod';
import { DesktopActionSchema } from '@rally/contracts/desktop-actions';

export const BrowserTextMatcherSchema = z.union([z.string(), z.strictObject({ source: z.string(), flags: z.string() })]);
export const BrowserLocatorSchema = z.strictObject({
  kind: z.enum(['role', 'text', 'label', 'placeholder', 'testid', 'css']),
  value: z.string(), name: BrowserTextMatcherSchema.optional(), exact: z.boolean().optional(), index: z.number().int().optional(),
});
export type BrowserLocator = z.infer<typeof BrowserLocatorSchema>;
export const BrowserScriptRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('metadata') }),
  z.strictObject({ method: z.literal('action'), action: DesktopActionSchema }),
  z.strictObject({ method: z.literal('ax'), disableDiffing: z.boolean().optional() }),
  z.strictObject({ method: z.literal('navigation'), action: z.enum(['back', 'forward', 'reload']) }),
  z.strictObject({ method: z.literal('target'), target: z.union([z.number().int().nonnegative(), z.tuple([z.number(), z.number()]), z.null()]), operation: z.enum(['click', 'scroll', 'fill', 'type', 'key']), value: z.string().optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), pages: z.number().positive().optional() }),
  z.strictObject({ method: z.literal('locator'), locator: BrowserLocatorSchema, operation: z.enum(['count', 'texts', 'innerText', 'textContent', 'attribute', 'visible', 'enabled', 'click', 'fill', 'type', 'key', 'wait']), value: z.string().optional(), state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(), timeoutMs: z.number().nonnegative().optional() }),
]).superRefine((request, context) => {
  if (request.method !== 'target' && request.method !== 'locator') return;
  if (['fill', 'type', 'key', 'attribute'].includes(request.operation) && request.value === undefined) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'value is required for this operation' });
  }
  if (request.method === 'target' && request.operation === 'scroll' && request.direction === undefined) {
    context.addIssue({ code: 'custom', path: ['direction'], message: 'direction is required for scroll' });
  }
});
export type BrowserScriptRequest = z.infer<typeof BrowserScriptRequestSchema>;
