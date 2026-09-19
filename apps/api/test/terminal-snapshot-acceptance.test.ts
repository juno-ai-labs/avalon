import { describe, expect, it, vi } from "vitest";

import { acceptBuiltTerminalSnapshot } from "../scripts/terminal-snapshot-acceptance";
import { TERMINAL_SNAPSHOT_RESOURCES } from "../src/services/terminal/snapshot-manifest";

const { cpu, memory, disk } = TERMINAL_SNAPSHOT_RESOURCES;
const candidate = { name: "rally-terminal-candidate" };

describe("Terminal snapshot acceptance", () => {
  it("keeps a snapshot built at the requested size", async () => {
    const removeRejected = vi.fn(async () => undefined);

    await expect(acceptBuiltTerminalSnapshot(
      { ...candidate, cpu, mem: memory, disk },
      removeRejected,
    )).resolves.toEqual([]);

    expect(removeRejected).not.toHaveBeenCalled();
  });

  it("names every field a snapshot built at Daytona's default falls short on", async () => {
    // 1 vCPU / 1 GiB / 3 GiB is what a build that passes no `resources` comes
    // back with, so it is the shape a dropped request would hand over.
    await expect(acceptBuiltTerminalSnapshot(
      { ...candidate, cpu: 1, mem: 1, disk: 3 },
      async () => undefined,
    )).rejects.toThrow(
      "Daytona built rally-terminal-candidate smaller than Rally requested: "
      + `cpu (requested ${cpu}, built 1), memory (requested ${memory}, built 1), disk (requested ${disk}, built 3)`,
    );
  });

  it("keeps a snapshot the provider rounded up, and reports what it rounded", async () => {
    // A runner minimum or a normalized core count is Rally's size and more. The
    // build says so rather than going red over an image that works.
    const removeRejected = vi.fn(async () => undefined);

    await expect(acceptBuiltTerminalSnapshot(
      { ...candidate, cpu, mem: memory, disk: disk + 2 },
      removeRejected,
    )).resolves.toEqual([`disk (requested ${disk}, built ${disk + 2})`]);

    expect(removeRejected).not.toHaveBeenCalled();
  });

  it("deletes an under-sized snapshot before failing the build", async () => {
    const events: string[] = [];
    const removeRejected = vi.fn(async () => { events.push("deleted"); });

    await expect(acceptBuiltTerminalSnapshot(
      { ...candidate, cpu, mem: 1, disk },
      removeRejected,
    )).rejects.toThrow(/smaller than Rally requested: memory/u);

    // Deleted, and deleted before the throw: a rejection that threw first would
    // leave the candidate registered on the provider.
    expect(events).toEqual(["deleted"]);
  });

  it("names the snapshot to remove by hand when the cleanup fails too", async () => {
    const removeRejected = vi.fn(async () => { throw new Error("snapshot is in use"); });

    await expect(acceptBuiltTerminalSnapshot(
      { ...candidate, cpu, mem: 1, disk },
      removeRejected,
    )).rejects.toThrow(
      /memory \(requested \d+, built 1\)\. Deleting the rejected snapshot failed too, so rally-terminal-candidate has to be removed by hand: snapshot is in use/u,
    );
  });
});
