import { IdSchema } from '@rally/contracts';

/**
 * The id a renderer asked main to open (a Sidekick, a Thread), or `null` for
 * anything else.
 *
 * The id becomes part of a deep link that main then routes, so it is parsed
 * here rather than trusted: only a bare UUID gets through, never a path, a
 * query, or a second segment riding on the end of a valid id.
 */
export function parseRouteId(value: unknown): string | null {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
