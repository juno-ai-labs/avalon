import { describe, expect, it, vi } from "vitest";

import {
  observableWorkspaceScheduledAlarmKind,
  WorkspaceAlarmInstrumentation,
} from "../src/durable-objects/workspace-alarm-instrumentation";
import { createTestEnv } from "./helpers/cloudflare-test";
import { recordedSpans, resetRecordedSpans } from "./helpers/cloudflare-workers";

const env = createTestEnv({
  AVALON_REGION: "global",
  APP_VERSION: "test-version",
  BUILD_SHA: "test-sha",
  LOG_LEVEL: "info",
});

describe("WorkspaceDO alarm instrumentation", () => {
  it("records only bounded phase and kind fields and identifies work beyond the recovery horizon", async () => {
    resetRecordedSpans();
    const rows: Record<string, unknown>[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((row: unknown) => {
      rows.push(row as Record<string, unknown>);
    });
    let now = 1_000;

    try {
      const instrumentation = new WorkspaceAlarmInstrumentation(env, () => now);
      await instrumentation.phase("stored_target", "maintenance", async () => {
        now = 3_501;
      });
      await expect(instrumentation.phase("schedule_reconcile", undefined, async () => {
        now = 3_701;
        throw new Error("this message must not be logged");
      })).rejects.toThrow("this message must not be logged");
      instrumentation.finish();
    } finally {
      info.mockRestore();
    }

    expect(rows.map((row) => row.event)).toEqual([
      "workspace_scheduled_alarm_phase_started",
      "workspace_scheduled_alarm_phase_completed",
      "workspace_scheduled_alarm_phase_started",
      "workspace_scheduled_alarm_phase_failed",
      "workspace_scheduled_alarm_work_completed",
    ]);
    expect(rows[1]).toMatchObject({
      phase: "stored_target",
      alarm_kind: "maintenance",
      duration_ms: 2_501,
      crossed_recovery_horizon: true,
    });
    expect(rows[3]).toMatchObject({
      phase: "schedule_reconcile",
      duration_ms: 200,
      crossed_recovery_horizon: false,
      // A phase outside the workspace's isolating wrapper has no other record
      // of why it failed; the code is the caller's, never the message.
      error_name: "Error",
      code: "schedule_reconcile_failed",
    });
    expect(rows[4]).toMatchObject({
      status: "completed_with_phase_failure",
      duration_ms: 2_701,
      phase_count: 2,
      stored_target_count: 1,
      failed_phase_count: 1,
      slowest_phase: "stored_target",
      slowest_alarm_kind: "maintenance",
      slowest_phase_ms: 2_501,
      crossed_recovery_horizon: true,
    });
    expect(recordedSpans().map((span) => ({
      name: span.name,
      callbackFailed: span.callbackFailed,
    }))).toEqual([
      { name: "rally.workspace.scheduled_alarm.phase", callbackFailed: false },
      { name: "rally.workspace.scheduled_alarm.phase", callbackFailed: false },
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("this message must not be logged");
    for (const forbidden of [
      "workspace_id",
      "alarm_key",
      "due_at",
      "payload",
      "connector",
      "error_message",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("collapses an unrecognized stored kind to a bounded value", () => {
    const dispatched = new Set(["maintenance", "sidekick_run_notice"]);
    expect(observableWorkspaceScheduledAlarmKind("maintenance", dispatched)).toBe("maintenance");
    expect(observableWorkspaceScheduledAlarmKind("sidekick_run_notice", dispatched)).toBe("sidekick_run_notice");
    expect(observableWorkspaceScheduledAlarmKind("user-controlled-kind", dispatched)).toBe("unknown");
  });
});
