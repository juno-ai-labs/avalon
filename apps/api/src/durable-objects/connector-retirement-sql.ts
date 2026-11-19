/**
 * SQL fragments a connector's retirement migration filters stored JSON with.
 *
 * A retired connector is named inside JSON arrays — a Sidekick's evaluator
 * projection, its revisions' triggers, rules and recommended plugins — so a
 * purge rewrites each array without the entries that name it. Shared rather
 * than copied, because every retirement needs the same two, and a copy that
 * drifts is a migration that leaves a half-purged array behind. The output of
 * each is part of a shipped migration's statements: change one only in a way
 * that leaves the text it produces for an existing call identical.
 */

/** An array column without the entries `keep` rejects, or the column unchanged when none match. */
export function filteredArray(column: string, path: string, keep: string): string {
  // `json()` re-parses an object or array entry; a string or number is
  // already its own value, and passing it to `json()` would fail as malformed.
  return `json_set(${column}, '${path}', (SELECT json_group_array(
      CASE WHEN entry.type IN ('object', 'array') THEN json(entry.value) ELSE entry.value END)
    FROM json_each(${column}, '${path}') AS entry WHERE ${keep}))`;
}

/** True when the array at `path` holds an entry `keep` rejects. */
export function holdsRejected(column: string, path: string, keep: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}, '${path}') AS entry WHERE NOT (${keep}))`;
}
