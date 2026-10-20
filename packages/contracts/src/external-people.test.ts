import { describe, expect, it } from "vitest";
import { ExternalPeopleSchema } from "./external-people";

const person = (index: number) => ({ provider: "google", providerTenantId: "account", providerUserId: null,
  handle: null, email: `guest${index}@example.com`, displayName: null, role: "recipient", sourceText: "mail header" });

describe("external people", () => {
  it("preserves 10,000 distinct people in order and deduplicates before enforcing the limit", () => {
    const people = Array.from({ length: 10_000 }, (_, index) => person(index));
    const parsed = ExternalPeopleSchema.parse([...people, { ...person(0), email: "GUEST0@example.com" }]);
    expect(parsed).toHaveLength(10_000);
    expect(parsed[100]?.email).toBe("guest100@example.com");
    expect(parsed.at(-1)?.email).toBe("guest9999@example.com");
  });

  it("rejects 10,001 distinct people rather than silently truncating them", () => {
    const result = ExternalPeopleSchema.safeParse(Array.from({ length: 10_001 }, (_, index) => person(index)));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("too_big");
  });

  it("does not merge ambiguous names with different source evidence", () => {
    const first = { ...person(0), email: null, displayName: "Alex", sourceText: "Alex from the design team" };
    const second = { ...first, sourceText: "Alex from the engineering team" };
    expect(ExternalPeopleSchema.parse([first, second, first])).toEqual([first, second]);
  });

  it("keeps distinct roles and provider tenants separate", () => {
    const first = person(0);
    const parsed = ExternalPeopleSchema.parse([first, first, { ...first, role: "sender" }, { ...first, providerTenantId: "other-account" }]);
    expect(parsed.map((row) => [row.role, row.providerTenantId])).toEqual([
      ["recipient", "account"], ["sender", "account"], ["recipient", "other-account"],
    ]);
  });
});
