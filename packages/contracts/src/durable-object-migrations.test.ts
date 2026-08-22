import { describe, expect, it } from "vitest";
import {
  DurableObjectMigrationReportSchema,
  isOpaqueDurableObjectName,
} from "./durable-object-migrations";

const WORKSPACE = "0192f3a0-1c4d-7000-8000-0000000000a1";
const WORKSTREAM = "0192f3a0-1c4d-7000-8000-0000000000a2";
const BLOCK = "0192f3a0-1c4d-7000-8000-0000000000a3";

describe("isOpaqueDurableObjectName", () => {
  it("accepts every name shape apps/api mints", () => {
    for (const name of [
      `global:${WORKSPACE}`,
      `eu:${WORKSPACE}:${WORKSTREAM}`,
      `eu:${WORKSPACE}:${WORKSTREAM}:0`,
      `eu:${WORKSPACE}:${WORKSTREAM}:${BLOCK}`,
      `global:${WORKSPACE}:${WORKSTREAM}:block-dashboard:${BLOCK}`,
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
