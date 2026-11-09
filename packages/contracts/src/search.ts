import { HttpUrlSchema } from './url-schemas';
import { z } from 'zod';

export const SearchCategorySchema = z.enum(['all', 'messages', 'links', 'artifacts', 'files']);
export type SearchCategory = z.infer<typeof SearchCategorySchema>;
export const SearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1),
  // Accepted and ignored: desktop builds before 1.305 still send it. The
  // response carries no completeness flag; an undecided candidate is omitted.
  supportsPartialResults: z.literal(true).optional(),
  category: SearchCategorySchema,
  pageSize: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
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
    // `parentKind` names what `workstreamId` is: a Canvas (its Chat is
    // substream `0`) or a Sidekick (`automation`: its shared conversation is
    // `0`, a run's is the run's id).
    z.strictObject({ kind: z.literal('message'), parentKind: z.enum(['canvas', 'automation']), workstreamId: z.string().uuid(), substreamId: z.string(), turnId: z.string(), transcriptSequence: z.number().int().positive(), range: TextRangeSchema }),
    z.strictObject({ kind: z.literal('resource'), resourceId: z.string().uuid(), mimeType: z.string().nullable(), range: TextRangeSchema }),
  ]),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
export const SearchResponseSchema = z.strictObject({
  results: z.array(SearchResultSchema),
  nextCursor: z.string().nullable().optional(),
  timings: z.strictObject({ scopeMs: z.number().nonnegative(), retrievalMs: z.number().nonnegative(),
    hydrationMs: z.number().nonnegative(), serverMs: z.number().nonnegative() }).optional(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;
