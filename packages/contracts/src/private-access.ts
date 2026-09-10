import { z } from 'zod';
import { HttpUrlSchema } from './url-schemas';

export const AccessRequestInputSchema = z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email()) });
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
    acknowledgementStatus: z.enum(['pending', 'sending', 'sent', 'failed', 'rejected', 'review_required', 'skipped']),
    acknowledgedAt: z.string().nullable(),
  })),
});
export const DownloadGrantResultSchema = z.object({ id: z.string(), url: HttpUrlSchema, expiresAt: z.iso.datetime().nullable() });
export type AccessRequestListItem = z.infer<typeof AccessRequestListSchema>['requests'][number];
