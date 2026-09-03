import { describe, expect, it } from "vitest";
import {
  DurableObjectMigrationCommandSchema,
  DurableObjectMigrationReportSchema,
  durableObjectMigrationCommandQueue,
  isDurableObjectMigrationCommandQueue,
  isOpaqueDurableObjectName,
} from "./durable-object-migrations";

const WORKSPACE = "0192f3a0-1c4d-7000-8000-0000000000a1";
const WORKSTREAM = "0192f3a0-1c4d-7000-8000-0000000000a2";

describe("isOpaqueDurableObjectName", () => {
  it("accepts every name shape apps/api mints", () => {
    for (const name of [
      `global:${WORKSPACE}`,
      `eu:${WORKSPACE}:${WORKSTREAM}`,
      `eu:${WORKSPACE}:${WORKSTREAM}:0`,
      `eu:${WORKSPACE}:${WORKSTREAM}:0192f3a0-1c4d-7000-8000-0000000000a3`,
    ]) {
      expect(isOpaqueDurableObjectName(name)).toBe(true);
    }
  });

  it("refuses a name carrying anything legible", () => {
    for (const name of [
      `eu:acme-corporation:payroll`,
      `global:${WORKSPACE}:operator@with-avalon.com`,
      `global:${WORKSPACE}:Some Workspace`,
      "",
      `global:${"a".repeat(300)}`,
      `${`global:${WORKSPACE}:`.repeat(4)}${WORKSTREAM}`,
    ]) {
      expect(isOpaqueDurableObjectName(name)).toBe(false);
    }
  });
});

describe("DurableObjectMigrationReportSchema", () => {
  const report = {
    reportId: "0192f3a0-1c4d-7000-8000-0000000000b1",
    objectId: "a".repeat(64),
    objectName: `eu:${WORKSPACE}:${WORKSTREAM}`,
    className: "SubstreamAgent",
    component: "substream_agent_do",
    region: "eu",
    appEnv: "production",
    workerVersionId: "0.24.0",
    status: "applied",
    schemaVersion: 3,
    latestVersion: 3,
    appliedVersions: [1, 2, 3],
    failure: null,
    occurredAt: 1_700_000_000_000,
  };

  it("accepts a well-formed report", () => {
    expect(DurableObjectMigrationReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts a report with no name, which is how an ID-addressed object reports", () => {
    expect(DurableObjectMigrationReportSchema.safeParse({ ...report, objectName: null }).success)
      .toBe(true);
  });

  it("refuses a malformed object ID", () => {
    expect(DurableObjectMigrationReportSchema.safeParse({ ...report, objectId: "abc" }).success)
      .toBe(false);
    expect(DurableObjectMigrationReportSchema
      .safeParse({ ...report, objectId: "A".repeat(64) }).success).toBe(false);
  });

  it("refuses a name that is not opaque", () => {
    expect(DurableObjectMigrationReportSchema
      .safeParse({ ...report, objectName: "eu:acme-corporation" }).success).toBe(false);
  });

  it("bounds the failure message", () => {
    expect(DurableObjectMigrationReportSchema.safeParse({
      ...report,
      status: "failed",
      failure: { message: "x".repeat(1_001), version: 3 },
    }).success).toBe(false);
    expect(DurableObjectMigrationReportSchema.safeParse({
      ...report,
      status: "failed",
      failure: { message: "substream_agent_do_schema_hash_mismatch:3", version: 3 },
    }).success).toBe(true);
  });

  it("requires a report id, which is what makes a redelivery detectable", () => {
    const withoutId: Record<string, unknown> = { ...report };
    delete withoutId.reportId;
    expect(DurableObjectMigrationReportSchema.safeParse(withoutId).success).toBe(false);
    expect(DurableObjectMigrationReportSchema
      .safeParse({ ...report, reportId: "not-a-uuid" }).success).toBe(false);
  });

  it("refuses an unknown region or environment", () => {
    expect(DurableObjectMigrationReportSchema.safeParse({ ...report, region: "apac" }).success)
      .toBe(false);
    expect(DurableObjectMigrationReportSchema.safeParse({ ...report, appEnv: "prod" }).success)
      .toBe(false);
  });
});

describe("DurableObjectMigrationCommandSchema", () => {
  const command = {
    commandId: "0198f3a2-0000-7000-8000-000000000001",
    runId: "0198f3a2-0000-7000-8000-000000000002",
    className: "WorkspaceDO",
    objectId: "a".repeat(64),
    objectName: "global:00000000-0000-7000-8000-0000000000a1",
    region: "global",
    requestedAt: 1_700_000_000_000,
  };

  it("accepts a command the tracker would send", () => {
    expect(DurableObjectMigrationCommandSchema.safeParse(command).success).toBe(true);
    expect(DurableObjectMigrationCommandSchema
      .safeParse({ ...command, objectName: null }).success).toBe(true);
  });

  it("accepts only a correctly named WorkspaceDO automation cutover", () => {
    const cutover = {
      ...command,
      automationCutover: {
        workspaceId: "00000000-0000-7000-8000-0000000000a1",
        expectedDraftIds: ["00000000-0000-7000-8000-0000000000d1"],
      },
    };
    expect(DurableObjectMigrationCommandSchema.safeParse(cutover).success).toBe(true);
    expect(DurableObjectMigrationCommandSchema.safeParse({
      ...cutover,
      objectId: null,
      automationCutover: { workspaceId: cutover.automationCutover.workspaceId },
    }).success).toBe(true);
    expect(DurableObjectMigrationCommandSchema.safeParse({ ...command, objectId: null }).success).toBe(false);
    expect(DurableObjectMigrationCommandSchema.safeParse({
      ...cutover,
      className: "SubstreamAgent",
    }).success).toBe(false);
    expect(DurableObjectMigrationCommandSchema.safeParse({
      ...cutover,
      objectName: "global:00000000-0000-7000-8000-0000000000ff",
    }).success).toBe(false);
  });

  /**
   * A command crosses the same regional boundary a report does and clears the
   * same bar. The name is carried for a log line only, so the day a Durable
   * Object name grows a workspace slug this stops carrying it rather than
   * quietly shipping it.
   */
  it("refuses a name that is not opaque", () => {
    expect(DurableObjectMigrationCommandSchema
      .safeParse({ ...command, objectName: "eu:acme-corporation:payroll" }).success).toBe(false);
  });

  it("refuses a malformed object ID, class name, or region", () => {
    expect(DurableObjectMigrationCommandSchema
      .safeParse({ ...command, objectId: "abc" }).success).toBe(false);
    expect(DurableObjectMigrationCommandSchema
      .safeParse({ ...command, className: "not a class" }).success).toBe(false);
    expect(DurableObjectMigrationCommandSchema
      .safeParse({ ...command, region: "apac" }).success).toBe(false);
  });
});

describe("the forced migration command queues", () => {
  it("names one queue per region", () => {
    expect(durableObjectMigrationCommandQueue("global")).toBe("avalon-global-migration-commands");
    expect(durableObjectMigrationCommandQueue("eu")).toBe("avalon-eu-migration-commands");
  });

  /**
   * The dead-letter queues are the ones that matter. They carry the commands
   * this protocol already failed to apply, so routing them back to the same
   * consumer would retry the undeliverable forever.
   */
  it("recognizes both regions' queues and nothing beside them", () => {
    expect([
      durableObjectMigrationCommandQueue("global"),
      durableObjectMigrationCommandQueue("eu"),
    ].every(isDurableObjectMigrationCommandQueue)).toBe(true);

    expect([
      "avalon-global-migration-commands-dead-letter",
      "avalon-eu-migration-commands-dead-letter",
      "avalon-migration-reports",
      "avalon-global-activities",
      "avalon-global-access-revocations",
      // Near misses. This predicate picks a Worker's queue handler, so a queue
      // added later that merely ends the same way must not be parsed as
      // forced-migration traffic.
      "avalon-apac-migration-commands",
      "unrelated-migration-commands",
      "avalon-global-migration-commands-replay",
      "prefix-avalon-global-migration-commands",
    ].some(isDurableObjectMigrationCommandQueue)).toBe(false);
  });
});
