import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRpcInput } from "../src/lib/rpc-input";
import { scheduledAlarmErrorCode } from "../src/durable-objects/scheduled-alarm-report";

const Projection = z.strictObject({
  schemaVersion: z.literal(1),
  evaluators: z.array(z.strictObject({
    evaluatorId: z.string(),
    source: z.strictObject({ connectionId: z.string(), eventType: z.string() }),
  })),
});

describe("parseRpcInput", () => {
  it("returns the parsed value unchanged when the input is valid", () => {
    const input = { schemaVersion: 1, evaluators: [] };
    expect(parseRpcInput(Projection, input, "projection")).toEqual(input);
  });

  it("names the schema and the failing paths in a message that survives an RPC hop", () => {
    let thrown: unknown;
    try {
      parseRpcInput(Projection, {
        schemaVersion: 1,
        evaluators: [{ evaluatorId: "e1", source: { connectionId: 7, eventType: "note.generated" } }],
      }, "projection");
    } catch (error) {
      thrown = error;
    }

    // The whole point: what the *calling* object gets to log. A `ZodError` is
    // reduced to a bare `Error` by the RPC serializer, so anything held in
    // `issues` — or in a `message` derived from them — is gone by the time the
    // caller sees it. Only the message text crosses, so the paths live there.
    expect(thrown).toBeInstanceOf(Error);
    const crossed = structuredClone(thrown as Error);
    expect(crossed.message).toContain("projection_invalid");
    expect(crossed.message).toContain("evaluators.0.source.connectionId");
  });

  it("keeps a whole-value shape mismatch code-shaped, not only a field-level one", () => {
    // Version skew sends the wrong shape entirely, and Zod reports that at an
    // empty path. Spelling it `(root)` put parentheses in the message, which
    // `scheduledAlarmErrorCode` refuses — so the case that most needs the
    // detail was the one that silently lost it.
    for (const input of [null, undefined, [], "projection", 7]) {
      let thrown: unknown;
      try {
        parseRpcInput(Projection, input, "projection");
      } catch (error) {
        thrown = error;
      }
      const code = scheduledAlarmErrorCode(thrown);
      expect(code).not.toContain("handler_error");
      expect(code).toContain("projection_invalid");
      expect(code).toContain("_root_");
    }
  });

  it("names the offending keys when a caller sends a field this binary does not know", () => {
    // The rollout shape: a caller one deploy ahead adds a field, and the older
    // binary's `strictObject` refuses it. Zod reports that at an empty path with
    // the names in `issue.keys`, so a message built from `path` alone would name
    // neither the field nor a usable location — for the one failure whose whole
    // diagnosis is the field name.
    let thrown: unknown;
    try {
      parseRpcInput(Projection, { schemaVersion: 1, evaluators: [], surprise: "x" }, "projection");
    } catch (error) {
      thrown = error;
    }
    const code = scheduledAlarmErrorCode(thrown);
    expect(code).not.toContain("handler_error");
    expect(code).toContain("unrecognized_keys");
    expect(code).toContain("surprise");
  });

  it("keeps a path the schema does not control from breaking the code shape", () => {
    // An open record's keys are the caller's, not the schema's, so a path
    // segment can carry anything. One character outside the class costs the
    // whole message: `scheduledAlarmErrorCode` is all-or-nothing, and answers
    // `handler_error` for a message that is 99% useful.
    let thrown: unknown;
    try {
      parseRpcInput(z.record(z.string(), z.number()), { "seat (row 3)": "x" }, "seating");
    } catch (error) {
      thrown = error;
    }
    const code = scheduledAlarmErrorCode(thrown);
    expect(code).not.toContain("handler_error");
    expect(code).toContain("seating_invalid");
    expect(code).toContain("seat_");
  });

  it("stays code-shaped, so an alarm failure reaches the operator notice as a code", () => {
    let thrown: unknown;
    try {
      parseRpcInput(Projection, { schemaVersion: 2, evaluators: "no" }, "projection");
    } catch (error) {
      thrown = error;
    }
    // `scheduledAlarmErrorCode` passes a message through only while it matches
    // its character class, and answers `handler_error:<name>` otherwise — which
    // is exactly the uninformative notice this primitive exists to avoid.
    const code = scheduledAlarmErrorCode(thrown);
    expect(code).not.toContain("handler_error");
    expect(code).toContain("projection_invalid");
    expect(code.length).toBeLessThanOrEqual(120);
  });
});
