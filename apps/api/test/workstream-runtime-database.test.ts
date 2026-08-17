import { describe, expect, it } from "vitest";

import { __workstreamRuntimeDatabaseTesting } from "../src/services/workstream-runtime-database";

describe("work-stream runtime database routing", () => {
  it("routes wake-up persistence to the owning WorkstreamDO", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM workstream_wakeups WHERE workstream_id = ?",
    )).toBe(true);
  });

  it("leaves workspace-owned resource and identity reads in regional D1", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT title FROM resources WHERE workspace_id = ?",
    )).toBe(false);
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT name FROM users WHERE id = ?",
    )).toBe(false);
  });
});
