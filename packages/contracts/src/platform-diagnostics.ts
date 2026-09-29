/**
 * Naming a failure the Workers runtime, D1, or SQLite raised, without copying
 * its sentence.
 *
 * These failures arrive as prose, so a reporter that admits only code-shaped
 * messages reduces every one of them to its own fallback: a D1 outage, a
 * dropped connection and a constraint violation all read as `internal_error`
 * or `connector_poll_failed`. Each pattern below maps a fixed platform sentence
 * to a word of ours, so the sentence itself, and anything interpolated into
 * it, never reaches a log field. That matters for SQLite: its constraint and
 * "no such column" messages name the column, and a member's memory table
 * names its own columns.
 *
 * Order matters: the D1 storage timeout is matched before the Durable Object
 * one, whose sentence it contains.
 */
const PLATFORM_ERRORS: readonly (readonly [RegExp, string])[] = [
  [/^Durable Object reset because its code was updated/u, "durable_object_code_updated"],
  [/D1 DB reset because its code was updated/u, "d1_code_updated"],
  [/D1 DB storage operation exceeded timeout/u, "d1_storage_timeout"],
  [/exceeded timeout which caused object to be reset/u, "durable_object_storage_timeout"],
  [/this Durable Object instance is no longer active/u, "durable_object_inactive"],
  [/(?:^|: )Network connection lost/u, "network_connection_lost"],
  [/code had hung and would never generate a response/u, "worker_hung"],
  [/D1 DB is overloaded/u, "d1_overloaded"],
  [/D1 DB's isolate exceeded its memory limit/u, "d1_memory_limit_reset"],
  [/D1 DB exceeded its CPU time limit/u, "d1_cpu_limit_reset"],
  [/Internal error while starting up D1 DB storage/u, "d1_storage_startup_reset"],
  [/Cannot resolve D1 DB due to transient issue/u, "d1_transient_resolve_failure"],
  [/Can't read from request stream because client disconnected/u, "client_disconnected"],
  [/UNIQUE constraint failed/u, "sqlite_unique_constraint"],
  [/NOT NULL constraint failed/u, "sqlite_not_null_constraint"],
  [/CHECK constraint failed/u, "sqlite_check_constraint"],
  [/FOREIGN KEY constraint failed/u, "sqlite_foreign_key_constraint"],
  [/no such table/u, "sqlite_no_such_table"],
  [/no such column/u, "sqlite_no_such_column"],
  [/too many SQL variables/u, "sqlite_too_many_variables"],
  [/string or blob too big|SQLITE_TOOBIG/u, "sqlite_too_big"],
  [/database is locked|SQLITE_BUSY/u, "sqlite_busy"],
  [/: syntax error/u, "sqlite_syntax_error"],
];

/** D1's own prefix (`D1_ERROR`, `D1_TYPE_ERROR`, …): a closed platform vocabulary. */
const D1_PREFIX = /^(D1_[A-Z_]{1,40}):/u;

function messageOf(value: unknown): string | null {
  return value instanceof Error ? value.message : null;
}

/**
 * A word of ours for a runtime, D1 or SQLite failure, or null for anything
 * else so the caller keeps its own vocabulary.
 *
 * D1 wraps the underlying failure in `cause` on newer runtimes, so both the
 * error and its cause are read. The runtime's `overloaded` flag names an
 * overload whose sentence the table does not know. `retryable` is not read:
 * this tree's own provider errors carry a property of that name.
 */
export function platformErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const messages = [error.message, messageOf((error as Error & { cause?: unknown }).cause)]
    .filter((message): message is string => message !== null);
  for (const message of messages) {
    for (const [pattern, code] of PLATFORM_ERRORS) if (pattern.test(message)) return code;
  }
  if ((error as Error & { overloaded?: unknown }).overloaded === true) return "durable_object_overloaded";
  for (const message of messages) {
    const prefix = D1_PREFIX.exec(message)?.[1];
    if (prefix) return prefix.toLowerCase();
  }
  return null;
}
