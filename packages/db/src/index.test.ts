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

  it("resolves the automation origin label in a separate statement from the work-stream read", async () => {
    const rows = [
      { id: newId(), automation_subscription_id: newId(), title: "t", harness_status: "idle" },
      { origin_label: "Weekly digest" },
    ];
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? null)),
    };
    const prepare = vi.fn().mockReturnValue(statement);
    const db = createDatabase({ prepare, batch: vi.fn() } as never);

    const workstream = await db.workstreams.get(newId(), newId());

    // One statement cannot span authorities through the runtime router, so the
    // work-stream read must not join the workspace-authority automation tables.
    const workstreamSql = String(prepare.mock.calls[0]?.[0]);
    expect(workstreamSql).not.toContain("automation_subscriptions");
    const labelSql = String(prepare.mock.calls[1]?.[0]);
    expect(labelSql).toContain("automation_subscriptions");
    expect(labelSql).not.toContain("workstreams");
    expect(workstream?.originLabel).toBe("Weekly digest");
  });
});
