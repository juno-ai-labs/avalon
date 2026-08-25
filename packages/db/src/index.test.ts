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

  // Two tests were here: one over `workstreams.addParticipant`'s upsert text
  // and one over `workstreams.create`'s committed shape. Both covered the
  // repository's writes through the retired compatibility views, and both
  // moved with the code — the participant re-add is
  // `workstream-object-schema.test.ts`'s "makes a re-add through the identity
  // authority unseen again", and the creation shape is what the identity
  // authority's own workerd specs assert.

});
