import type { ConnectorToolResult } from "./types";
import { z } from "zod";

/** Only authored adapters call this with their known response field and request shape. */
export function paginatedResult(
  operation: string,
  input: Record<string, unknown>,
  result: ConnectorToolResult,
  cursorParameter: string,
  cursor: string | null,
): ConnectorToolResult {
  return {
    ...result,
    pagination: { continuations: cursor === null ? [] : [{
      operation, input: { ...input, [cursorParameter]: cursor }, slot: "nextPageId",
    }] },
  };
}

/** Provider-specific projections: field ownership is explicit at the adapter call site. */
export function linearPage(operation: string, input: Record<string, unknown>, output: unknown, summary: string, project: (value: Record<string, unknown>) => unknown): ConnectorToolResult {
  const page = z.looseObject({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }) }).parse(output);
  const { pageInfo, ...data } = page;
  if (pageInfo.hasNextPage && !pageInfo.endCursor) throw new Error("pagination_response_missing_endCursor");
  return paginatedResult(operation, input, { output: project({ ...data, hasMore: pageInfo.hasNextPage }), summary }, "after", pageInfo.hasNextPage ? pageInfo.endCursor ?? null : null);
}

export function notionPage(operation: string, input: Record<string, unknown>, output: unknown, summary: string, project: (value: Record<string, unknown>) => unknown): ConnectorToolResult {
  const { next_cursor, has_more, ...data } = z.looseObject({ next_cursor: z.string().nullable(), has_more: z.boolean() }).parse(output);
  if (has_more && !next_cursor) throw new Error("pagination_response_missing_next_cursor");
  return paginatedResult(operation, input, { output: project({ ...data, hasMore: has_more }), summary }, "startCursor", has_more ? next_cursor : null);
}

export function granolaPage(operation: string, input: Record<string, unknown>, output: unknown, summary: string, project: (value: Record<string, unknown>) => unknown): ConnectorToolResult {
  const { cursor, hasMore, ...data } = z.looseObject({ cursor: z.string().nullish(), hasMore: z.boolean() }).parse(output);
  if (hasMore && !cursor) throw new Error("pagination_response_missing_cursor");
  return paginatedResult(operation, input, { output: project({ ...data, hasMore }), summary }, "cursor", hasMore ? cursor ?? null : null);
}

export function nextCursorPage(operation: string, input: Record<string, unknown>, output: unknown, summary: string, project: (value: Record<string, unknown>) => unknown = (value) => value): ConnectorToolResult {
  const { next_cursor, ...data } = z.looseObject({ next_cursor: z.string().nullish() }).parse(output);
  return paginatedResult(operation, input, { output: project(data), summary }, "cursor", next_cursor || null);
}
