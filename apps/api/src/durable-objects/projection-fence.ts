/**
 * The one fence every projection row in a workspace database is written
 * behind.
 *
 * A projection arrives over a Queue, which is at-least-once and unordered, so
 * every table that stores one has to answer the same two questions about the
 * row it lands on: is this newer, and are two different payloads claiming to
 * be the same version. The answer is generation first, then version within a
 * generation — an authority transfer supersedes everything the previous
 * authority said, and inside one authority the source's own waterline orders
 * the writes.
 *
 * It was written out six times before this module, and the copies had already
 * started to differ in the order the two questions were asked. The columns
 * differ per table and the algorithm does not, which is exactly the shape of
 * thing that belongs in one place.
 *
 * Two callers are still not on it: the Space directory and Space viewer
 * projections in `workspace-space-storage.ts` spell the stored version
 * `source_version` rather than `waterline`. That is a rename away and
 * deliberately not part of the change that introduced this — but it is the
 * reason this module does not yet say "every".
 */

/** The fence an incoming projection carries, whatever it is a projection of. */
export interface IncomingProjection {
  generation: number;
  sourceVersion: number;
  payloadHash: string;
}

/**
 * The fence a stored projection row carries.
 *
 * Spelled in the columns' own names rather than the envelope's, because that
 * is how every one of these tables names them and a translation layer here
 * would be one more thing to keep in step.
 */
export interface StoredProjection {
  authority_generation: number;
  waterline: number;
  payload_hash: string;
}

/**
 * Whether this projection supersedes the row it lands on.
 *
 * Throws `conflictCode` when the incoming projection claims a version the
 * stored row already has with different bytes. That is not a race to resolve
 * by last-writer-wins: two payloads at one version means the source's own
 * versioning is broken, or two authorities are publishing under one
 * generation, and silently keeping either one would leave the Organization
 * describing a conversation nobody published. The caller names the code so the
 * failure says which projection was rejected rather than `internal_error`.
 *
 * A missing row always applies: there is nothing to be older than.
 */
export function projectionSupersedes(
  incoming: IncomingProjection,
  current: StoredProjection | undefined,
  conflictCode: string,
): boolean {
  if (!current) return true;
  if (incoming.generation === current.authority_generation
    && incoming.sourceVersion === current.waterline
    && incoming.payloadHash !== current.payload_hash) {
    throw new Error(conflictCode);
  }
  return incoming.generation > current.authority_generation
    || (incoming.generation === current.authority_generation
      && incoming.sourceVersion > current.waterline);
}
