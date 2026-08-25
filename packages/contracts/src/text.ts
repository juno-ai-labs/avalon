/**
 * Truncates to at most `maxLength` UTF-16 code units without splitting a
 * surrogate pair at the boundary. `String.prototype.slice` and Zod's
 * `z.string().max()` both count code units, so a plain `.slice(0, N)` can
 * land inside an emoji or other non-BMP character and leave a lone
 * surrogate that renders as U+FFFD.
 *
 * This lives beside the schemas that declare the bounds it enforces, because
 * both the API and `@rally/db` have to apply the same bound to the same
 * column: a value written past a contract's `max()` is a row that fails its own
 * response schema on every subsequent read.
 */
export function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const code = value.charCodeAt(maxLength - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}
