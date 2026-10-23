/**
 * The engine's bound-parameter ceiling, and how a fan-in read stays under it.
 *
 * Durable Object SQLite is the same engine D1 runs, with the same per-statement
 * limits — 100 KB of statement text, 100 columns, and **100 bound parameters**
 * — recorded in
 * [the per-workspace-databases research](../../../../docs/PRDs/2026-08-12_per-workspace-databases/research.md).
 * A read that expands a caller's id list into `IN (?, ?, …)` therefore has a
 * size past which the statement is refused outright, and the failure is the
 * whole read rather than a truncated one.
 * A statement that must stay whole, such as a recursive CTE, can instead bind
 * the list as one JSON array and expand it through `json_each(?)`.
 *
 * That is a real ceiling rather than a defensive choice, which is why this
 * constant is not the team's to set: the only decision here is the margin
 * beneath it, and that follows from the statement, not from a policy.
 */

/**
 * Ids expanded into one `IN` list.
 *
 * Bounds: bound parameters in a single fan-in statement, less whatever else
 *   that statement binds.
 * Without it: a work stream with more attachments than this — or a transcript
 *   page wider than it — builds a statement the engine refuses, and the
 *   member's rail or transcript fails to load at all rather than loading
 *   slowly.
 * Direction: upper bound, and one imposed by the engine rather than chosen.
 * Trips: nothing. The caller loops and concatenates; no row is dropped and no
 *   caller sees a partial answer.
 * Derive from: the engine's 100-parameter limit, less room for the handful of
 *   scalars a statement binds beside its id list. 90 is what
 *   `workstream-object-product.ts` already used for exactly this, and matching
 *   it is worth more than shaving the margin.
 */
export const BOUND_PARAMETER_ID_CHUNK = 90;

/** Split an id list into runs that fit one statement. */
export function boundParameterChunks<T>(
  values: readonly T[],
  size = BOUND_PARAMETER_ID_CHUNK,
): T[][] {
  const chunked: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunked.push(values.slice(offset, offset + size));
  }
  return chunked;
}
