import { describe, expect, it } from "vitest";
import { z } from "zod";

import { codeShaped, describeZodIssues, zodDiagnosticCode, DIAGNOSTIC_CODE_MAX_LENGTH } from "./zod-diagnostics";

const Summary = z.looseObject({
  id: z.string().min(1),
  summary: z.looseObject({ topics_discussed: z.array(z.string()).nullish() }).nullish(),
});

function rejection(input: unknown): z.ZodError {
  const result = Summary.safeParse(input);
  if (result.success) throw new Error("expected a rejection");
  return result.error;
}

describe("zod diagnostics", () => {
  it("names the failing path and issue code", () => {
    expect(describeZodIssues(rejection({ summary: { topics_discussed: [] } })))
      .toContain("id:invalid_type");
  });

  it("names a nested path, which is what locates a provider's shape drift", () => {
    // The real one: Fireflies answered 200 with a body whose shape had moved.
    // "unexpected_error" made two identical log lines; the path makes it one edit.
    expect(describeZodIssues(rejection({ id: "x", summary: { topics_discussed: [{ name: "pricing" }] } })))
      .toContain("summary.topics_discussed.0");
  });

  it("marks a whole-value mismatch with something no field can be mistaken for", () => {
    expect(describeZodIssues(rejection("not an object"))).toContain("-root-");
    // A marker spelled `_root_` would be a legal object key, so a field of that
    // name and "there was no field" would read identically. A hyphen cannot
    // appear in a declared name, and a key containing one is withheld first.
    const Named = z.looseObject({ "-root-": z.number() });
    const collision = Named.safeParse({ "-root-": "x" });
    if (collision.success) throw new Error("expected a rejection");
    expect(describeZodIssues(collision.error)).not.toContain("-root-");
  });

  it("withholds the offending keys a caller sent unless the caller is one we control", () => {
    const Strict = z.strictObject({ id: z.string() });
    const result = Strict.safeParse({ id: "x", surprise: 1 });
    if (result.success) throw new Error("expected a rejection");
    // The names come from the rejected object, so they are the caller's data on
    // any boundary but our own: a provider response carries whatever it likes.
    expect(describeZodIssues(result.error)).not.toContain("surprise");
    expect(describeZodIssues(result.error)).toContain("unrecognized_keys");
    // Across a Durable Object RPC both sides are this deployment, and the name
    // is the whole diagnosis of a version skew.
    expect(describeZodIssues(result.error, { namesUnknownKeys: true })).toContain("surprise");
  });

  it("never carries a member's data that a record schema put on the path", () => {
    // `z.record` keys are the *value's*, not the schema's. A schema keyed by
    // address or secret would otherwise put it in a log line, an RPC message,
    // and an operator notice posted to Slack.
    const Directory = z.record(z.string(), z.number());
    for (const key of [
      "alex@juno-labs.com",
      "sk-live-4f9a2c7e11b3",
      "Board deck — Series A",
      "019fc4e0-e515-70a7-8040-271952c34b21",
    ]) {
      const result = Directory.safeParse({ [key]: "not a number" });
      if (result.success) throw new Error("expected a rejection");
      const described = describeZodIssues(result.error);
      expect(described).toContain("_key_");
      for (const fragment of key.split(/[^A-Za-z0-9]+/u).filter((part) => part.length > 3)) {
        expect(described).not.toContain(fragment);
      }
    }
  });

  it("answers null for anything that is not a schema rejection, so callers keep their own vocabulary", () => {
    expect(zodDiagnosticCode(new Error("provider_unavailable"), "response")).toBeNull();
    expect(zodDiagnosticCode("not an error", "response")).toBeNull();
  });

  it("stays code-shaped, and withholds rather than sanitizes a path it does not control", () => {
    const Open = z.record(z.string(), z.number());
    const result = Open.safeParse({ "seat (row 3)": "x" });
    if (result.success) throw new Error("expected a rejection");
    const code = zodDiagnosticCode(result.error, "chart")!;
    expect(code).toMatch(/^[a-z0-9_:.-]+$/iu);
    expect(code.length).toBeLessThanOrEqual(DIAGNOSTIC_CODE_MAX_LENGTH);
    // Sanitizing it to `seat_row_3` would still be the value, with the
    // punctuation removed. Withholding it is the only thing that is not.
    expect(code).not.toContain("seat");
    expect(code).not.toContain("row");
    expect(code).toContain("_key_");
  });

  it("truncates rather than emitting a code too long for its narrowest consumer", () => {
    expect(codeShaped("a".repeat(500))).toHaveLength(DIAGNOSTIC_CODE_MAX_LENGTH);
  });
});
