import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
    .replace(/\s+/gu, " ");
}

describe("ordinary harness-run selection", () => {
  it("keeps inline child and HyperSight rows out of automation and activity recovery", () => {
    // The idempotency reader resolves a run's harness attempt against the
    // work stream's own object, so the exclusion lives in that object's query
    // rather than in a regional join.
    const automation = source("../src/services/automation-service.ts");
    expect(automation).toContain(
      "SELECT id, status, workflow_instance_id FROM harness_runs WHERE workspace_id = ? AND workstream_id = ? AND parent_tool_call_id IS NULL AND origin != 'block_dashboard_block' ORDER BY created_at DESC LIMIT 1",
    );

    const activityConsumer = source("../src/queues/activity-consumer.ts");
    expect(activityConsumer).toMatch(
      /SELECT id FROM harness_runs WHERE workstream_id = \?1 AND parent_tool_call_id IS NULL AND origin != 'block_dashboard_block' ORDER BY created_at DESC LIMIT 1/u,
    );
  });

  it("keeps inline child and HyperSight rows out of scheduler reuse and socket snapshots", () => {
    const scheduler = source("../src/services/workspace-schedule-execution.ts");
    expect(scheduler).toMatch(
      /FROM harness_runs WHERE workspace_id = \?1 AND workstream_id = \?2 AND origin = 'automation' AND parent_tool_call_id IS NULL AND status IN \('scheduled', 'running'\)/u,
    );

    const product = source("../src/durable-objects/workstream-object-product.ts");
    expect(product).toMatch(
      // `created_at`, matching the REST read: a `scheduled` run carries a NULL
      // `started_at`, which SQLite sorts last under DESC, so ordering by it
      // would hand a subscriber an older run than the one it is watching.
      /SELECT run_id, origin, status, model, error_json, started_at, completed_at, created_at FROM runs WHERE parent_tool_call_id IS NULL AND origin != 'block_dashboard_block' ORDER BY created_at DESC, run_id DESC LIMIT 1/u,
    );
  });
});
