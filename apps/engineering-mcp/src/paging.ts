import { z } from "zod";

/** Rows per page when the caller sets no limit; docs/engineering-mcp.md says why. */
export const DEFAULT_PAGE_SIZE = 200;

export type Page<T> = {
  items: T[];
  page: number;
  pageCount: number;
  /** Matches across every page, not just this one. */
  total: number;
  /** The `page` to ask for next; null on the last page. */
  nextPage: number | null;
};

export type PageRequest<Key extends string> = {
  orderBy?: Key | undefined;
  direction?: "asc" | "desc" | undefined;
  limit?: number | undefined;
  page?: number | undefined;
};

/**
 * How one kind of row is ordered. Text keys sort A to Z by default and compare
 * ignoring case; every other key sorts newest or largest first, and a null
 * value sorts last in either direction.
 */
export type Ordering<Row, Key extends string> = {
  keys: readonly [Key, ...Key[]];
  defaultKey: Key;
  textKeys: readonly Key[];
  value(row: Row, key: Key): string | number | null;
  /** Stable tiebreak, so a page boundary never depends on sort stability. */
  id(row: Row): string;
};

/** Page numbers rather than a cursor; docs/engineering-mcp.md says why. */
export function pageInputSchema<Key extends string>(ordering: Ordering<unknown, Key>) {
  return {
    orderBy: z.enum(ordering.keys).optional().describe(
      `Sort key; ${ordering.defaultKey} by default. Rows with no value sort last in either direction.`,
    ),
    direction: z.enum(["asc", "desc"]).optional().describe(
      `asc by default for ${ordering.textKeys.join(" and ")}, desc (newest or largest first) for every other key.`,
    ),
    limit: z.number().int().positive().optional().describe(`Rows per page; ${DEFAULT_PAGE_SIZE} by default.`),
    page: z.number().int().positive().optional().describe(
      "Page number, from 1 (the default). For the next page, repeat every other argument unchanged and pass nextPage.",
    ),
  };
}

/** Order the whole merged set once, then return one page of it. */
export function orderAndPage<Row, Key extends string>(
  rows: Row[],
  ordering: Ordering<Row, Key>,
  request: PageRequest<Key>,
): Page<Row> {
  const orderBy = request.orderBy ?? ordering.defaultKey;
  const text = ordering.textKeys.includes(orderBy);
  const sign = (request.direction ?? (text ? "asc" : "desc")) === "asc" ? 1 : -1;
  const limit = request.limit ?? DEFAULT_PAGE_SIZE;
  const page = request.page ?? 1;
  const sorted = [...rows].sort((left, right) => {
    const a = ordering.value(left, orderBy);
    const b = ordering.value(right, orderBy);
    if ((a === null) !== (b === null)) return a === null ? 1 : -1;
    // Non-text values are numbers or uniform UTC ISO strings, so plain comparison orders them.
    const order = text
      ? String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
      : a! < b! ? -1 : a! > b! ? 1 : 0;
    return sign * order || ordering.id(left).localeCompare(ordering.id(right));
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / limit));
  return {
    items: sorted.slice((page - 1) * limit, page * limit),
    page,
    pageCount,
    total: sorted.length,
    nextPage: page < pageCount ? page + 1 : null,
  };
}
