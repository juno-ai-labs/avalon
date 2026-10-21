import { describe, expect, it } from "vitest";
import { GoogleRepeatSchema, googleRecurrenceRule } from "./google-recurrence";

describe("semantic repeating schedules", () => {
  it("builds an every-other-week weekday schedule", () => {
    expect(googleRecurrenceRule({ frequency: "weekly", interval: 2, weekdays: ["monday", "wednesday"], occurrences: 8 }, false, "America/Los_Angeles")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8");
  });
  it("uses the inclusive local ending date across a daylight-saving change", () => {
    expect(googleRecurrenceRule({ frequency: "daily", until: "2026-11-01" }, false, "America/Los_Angeles")).toBe("RRULE:FREQ=DAILY;UNTIL=20261102T075959Z");
    expect(googleRecurrenceRule({ frequency: "daily", until: "2026-11-01" }, true, "America/Los_Angeles")).toBe("RRULE:FREQ=DAILY;UNTIL=20261101");
  });
  it("rejects conflicting endings and weekday restrictions on a monthly schedule", () => {
    expect(GoogleRepeatSchema.safeParse({ frequency: "weekly", until: "2026-11-01", occurrences: 3 }).success).toBe(false);
    expect(GoogleRepeatSchema.safeParse({ frequency: "monthly", weekdays: ["monday"] }).success).toBe(false);
  });
});
