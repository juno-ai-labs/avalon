import { HttpUrlSchema } from './url-schemas';
import { z } from 'zod';

export const SearchCategorySchema = z.enum(['all', 'messages', 'links', 'artifacts', 'files']);
export type SearchCategory = z.infer<typeof SearchCategorySchema>;
export const SearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1),
  category: SearchCategorySchema,
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
const TextRangeSchema = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
export const SearchResultSchema = z.strictObject({
  id: z.string(),
  category: z.enum(['messages', 'links', 'artifacts', 'files']),
  title: z.string(),
  sourceLabel: z.string(),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
  excerpt: z.string(),
  excerptStart: z.number().int().nonnegative(),
  highlights: z.array(TextRangeSchema),
  revision: z.string(),
  location: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('link'), url: HttpUrlSchema, range: TextRangeSchema }),
    z.strictObject({ kind: z.literal('message'), workstreamId: z.string().uuid(), substreamId: z.string(), turnId: z.string(), transcriptSequence: z.number().int().positive(), range: TextRangeSchema }),
    z.strictObject({ kind: z.literal('resource'), resourceId: z.string().uuid(), mimeType: z.string().nullable(), range: TextRangeSchema }),
  ]),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
export const SearchResponseSchema = z.strictObject({ results: z.array(SearchResultSchema) });

export type SearchResponse = z.infer<typeof SearchResponseSchema>;
