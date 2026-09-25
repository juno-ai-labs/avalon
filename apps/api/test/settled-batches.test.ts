/**
 * The bounded overlap an archive's member walk runs its Channel steps with.
 *
 * Unit-level: the subject is arithmetic over promises. What the walk does
 * with each step is proved against real objects in
 * `test-workers/space-routes.test.ts` and `test-workers/space-member-walk.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { settledBatches } from "../src/lib/settled-batches";

describe("settledBatches", () => {
  it("given a batch size, when steps run, then a batch overlaps and the next starts only after it is read", async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const step = (item: string) => new Promise<string>((resolve) => {
      started.push(item);
      release.set(item, () => resolve(item));
    });

    const batches = settledBatches(["a", "b", "c"], 2, step);
    const first = batches.next();
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]), { timeout: 1_000 });
    release.get("a")?.();
    release.get("b")?.();
    expect((await first).value).toEqual([
      { status: "fulfilled", value: "a" },
      { status: "fulfilled", value: "b" },
    ]);
    expect(started).toEqual(["a", "b"]);

    const second = batches.next();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]), { timeout: 1_000 });
    release.get("c")?.();
    expect((await second).value).toEqual([{ status: "fulfilled", value: "c" }]);
    expect((await batches.next()).done).toBe(true);
  });

  it("given one step that fails, when its sibling is still running, then the batch waits for the sibling", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const step = (item: string) => new Promise<string>((resolve, reject) => {
      if (item === "a") rejectFirst = reject;
      else releaseSecond = () => resolve(item);
    });

    let settled = false;
    const batch = settledBatches(["a", "b"], 2, step).next().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(releaseSecond).toBeDefined(), { timeout: 1_000 });
    rejectFirst?.(new Error("channel_retraction_failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond?.();
    expect((await batch).value).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "channel_retraction_failed" }) },
      { status: "fulfilled", value: "b" },
    ]);
  });
});
