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

  it("marks a whole-value mismatch rather than leaving the path empty", () => {
    expect(describeZodIssues(rejection("not an object"))).toContain("_root_");
  });

  it("names the offending keys a version skew sends, which are not on the path", () => {
    const Strict = z.strictObject({ id: z.string() });
    const result = Strict.safeParse({ id: "x", surprise: 1 });
    if (result.success) throw new Error("expected a rejection");
    expect(describeZodIssues(result.error)).toContain("surprise");
  });

  it("answers null for anything that is not a schema rejection, so callers keep their own vocabulary", () => {
    expect(zodDiagnosticCode(new Error("provider_unavailable"), "response")).toBeNull();
    expect(zodDiagnosticCode("not an error", "response")).toBeNull();
  });

  it("stays code-shaped, including over a path the schema does not control", () => {
    const Open = z.record(z.string(), z.number());
    const result = Open.safeParse({ "seat (row 3)": "x" });
    if (result.success) throw new Error("expected a rejection");
    const code = zodDiagnosticCode(result.error, "seating")!;
    expect(code).toMatch(/^[a-z0-9_:.-]+$/iu);
    expect(code.length).toBeLessThanOrEqual(DIAGNOSTIC_CODE_MAX_LENGTH);
    expect(code).toContain("seat_");
  });

  it("truncates rather than emitting a code too long for its narrowest consumer", () => {
    expect(codeShaped("a".repeat(500))).toHaveLength(DIAGNOSTIC_CODE_MAX_LENGTH);
  });
});
