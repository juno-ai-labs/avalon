import { describe, expect, it, vi } from "vitest";
import { logEvent } from "../src/logger";

function capture(level: "info" | "warn" | "error", emit: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
  try {
    emit();
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]?.[0] as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe("retention Worker logging", () => {
  it("logs an object so Workers Logs indexes each field", () => {
    const entry = capture("info", () =>
      logEvent("info", "desktop_release_retention_completed", { cron: "0 * * * *", deleted: 4 }));

    expect(typeof entry).toBe("object");
    expect(entry).toMatchObject({
      cron: "0 * * * *",
      deleted: 4,
      event: "desktop_release_retention_completed",
      level: "info",
    });
  });

  it("never lists a blank row, with or without a caller message", () => {
    expect(capture("info", () => logEvent("info", "desktop_release_retention_skipped")).message)
      .toBe("desktop_release_retention_skipped");
    expect(capture("warn", () => logEvent("warn", "desktop_release_retention_skipped", {
      message: "desktop_release_retention_skipped not_target_local_hour",
    })).message).toBe("desktop_release_retention_skipped not_target_local_hour");
  });
});
