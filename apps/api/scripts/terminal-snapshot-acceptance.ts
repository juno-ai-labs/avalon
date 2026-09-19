import { terminalSnapshotResourceMismatches } from "../src/services/terminal/snapshot-manifest";

/** What the build needs from Daytona's create response: the fields it asked to be sized. */
export interface BuiltTerminalSnapshot {
  name: string;
  cpu?: number;
  mem?: number;
  disk?: number;
}

/**
 * Accepts a freshly built snapshot, or rejects and deletes it.
 *
 * Accepting the create request is not carrying the size: an under-sized image
 * passes every capability probe the acceptance gate runs and surfaces only as a
 * work stream the kernel killed, so the build has to refuse one. The candidate
 * is registered on the provider by then, and every build takes a name of its own
 * — the weekly job's is minute stamped — so a rejection that merely threw would
 * leave one dead snapshot per attempt under the organization's quota.
 *
 * A delete that fails must not lose the reason the build stopped, so both
 * reasons travel in the message an operator reads, along with the name they have
 * to remove by hand.
 */
export async function acceptBuiltTerminalSnapshot(
  built: BuiltTerminalSnapshot,
  removeRejected: () => Promise<void>,
): Promise<void> {
  const mismatches = terminalSnapshotResourceMismatches(built);
  if (mismatches.length === 0) return;
  const rejection = `Daytona built ${built.name} with resources Rally did not request: ${mismatches.join(", ")}`;
  try {
    await removeRejected();
  } catch (error) {
    throw new Error(
      `${rejection}. Deleting the rejected snapshot failed too, so ${built.name} `
      + `has to be removed by hand: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  throw new Error(rejection);
}
