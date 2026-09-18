import { describe, expect, it, vi } from "vitest";
import { Preparation, ToolSurfacePreparations } from "../src/services/harness-preparation";
import { sha256 } from "../src/lib/crypto";

describe("independent harness preparations", () => {
  it("shares in-flight and completed work without blocking unrelated preparation", async () => {
    let finish!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const slow = new Preparation(load);
    const fast = new Preparation(async () => "ready");
    const first = slow.get();
    expect(slow.get()).toBe(first);
    expect(await fast.get()).toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
    finish("complete");
    expect(await first).toBe("complete");
    expect(slow.get()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("observes speculative rejection and lets later demand retry", async () => {
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce("ready");
    const preparation = new Preparation(load);
    const failed = preparation.get();
    // Yield without attaching a consumer: proactive work must observe its own failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(failed).rejects.toThrow("temporarily unavailable");
    expect(await preparation.get()).toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("measures only the loader attempt and retains the settled measurement", async () => {
    let finish!: (value: string) => void;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(100).mockReturnValueOnce(137);
    const preparation = new Preparation(() => new Promise<string>((resolve) => { finish = resolve; }));

    const pending = preparation.get();
    expect(preparation.elapsedMs).toBeNull();
    await Promise.resolve();
    expect(preparation.elapsedMs).toBeNull();
    finish("ready");
    await expect(pending).resolves.toBe("ready");
    expect(preparation.elapsedMs).toBe(37);
    expect(preparation.get()).toBe(pending);
    expect(preparation.elapsedMs).toBe(37);
    now.mockRestore();
  });

  it("replaces a changed tool surface without an older result overwriting it", async () => {
    const surfaces = new ToolSurfacePreparations();
    const old = surfaces.get("builtin", "old schema");
    expect(surfaces.get("builtin", "old schema")).toBe(old);
    const current = surfaces.get("builtin", "new schema");
    expect(current).not.toBe(old);
    expect(await old).toBe(await sha256("old schema"));
    expect(await current).toBe(await sha256("new schema"));
    expect(surfaces.get("builtin", "new schema")).toBe(current);
    expect(surfaces.get("another builtin", "new schema")).not.toBe(current);
  });
});
