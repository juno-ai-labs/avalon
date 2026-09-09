import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isUnknownSocketEvent, safeParseSocketEvent } from "./socket-events";
import { ClientSocketEventSchema, ClientSocketEventTypeSchema, WorkspaceSocketClientEventSchema, WorkspaceSocketClientEventTypeSchema } from "./index";

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
  it("handles additive fields inside ordinary union members", () => {
    const union = z.strictObject({ row: z.union([z.strictObject({ first: z.string() }), z.strictObject({ second: z.number() })]) });
    expect(safeParseSocketEvent(union, { row: { second: 2, extra: true } })).toEqual({ success: true, data: { row: { second: 2 } } });
  });
});
