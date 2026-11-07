import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isUnknownSocketEvent, safeParseSocketEvent } from "./socket-events";
import { WorkstreamPrivateChildSchema, ClientSocketEventSchema, ClientSocketEventTypeSchema, WorkspaceSocketClientEventSchema, WorkspaceSocketClientEventTypeSchema } from "./index";

describe("socket event compatibility", () => {
  const schema = z.strictObject({ type: z.literal("known"), rows: z.array(z.strictObject({ count: z.number() })) });
  it("accepts resolved private children with an older strict schema by stripping the new flag", () => {
    const child = { substreamId: "00000000-0000-4000-8000-000000000001", title: "Done",
      createdByUserId: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" };
    const legacy = z.strictObject({ privateChildren: z.array(WorkstreamPrivateChildSchema.omit({ resolved: true })) });
    expect(safeParseSocketEvent(legacy, { privateChildren: [{ ...child, resolved: true }] }))
      .toEqual({ success: true, data: { privateChildren: [child] } });
  });

  it("discards additive fields at every object depth without mutating the frame", () => {
    const frame = { type: "known", future: true, rows: [{ count: 2, extra: "new" }] };
    expect(safeParseSocketEvent(schema, frame)).toEqual({ success: true, data: { type: "known", rows: [{ count: 2 }] } });
    expect(frame.rows[0]).toHaveProperty("extra", "new");
    expect(schema.safeParse(frame).success).toBe(false);
  });
  it("retains known-field validation", () => {
    expect(safeParseSocketEvent(schema, { type: "known", future: true, rows: [{ count: "wrong" }] }).success).toBe(false);
  });
  it("recognizes unknown types without confusing malformed known events", () => {
    for (const types of [ClientSocketEventTypeSchema, WorkspaceSocketClientEventTypeSchema]) {
      expect(isUnknownSocketEvent({ type: "future_event" }, types)).toBe(true);
      expect(isUnknownSocketEvent({ type: "subscribe", future: true }, types)).toBe(false);
      expect(isUnknownSocketEvent({ type: 123 }, types)).toBe(false);
    }
  });
  it("accepts additive fields on real workspace and conversation subscriptions", () => {
    expect(safeParseSocketEvent(ClientSocketEventSchema, { type: "subscribe", afterSequence: 0, future: true }).success).toBe(true);
    expect(safeParseSocketEvent(WorkspaceSocketClientEventSchema, { type: "subscribe", afterWaterline: 0, future: true }).success).toBe(true);
  });
  it("accepts old and correlated workspace subscriptions while rejecting malformed attempt IDs", () => {
    const subscribe = { type: "subscribe", afterWaterline: 0 };
    const diagnosticAttemptId = "018f22f2-4c22-7abc-8def-0123456789ab";
    expect(WorkspaceSocketClientEventSchema.safeParse(subscribe).success).toBe(true);
    expect(WorkspaceSocketClientEventSchema.safeParse({ ...subscribe, diagnosticAttemptId }).success).toBe(true);
    expect(WorkspaceSocketClientEventSchema.safeParse({ ...subscribe, diagnosticAttemptId: "not-a-uuid" }).success).toBe(false);
  });
  it("handles additive fields inside ordinary union members", () => {
    const union = z.strictObject({ row: z.union([z.strictObject({ first: z.string() }), z.strictObject({ second: z.number() })]) });
    expect(safeParseSocketEvent(union, { row: { second: 2, extra: true } })).toEqual({ success: true, data: { row: { second: 2 } } });
  });
});
