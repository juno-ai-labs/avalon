import { describe, expect, it, vi } from "vitest";
import { runtimeDeferral } from "../src/lib/defer";
import { failNextWaitUntil } from "./helpers/cloudflare-workers";

describe("runtime work deferral", () => {
  it("does not let an unavailable lifecycle turn background failure into a caller failure", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    failNextWaitUntil(new Error("no active Workers invocation"));

    expect(() => runtimeDeferral(Promise.reject(new Error("background failed"))))
      .not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
});
