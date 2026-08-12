import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
    .replace(/\s+/gu, " ");
}

describe("ordinary harness-run selection", () => {
  it("keeps inline child and HyperSight rows out of workstream latest-run and retry state", () => {
    const service = source("../src/services/workstream-service.ts");
    expect(service).toMatch(
      /SELECT id, origin, status, model, error_json, started_at, completed_at, created_at FROM harness_runs WHERE workspace_id = \? AND workstream_id = \? AND parent_tool_call_id IS NULL AND origin != 'hypersight_block' ORDER BY created_at DESC LIMIT 1/u,
    );
    // `retry` reads the trigger beside the status: it replays the failed run's
    // own trigger, and the same two exclusions decide which run that is.
    expect(service).toMatch(
      /SELECT status, trigger_message_id FROM harness_runs WHERE workspace_id = \? AND workstream_id = \? AND parent_tool_call_id IS NULL AND origin != 'hypersight_block' ORDER BY created_at DESC LIMIT 1/u,
    );
  });

  it("keeps inline child and HyperSight rows out of automation and activity recovery", () => {
    const automation = source("../src/services/automation-service.ts");
    expect(automation).toContain(
      "LEFT JOIN harness_runs h ON h.workstream_id = r.workstream_id AND h.parent_tool_call_id IS NULL AND h.origin != 'hypersight_block'",
    );

    const activityConsumer = source("../src/queues/activity-consumer.ts");
    expect(activityConsumer).toMatch(
      /SELECT id FROM harness_runs WHERE workstream_id = \?1 AND parent_tool_call_id IS NULL AND origin != 'hypersight_block' ORDER BY created_at DESC LIMIT 1/u,
    );
  });

  it("keeps inline child and HyperSight rows out of scheduler reuse and socket snapshots", () => {
    const scheduler = source("../src/durable-objects/workspace-scheduler.ts");
    expect(scheduler).toMatch(
      /FROM harness_runs WHERE workspace_id = \?1 AND workstream_id = \?2 AND origin = 'automation' AND parent_tool_call_id IS NULL AND status IN \('scheduled', 'running'\)/u,
    );

    const room = source("../src/durable-objects/workstream-room.ts");
    expect(room).toMatch(
      // `created_at`, matching the REST read: a `scheduled` run carries a NULL
      // `started_at`, which SQLite sorts last under DESC, so ordering by it
      // would hand a subscriber an older run than the one it is watching.
      /SELECT id, origin, status, model, error_json, started_at, completed_at, created_at FROM harness_runs WHERE workstream_id = \?1 AND parent_tool_call_id IS NULL AND origin != 'hypersight_block' ORDER BY created_at DESC LIMIT 1/u,
    );
  });
});
