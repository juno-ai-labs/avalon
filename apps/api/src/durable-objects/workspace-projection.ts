/**
 * The primitives every WorkspaceDO projection shares.
 *
 * Regional effects, connector events, and directory rows are all ordered by the
 * same (generation, version) coordinate, and all arrive as ISO
 * strings over RPC, are stored as epoch milliseconds so SQLite can order and
 * range-scan them, and are answered as ISO strings again. One pair here rather
 * than one per domain, because a projection that parses a timestamp differently
 * from the one beside it is a bug nobody sees until two rows disagree.
 */

/**
 * Epoch milliseconds for an inbound ISO timestamp, or null for an absent one.
 *
 * Throws rather than coercing: an unparseable timestamp on a projection means
 * the sender is wrong, and storing `NaN` or 0 would bury that under a row that
 * sorts to the beginning of time.
 */
export function epoch(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("workspace_directory_timestamp_invalid");
  return parsed;
}

/** The stored epoch as the contract's ISO string, preserving absence. */
export function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Order two projection coordinates: newer generation wins outright, and within
 * one generation the higher source version does.
 */
export function compareProjectionCoordinate(
  generation: number,
  version: number,
  existingGeneration: number,
  existingVersion: number,
): number {
  return generation === existingGeneration
    ? Math.sign(version - existingVersion)
    : Math.sign(generation - existingGeneration);
}
