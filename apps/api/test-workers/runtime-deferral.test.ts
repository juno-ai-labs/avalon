/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { runtimeDeferral } from "../src/lib/defer";

describe("runtime work deferral", () => {
  it("accepts and observes background work in real workerd", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let backgroundSettled = false;
    expect(() => {
      runtimeDeferral(gate.then(() => { backgroundSettled = true; }));
    }).not.toThrow();
    expect(backgroundSettled).toBe(false);

    release();
    await gate;
    await Promise.resolve();
    expect(backgroundSettled).toBe(true);
  });
});
