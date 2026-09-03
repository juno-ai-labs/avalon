import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SeedProductBodySchema } from "../src/routes/dev";

describe("the checked-in product seed", () => {
  it("matches the strict route and AutomationAgent import boundary", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../../../packages/db/seed-product.json", import.meta.url),
      "utf8",
    )) as Record<string, unknown>;
    // The local-authority script removes the human-readable top-level note
    // before posting this exact payload to the route.
    delete fixture["comment"];

    expect(() => SeedProductBodySchema.parse(fixture)).not.toThrow();
  });
});
