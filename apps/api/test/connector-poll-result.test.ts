import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODE_MAX_LENGTH } from "@rally/contracts/zod-diagnostics";

import { PollResultSchema } from "../src/workflows/connector-poll-result";

/** A degraded stream, shaped as the connector layer returns it. */
function resultWithStreamCode(code: string) {
  return {
    activityIds: [],
    cursor: {},
    baseCursorJson: "{}",
    streamErrors: [{ streamId: "calendar", code, message: "provider content omitted" }],
  };
}

describe("the poll workflow's result contract", () => {
  it("admits a stream code as long as the diagnostics primitive produces", () => {
    // A stream's code is a diagnostic code as often as a connector's own now.
    // The contract capped it at 100 where the primitive stops at 120, so one
    // deep path made the whole poll result fail its own contract, and the
    // step recorded the connection failing for one stream's degradation.
    const longest = `schema_invalid:${"a".repeat(DIAGNOSTIC_CODE_MAX_LENGTH - "schema_invalid:".length)}`;
    expect(longest).toHaveLength(DIAGNOSTIC_CODE_MAX_LENGTH);
    expect(PollResultSchema.safeParse(resultWithStreamCode(longest)).success).toBe(true);
    expect(PollResultSchema.safeParse(resultWithStreamCode(`${longest}a`)).success).toBe(false);
  });
});
