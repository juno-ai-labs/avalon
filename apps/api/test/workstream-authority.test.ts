import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../src/services/workstream-authority";
import { createTestD1Database, createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";

// A D1 overload cannot be produced locally; the double throws D1's own sentence.
function failingDatabase(message: string): D1Database {
  return createTestD1Database({
    prepare: () => createTestD1PreparedStatement({ first: () => Promise.reject(new Error(message)) }),
  });
}

describe("readWorkstreamAuthorityControl", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails closed as unreadable, not quarantined, and logs why D1 failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv({
      DB: failingDatabase("D1_ERROR: D1 DB is overloaded. Too many requests queued."),
      AVALON_REGION: "us",
      LOG_LEVEL: "info",
    });

    const control = await readWorkstreamAuthorityControl(env);

    expect(control.phase).toBe("unreadable");
    expect(acceptsNewWorkstreamWork(control)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_authority_unreadable",
      code: "workstream_authority_read_failed:d1_overloaded",
    }));
  });
});
