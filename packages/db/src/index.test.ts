import { describe, expect, it, vi } from "vitest";
import { createDatabase, newId } from "./index";

describe("database primitives", () => {
  it("creates sortable UUIDv7 identifiers", () => {
    const earlier = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(earlier < later).toBe(true);
  });

  it("claims an activity only when D1 reports a changed row", async () => {
    const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });
    const statement = { bind: vi.fn().mockReturnThis(), run };
    const db = createDatabase({
      prepare: vi.fn().mockReturnValue(statement),
      batch: vi.fn()
    } as never);
    await expect(db.activities.claim(newId())).resolves.toBe(true);
  });

  it("preserves active participant provenance and only resets it on reactivation", async () => {
    const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });
    const statement = { bind: vi.fn().mockReturnThis(), run };
    const prepare = vi.fn().mockReturnValue(statement);
    const db = createDatabase({ prepare, batch: vi.fn() } as never);

    await db.workstreams.addParticipant(newId(), newId(), newId(), newId(), "message");

    const sql = String(prepare.mock.calls[0]?.[0]);
    expect(sql).toContain("WHEN workstream_participants.removed_at IS NOT NULL");
    expect(sql).toContain("ELSE workstream_participants.participation_reason");
    expect(sql).toContain("ELSE workstream_participants.joined_at");
  });

  it("lists work streams strictly by latest activity instead of harness status", async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ success: true, results: [] })
    };
    const prepare = vi.fn().mockReturnValue(statement);
    const db = createDatabase({ prepare, batch: vi.fn() } as never);

    await db.workstreams.list(newId());

    const sql = String(prepare.mock.calls[0]?.[0]);
    expect(sql).toContain("ORDER BY w.last_activity_at DESC");
    expect(sql).not.toContain("CASE w.harness_status");
  });
});
