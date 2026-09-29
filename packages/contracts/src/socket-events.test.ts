import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isUnknownSocketEvent, safeParseSocketEvent } from "./socket-events";
import { CHANNEL_RAILS_NAMED_LIMIT, ClientSocketEventSchema, ClientSocketEventTypeSchema, WorkspaceSocketClientEventSchema, WorkspaceSocketClientEventTypeSchema } from "./index";

describe("socket event compatibility", () => {
  const schema = z.strictObject({ type: z.literal("known"), rows: z.array(z.strictObject({ count: z.number() })) });
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
  it("takes a channel_rails request for exactly one target", () => {
    const requestId = "018f22f2-4c22-7abc-8def-0123456789ab";
    const spaceId = "00000000-0000-4000-8000-000000000001";
    const workstreamId = "018f22f2-4c22-7abc-8def-0123456789ac";
    const valid = (event: Record<string, unknown>) =>
      WorkspaceSocketClientEventSchema.safeParse({ type: "channel_rails", requestId, ...event }).success;
    expect(valid({ spaceId })).toBe(true);
    expect(valid({ spaceId, after: workstreamId })).toBe(true);
    expect(valid({ workstreamIds: [workstreamId] })).toBe(true);
    // Neither target, both, or a cursor with no Space to page.
    expect(valid({})).toBe(false);
    expect(valid({ spaceId, workstreamIds: [workstreamId] })).toBe(false);
    expect(valid({ workstreamIds: [workstreamId], after: workstreamId })).toBe(false);
    // Named Channels: at least one, unique, and no more than the bound.
    expect(valid({ workstreamIds: [] })).toBe(false);
    expect(valid({ workstreamIds: [workstreamId, workstreamId] })).toBe(false);
    const ids = (count: number) => Array.from({ length: count },
      (_, index) => `018f22f2-4c22-7abc-8def-${String(index).padStart(12, "0")}`);
    expect(valid({ workstreamIds: ids(CHANNEL_RAILS_NAMED_LIMIT) })).toBe(true);
    expect(valid({ workstreamIds: ids(CHANNEL_RAILS_NAMED_LIMIT + 1) })).toBe(false);
  });
  it("takes a space_channels request for one Space, paged with `after`, saying whether it wants rails", () => {
    const requestId = "018f22f2-4c22-7abc-8def-0123456789ab";
    const spaceId = "00000000-0000-4000-8000-000000000001";
    const workstreamId = "018f22f2-4c22-7abc-8def-0123456789ac";
    const valid = (event: Record<string, unknown>) =>
      WorkspaceSocketClientEventSchema.safeParse({ type: "space_channels", requestId, ...event }).success;
    expect(valid({ spaceId, rails: true })).toBe(true);
    expect(valid({ spaceId, after: workstreamId, rails: false })).toBe(true);
    expect(valid({ spaceId })).toBe(false);
    expect(valid({ rails: true })).toBe(false);
    expect(WorkspaceSocketClientEventSchema.safeParse({ type: "channels_by_space" }).success).toBe(true);
  });
  it("handles additive fields inside ordinary union members", () => {
    const union = z.strictObject({ row: z.union([z.strictObject({ first: z.string() }), z.strictObject({ second: z.number() })]) });
    expect(safeParseSocketEvent(union, { row: { second: 2, extra: true } })).toEqual({ success: true, data: { row: { second: 2 } } });
  });
});
