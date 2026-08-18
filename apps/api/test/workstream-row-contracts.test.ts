import { ActivitySuggestionSchema, WorkstreamSchema } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import { toWorkstream, WorkstreamRowSchema } from "../src/mappers/workstream";
import { workstreamRowSchemas } from "../src/services/workstream-service";

const WORKSPACE_ID = "019fc068-22e8-739a-8394-a760fdc7c376";
const WORKSTREAM_ID = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";

function suggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "019fef75-d215-7f63-ae86-8d23a6f2ee1e",
    activity_id: "019feef6-9b84-71a6-9040-9c3822fd7e0a",
    workstream_id: WORKSTREAM_ID,
    title: "juno-ai-labs/avalon: push — Use the Tabler lock for the private-note marker",
    summary: "A commit landed.",
    confidence: 0.9,
    reason: "The work stream tracks this repository.",
    status: "pending",
    created_at: "2026-08-10T17:59:46.486Z",
    resolved_at: null,
    ...overrides,
  };
}

function workstreamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSTREAM_ID,
    workspace_id: WORKSPACE_ID,
    title: "Avalon UX/quality of life",
    objective: "",
    origin_type: "ad_hoc",
    origin_label: null,
    created_by_user_id: null,
    automation_subscription_id: null,
    automation_run_id: null,
    planned_for: null,
    harness_status: "completed",
    title_status: "settled",
    email_address: null,
    latest_attention_sequence_number: 50,
    unread_tracking_start_sequence_number: 0,
    scope: "workspace",
    system_kind: null,
    last_activity_at: "2026-08-11T00:05:21.146Z",
    created_at: "2026-08-10T16:10:55.531Z",
    updated_at: "2026-08-11T00:05:21.146Z",
    archived_at: null,
    next_pending_wakeup_at: null,
    next_pending_wakeup_prompt_prefix: null,
    ...overrides,
  };
}

describe("work-stream row contracts", () => {
  it("bounds an activity title the column itself does not bound", () => {
    // The failure this exists for. `activities.title` has no length constraint
    // and a GitHub push title is the whole commit body, so it routinely runs
    // past what the response contract accepts. Bounding it at the read is what
    // keeps a 500-character commit message from making a work stream
    // unopenable for everyone in the workspace.
    const parsed = workstreamRowSchemas.suggestions.parse(suggestionRow({
      title: `juno-ai-labs/avalon: push — ${"x".repeat(500)}`,
      summary: "y".repeat(4_000),
      reason: "z".repeat(2_000),
    }));

    expect(parsed.title).toHaveLength(300);
    expect(parsed.summary).toHaveLength(2_000);
    expect(parsed.reason).toHaveLength(1_200);
    expect(() => ActivitySuggestionSchema.parse({
      id: parsed.id,
      activityId: parsed.activity_id,
      workstreamId: parsed.workstream_id,
      title: parsed.title,
      summary: parsed.summary,
      confidence: parsed.confidence,
      reason: parsed.reason,
      status: parsed.status,
      createdAt: parsed.created_at,
      resolvedAt: parsed.resolved_at,
    })).not.toThrow();
  });

  it("refuses a status the column's own CHECK constraint would refuse", () => {
    // The schemas mirror the table's constraints rather than inventing new
    // ones, so a row that reaches here in this state is corrupt — and the
    // failure now names the column instead of surfacing as an anonymous 500
    // from the response schema several layers later.
    const issues = workstreamRowSchemas.suggestions.safeParse(suggestionRow({ status: "ignored" }));
    expect(issues.success).toBe(false);
    expect(!issues.success && issues.error.issues[0]?.path).toEqual(["status"]);

    const harness = WorkstreamRowSchema.safeParse(workstreamRow({ harness_status: "paused" }));
    expect(!harness.success && harness.error.issues[0]?.path).toEqual(["harness_status"]);
  });

  it("refuses a confidence outside the range the column allows", () => {
    const parsed = workstreamRowSchemas.suggestions.safeParse(suggestionRow({ confidence: 1.4 }));
    expect(!parsed.success && parsed.error.issues[0]?.path).toEqual(["confidence"]);
  });

  it("refuses a row missing a column the table declares NOT NULL", () => {
    // Hand-coercion turned an absent `scope` into "workspace" and an absent
    // sequence number into 0, so a query that stopped returning a column
    // produced plausible output instead of an error.
    const withoutScope: Record<string, unknown> = workstreamRow();
    delete withoutScope.scope;
    const parsed = WorkstreamRowSchema.safeParse(withoutScope);
    expect(!parsed.success && parsed.error.issues[0]?.path).toEqual(["scope"]);
  });

  it("produces a row the work-stream contract accepts", () => {
    const row = WorkstreamRowSchema.parse(workstreamRow({
      viewer_read_state_user_id: "019fc4e0-e515-70a7-8040-271952c34b21",
      viewer_read_through_sequence_number: 12,
      viewer_manual_unread_from_sequence_number: null,
      viewer_manual_unread_generation: 3,
    }));

    expect(WorkstreamSchema.shape.harnessStatus.parse(row.harness_status)).toBe("completed");
    expect(WorkstreamSchema.shape.scope.parse(row.scope)).toBe("workspace");
    expect(row.viewer_manual_unread_generation).toBe(3);
    expect(row.next_pending_wakeup_at).toBeNull();
  });

  it("re-validates the stored model pin on the way out", () => {
    expect(toWorkstream(workstreamRow({ model_override: "deepseek/deepseek-v4-pro" })).modelOverride)
      .toBe("deepseek/deepseek-v4-pro");
    // Absent and explicitly null are both the ordinary unpinned state; the
    // column is nullable and the mapper's schema admits either.
    expect(toWorkstream(workstreamRow()).modelOverride).toBeNull();
    expect(toWorkstream(workstreamRow({ model_override: null })).modelOverride).toBeNull();
    // A model retired from AGENT_MODEL_OVERRIDES leaves rows still naming it.
    // They read as unpinned here because that is what they now *run* as — the
    // resolver drops the same value and returns them to the flag — and a
    // response that failed instead would make those work streams unopenable.
    expect(toWorkstream(workstreamRow({ model_override: "x-ai/grok-2" })).modelOverride).toBeNull();
  });

  it("maps the next pending wake-up from the joined row", () => {
    const nextPendingWakeup = {
      dueAt: "2026-08-13T20:30:00.000Z",
      promptPreview: "Check production deploy status…",
    };
    expect(toWorkstream(workstreamRow({
      next_pending_wakeup_at: nextPendingWakeup.dueAt,
      next_pending_wakeup_prompt_prefix: nextPendingWakeup.promptPreview,
    })).nextPendingWakeup).toEqual(nextPendingWakeup);
  });

  it("does not split a surrogate pair in the wake-up prompt preview", () => {
    expect(toWorkstream(workstreamRow({
      next_pending_wakeup_at: "2026-08-13T20:30:00.000Z",
      next_pending_wakeup_prompt_prefix: "🚀".repeat(21),
    })).nextPendingWakeup?.promptPreview).toBe(`${"🚀".repeat(20)}…`);
  });

  it("keeps a nullable join column optional", () => {
    // `origin_label` comes from a LEFT JOIN and is absent for an ad-hoc work
    // stream; requiring it would refuse most of the table.
    expect(WorkstreamRowSchema.safeParse(workstreamRow({ origin_label: undefined })).success).toBe(true);
    expect(WorkstreamRowSchema.safeParse(workstreamRow({ origin_label: "Daily digest" })).success).toBe(true);
  });
});
