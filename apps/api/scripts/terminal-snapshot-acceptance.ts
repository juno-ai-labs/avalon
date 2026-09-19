import type { Daytona } from "@daytona/sdk";

import { TERMINAL_SNAPSHOT_RESOURCES } from "../src/services/terminal/snapshot-manifest";

/**
 * Daytona's own record of a built snapshot, as `snapshot.create` resolves it.
 *
 * Derived from the SDK rather than hand-written so the field names stay bound to
 * the provider's shape: it reports memory as `mem` while the create request
 * takes `memory`, and a hand-written `{ mem?: number }` would read `undefined`
 * off a renamed field instead of failing to compile. The type is erased, so this
 * costs the Worker bundle nothing.
 */
export type BuiltTerminalSnapshot = Pick<
  Awaited<ReturnType<Daytona["snapshot"]["create"]>>,
  "name" | "cpu" | "mem" | "disk"
>;

/** Names each resource field the built snapshot did not come back with. */
function resourceMismatches(built: BuiltTerminalSnapshot): string[] {
  const fields: [string, number, number][] = [
    ["cpu", TERMINAL_SNAPSHOT_RESOURCES.cpu, built.cpu],
    ["memory", TERMINAL_SNAPSHOT_RESOURCES.memory, built.mem],
    ["disk", TERMINAL_SNAPSHOT_RESOURCES.disk, built.disk],
  ];
  return fields
    .filter(([, requested, reported]) => reported !== requested)
    .map(([field, requested, reported]) => `${field} (requested ${requested}, built ${reported})`);
}

/**
 * Accepts a freshly built snapshot, or rejects and deletes it.
 *
 * Accepting the create request is not carrying the size: an under-sized image
 * passes every capability probe the acceptance gate runs and surfaces only as a
 * work stream the kernel killed, so the build has to refuse one. `snapshot.create`
 * polls until the snapshot reaches a terminal state, so what it resolves is the
 * built image's own record rather than the accepted request.
 *
 * The candidate is registered on the provider by then, and every build takes a
 * name of its own — the weekly job's is minute stamped — so a rejection that
 * merely threw would leave one dead snapshot per attempt under the
 * organization's quota. A delete that fails must not lose the reason the build
 * stopped, so both reasons travel in the message an operator reads, along with
 * the name they have to remove by hand.
 */
export async function acceptBuiltTerminalSnapshot(
  built: BuiltTerminalSnapshot,
  removeRejected: () => Promise<void>,
): Promise<void> {
  const mismatches = resourceMismatches(built);
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
