import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import {
  deriveOrganizationUsage,
  usagePeriod,
  usageWeekStart,
  weeklyQuotaMicrousd,
  type UsageRollup,
} from "./usage";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();
// A Thursday at 9:00 AM UTC.
const created = at("2026-10-01T09:00:00.000Z");

describe("weeklyQuotaMicrousd", () => {
  it("is twice the monthly price divided by four", () => {
    expect(weeklyQuotaMicrousd("starter")).toBe(50_000_000);
    expect(weeklyQuotaMicrousd("growth")).toBe(125_000_000);
  });
});

describe("usageWeekStart", () => {
  it("resets exactly every 7 days from creation", () => {
    expect(iso(usageWeekStart(created, at("2026-10-08T08:59:59.999Z")))).toBe("2026-10-01T09:00:00.000Z");
    expect(iso(usageWeekStart(created, at("2026-10-08T09:00:00.000Z")))).toBe("2026-10-08T09:00:00.000Z");
    expect(iso(usageWeekStart(created, at("2026-11-12T10:00:00.000Z")))).toBe("2026-11-12T09:00:00.000Z");
  });
});

describe("usagePeriod", () => {
  it("runs from one sign-up anniversary to the next", () => {
    const period = usagePeriod(created, at("2026-10-20T00:00:00.000Z"));
    expect(iso(period.start)).toBe("2026-10-01T09:00:00.000Z");
    expect(iso(period.end)).toBe("2026-11-01T09:00:00.000Z");
  });

  it("belongs to the previous anniversary before this month's instant", () => {
    const period = usagePeriod(created, at("2026-11-01T08:00:00.000Z"));
    expect(iso(period.start)).toBe("2026-10-01T09:00:00.000Z");
  });

  it("clamps a 31st anniversary to the last day of a short month and crosses the year", () => {
    const late = at("2026-01-31T12:00:00.000Z");
    expect(iso(usagePeriod(late, at("2026-02-28T13:00:00.000Z")).start)).toBe("2026-02-28T12:00:00.000Z");
    expect(iso(usagePeriod(late, at("2026-02-28T13:00:00.000Z")).end)).toBe("2026-03-31T12:00:00.000Z");
    const december = usagePeriod(late, at("2027-01-05T00:00:00.000Z"));
    expect(iso(december.start)).toBe("2026-12-31T12:00:00.000Z");
    expect(iso(december.end)).toBe("2027-01-31T12:00:00.000Z");
  });
});

describe("deriveOrganizationUsage", () => {
  const starter = weeklyQuotaMicrousd("starter");
  const row = (weekStart: string, periodStart: string, spent: number, quota = starter): UsageRollup => ({
    weekStart: at(weekStart), periodStart: at(periodStart), quotaMicrousd: quota, organizationMicrousd: spent,
  });

  it("reads 100% with no usage and names the next reset", () => {
    const usage = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: at("2026-10-03T00:00:00.000Z"), rollups: [] });
    expect(usage).toEqual({
      plan: "starter",
      quotaRemainingPercent: 100,
      weekResetsAt: "2026-10-08T09:00:00.000Z",
      overage: { amountMicrousd: 0, periodStart: "2026-10-01T09:00:00.000Z", periodEndsAt: "2026-11-01T09:00:00.000Z", billed: false },
    });
  });

  it("rounds the percentage left down and floors it at zero, with overage past the quota", () => {
    const now = at("2026-10-03T00:00:00.000Z");
    const partly = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: now,
      rollups: [row("2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 14_000_001)] });
    expect(partly.quotaRemainingPercent).toBe(71);
    const over = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: now,
      rollups: [row("2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 70_000_000)] });
    expect(over.quotaRemainingPercent).toBe(0);
    expect(over.overage.amountMicrousd).toBe(20_000_000);
  });

  it("gives the earlier period the quota first in a week that straddles an anniversary", () => {
    // Week of Oct 29 runs across the Nov 1 anniversary: $40 before, $20 after.
    const rollups = [
      row("2026-10-29T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 40_000_000),
      row("2026-10-29T09:00:00.000Z", "2026-11-01T09:00:00.000Z", 20_000_000),
    ];
    const november = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: at("2026-11-02T00:00:00.000Z"), rollups });
    expect(november.overage.amountMicrousd).toBe(10_000_000);
    expect(november.quotaRemainingPercent).toBe(0);
    const october = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: at("2026-10-31T00:00:00.000Z"), rollups });
    expect(october.overage.amountMicrousd).toBe(0);
  });

  it("re-prices the current week against a changed quota", () => {
    const usage = deriveOrganizationUsage({ plan: "growth", createdAtMs: created, nowMs: at("2026-10-03T00:00:00.000Z"),
      rollups: [row("2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 70_000_000, weeklyQuotaMicrousd("growth"))] });
    expect(usage.quotaRemainingPercent).toBe(44);
    expect(usage.overage.amountMicrousd).toBe(0);
  });

  it("sums overage across the period's weeks and ignores weeks outside it", () => {
    const usage = deriveOrganizationUsage({ plan: "starter", createdAtMs: created, nowMs: at("2026-10-16T00:00:00.000Z"), rollups: [
      row("2026-09-24T09:00:00.000Z", "2026-09-01T09:00:00.000Z", 90_000_000),
      row("2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 55_000_000),
      row("2026-10-08T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 52_500_000),
      row("2026-10-15T09:00:00.000Z", "2026-10-01T09:00:00.000Z", 5_000_000),
    ] });
    expect(usage.overage.amountMicrousd).toBe(7_500_000);
    expect(usage.quotaRemainingPercent).toBe(90);
  });
});
