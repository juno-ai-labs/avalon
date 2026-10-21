import { describe, expect, it } from "vitest";
import { suggestCalendarTimes } from "./google-availability";

describe("calendar availability intersection", () => {
  it("handles overlapping busy ranges and intervals outside the search window", () => {
    expect(suggestCalendarTimes({ attendeeEmails: [], startTime: "2026-10-21T09:00:00Z", endTime: "2026-10-21T12:00:00Z", durationMinutes: 60 }, "UTC", [{ start: "2026-10-21T07:00:00Z", end: "2026-10-21T09:30:00Z" }, { start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z" }, { start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:00:00Z" }])).toMatchObject({ timeSlots: [{ start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T11:00:00.000Z", availableUntil: "2026-10-21T12:00:00.000Z" }] });
  });
  it("uses local hours across the autumn DST change and excludes weekends", () => {
    expect(suggestCalendarTimes({ attendeeEmails: [], startTime: "2026-10-30T00:00:00-07:00", endTime: "2026-11-03T00:00:00-08:00", durationMinutes: 60, preferences: { startHour: "09:00", endHour: "10:00", excludeWeekends: true } }, "America/Los_Angeles", [])).toMatchObject({ timeSlots: [{ start: "2026-10-30T16:00:00.000Z", end: "2026-10-30T17:00:00.000Z" }, { start: "2026-11-02T17:00:00.000Z", end: "2026-11-02T18:00:00.000Z" }] });
  });
});
