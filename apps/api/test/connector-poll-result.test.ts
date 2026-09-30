import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODE_MAX_LENGTH } from "@rally/contracts/zod-diagnostics";

import { ConnectorError } from "@rally/connectors";

import {
  failedPollAttemptCode,
  pollAttemptErrorCode,
  pollAttemptFailure,
  PollResultSchema,
} from "../src/workflows/connector-poll-result";

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

describe("a failed poll attempt's code", () => {
  it("names the provider's status, a D1 failure, or a schema path instead of connector_poll_failed", () => {
    expect(pollAttemptErrorCode(new ConnectorError("provider_error", "Not Found", { status: 404 })))
      .toBe("provider_error:http_404");
    expect(pollAttemptErrorCode(new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued.")))
      .toBe("connector_poll_failed:d1_overloaded");
    const rejection = PollResultSchema.safeParse({ ...resultWithStreamCode("x"), activityIds: "nope" });
    if (rejection.success) throw new Error("expected a rejection");
    expect(pollAttemptErrorCode(rejection.error)).toBe("connector_poll_failed:activityIds:invalid_type");
    expect(pollAttemptErrorCode(new Error("connector_connection_unavailable"))).toBe("connector_connection_unavailable");
  });
});

describe("a poll attempt's code crossing the step boundary", () => {
  it("survives the serialization a replayed step hands the terminal catch", () => {
    // A replayed checkpoint does not run the callback, so only what the error
    // itself carries reaches the terminal log. The boundary keeps the message.
    const thrown = pollAttemptFailure(
      new ConnectorError("provider_error", "Resource not accessible", { status: 404 }),
      "provider_error:http_404",
    );
    const replayed = new Error((thrown as Error).message);
    expect(failedPollAttemptCode(replayed)).toBe("provider_error:http_404");
    expect(failedPollAttemptCode(new Error("Resource not accessible"))).toBeNull();
  });

  it("rethrows a timeout as itself so the workflow still tells it apart", () => {
    const timeout = new DOMException("deadline", "TimeoutError");
    expect(pollAttemptFailure(timeout, "connector_poll_failed")).toBe(timeout);
  });
});
