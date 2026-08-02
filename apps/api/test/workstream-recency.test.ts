import { describe, expect, it, vi } from "vitest";
import { WorkstreamService } from "../src/services/workstream-service";

describe("work-stream recency ordering", () => {
  it("selects the latest activity before applying the page limit", async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ success: true, results: [] })
    };
    const prepare = vi.fn().mockReturnValue(statement);
    const service = new WorkstreamService(
      { DB: { prepare, batch: vi.fn() } } as never,
      { workspaceId: "workspace-1", userId: "user-1" } as never
    );

    await service.list(25);

    const sql = String(prepare.mock.calls[0]?.[0]);
    expect(sql).toContain("ORDER BY w.last_activity_at DESC LIMIT ?");
    expect(sql).not.toContain("ORDER BY CASE");
  });
});
