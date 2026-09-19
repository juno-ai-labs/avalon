import { describe, expect, it, vi } from "vitest";

import { acceptBuiltTerminalSnapshot } from "../scripts/terminal-snapshot-acceptance";
import { TERMINAL_SNAPSHOT_RESOURCES } from "../src/services/terminal/snapshot-manifest";

const { cpu, memory, disk } = TERMINAL_SNAPSHOT_RESOURCES;

describe("Terminal snapshot acceptance", () => {
  it("keeps a snapshot built at the requested size", async () => {
    const removeRejected = vi.fn(async () => undefined);

    await expect(acceptBuiltTerminalSnapshot(
      { name: "rally-terminal-candidate", cpu, mem: memory, disk },
      removeRejected,
    )).resolves.toBeUndefined();

    expect(removeRejected).not.toHaveBeenCalled();
  });

  it("deletes an under-sized snapshot before failing the build", async () => {
    const events: string[] = [];
    const removeRejected = vi.fn(async () => { events.push("deleted"); });

    // Daytona's default when a build requests nothing, which is the shape a
    // dropped `resources` would silently hand back.
    await expect(acceptBuiltTerminalSnapshot(
      { name: "rally-terminal-candidate", cpu: 1, mem: 1, disk: 3 },
      removeRejected,
    )).rejects.toThrow(/rally-terminal-candidate with resources Rally did not request: cpu .*, memory .*, disk /u);

    // Deleted, and deleted before the throw: a rejection that threw first would
    // leave the candidate registered on the provider.
    expect(events).toEqual(["deleted"]);
  });

  it("names the snapshot to remove by hand when the cleanup fails too", async () => {
    const removeRejected = vi.fn(async () => { throw new Error("snapshot is in use"); });

    await expect(acceptBuiltTerminalSnapshot(
      { name: "rally-terminal-candidate", cpu, mem: 1, disk },
      removeRejected,
    )).rejects.toThrow(
      /memory \(requested \d+, built 1\)\. Deleting the rejected snapshot failed too, so rally-terminal-candidate has to be removed by hand: snapshot is in use/u,
    );
  });
});
