import { z } from 'zod';
import { HttpUrlSchema } from './url-schemas';

export const AccessRequestInputSchema = z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email()),
  // Cloudflare's documented token maximum, checked 2026-09-09:
  // https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
  turnstileToken: z.string().max(2048).optional() });
export const DownloadGrantExpirySchema = z.iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .refine((value) => Date.parse(value) > Date.now(), 'Choose a future expiry.');
export const DownloadGrantInputSchema = z.strictObject({
  requestId: z.string().uuid().optional(),
  expiresAt: DownloadGrantExpirySchema.optional(),
});
export const DownloadGrantTokenSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const AccessRequestListSchema = z.object({
  requests: z.array(z.object({
    id: z.string(), email: z.string(), createdAt: z.string(),
    acknowledgementStatus: z.enum(['pending', 'sending', 'sent', 'failed', 'rejected', 'review_required', 'skipped', 'suppressed']),
    acknowledgedAt: z.string().nullable(),
    firstAttemptAt: z.string().nullable(), generation: z.number().int(),
  })),
});
export const DownloadGrantResultSchema = z.object({ id: z.string(), url: HttpUrlSchema, expiresAt: z.iso.datetime().nullable() });
export type AccessRequestListItem = z.infer<typeof AccessRequestListSchema>['requests'][number];

// A page is a UI unit, not a cap on the number of people operators may manage.
export const ACCESS_PAGE_SIZE = 50;
export const AccessPageQuerySchema = z.object({
  q: z.string().trim().default(''),
  before: z.string().uuid().optional(),
});
export const AccessRequestPageSchema = AccessRequestListSchema.extend({ nextCursor: z.string().nullable() });
export const DownloadGrantListSchema = z.object({
  grants: z.array(z.object({
    id: z.string(), email: z.string().nullable(), createdAt: z.string(),
    expiresAt: z.string().nullable(), usedAt: z.string().nullable(), revokedAt: z.string().nullable(),
  })), nextCursor: z.string().nullable(),
});
export type DownloadGrantListItem = z.infer<typeof DownloadGrantListSchema>['grants'][number];
export const AccessRecoverySchema = z.strictObject({
  action: z.enum(['retry', 'confirm_sent', 'retry_reconciled', 'suppress']),
  generation: z.number().int().nonnegative(),
  confirmed: z.literal(true),
});
export const AccessRecoveryResultSchema = z.object({ accepted: z.literal(true) });
