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

/** Compares each requested field against what the built snapshot reports. */
function resourceDeltas(built: BuiltTerminalSnapshot): { short: string[]; surplus: string[] } {
  const fields: [string, number, number][] = [
    ["cpu", TERMINAL_SNAPSHOT_RESOURCES.cpu, built.cpu],
    ["memory", TERMINAL_SNAPSHOT_RESOURCES.memory, built.mem],
    ["disk", TERMINAL_SNAPSHOT_RESOURCES.disk, built.disk],
  ];
  const describe = ([field, requested, reported]: [string, number, number]): string =>
    `${field} (requested ${requested}, built ${reported})`;
  return {
    short: fields.filter(([, requested, reported]) => reported < requested).map(describe),
    surplus: fields.filter(([, requested, reported]) => reported > requested).map(describe),
  };
}

/**
 * Accepts a freshly built snapshot, or rejects and deletes one built too small.
 *
 * Accepting the create request is not carrying the size: an under-sized image
 * passes every capability probe the acceptance gate runs and surfaces only as a
 * work stream the kernel killed, so the build has to refuse one. `snapshot.create`
 * polls until the snapshot reaches a terminal state, so what it resolves is the
 * built image's own record rather than the accepted request.
 *
 * Only a shortfall fails. A provider that rounds a field *up* — a runner minimum,
 * a normalized core count — has given Rally what it asked for and more, and
 * failing on that would take the weekly rebuild red with no adoption pull request
 * and no override, over an image that works. The surplus is returned instead, for
 * the build to print, because it is a cost nobody chose and the build log is
 * where it gets noticed.
 *
 * A rejected candidate is registered on the provider by then, and every build
 * takes a name of its own — the weekly job's is minute stamped — so a rejection
 * that merely threw would leave one dead snapshot per attempt under the
 * organization's quota. A delete that fails must not lose the reason the build
 * stopped, so both reasons travel in the message an operator reads, along with
 * the name they have to remove by hand.
 *
 * @returns the fields the provider gave more of than was requested, if any.
 */
export async function acceptBuiltTerminalSnapshot(
  built: BuiltTerminalSnapshot,
  removeRejected: () => Promise<void>,
): Promise<string[]> {
  const { short, surplus } = resourceDeltas(built);
  if (short.length === 0) return surplus;
  const rejection = `Daytona built ${built.name} smaller than Rally requested: ${short.join(", ")}`;
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
