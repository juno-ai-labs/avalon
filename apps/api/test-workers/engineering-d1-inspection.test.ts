/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";

const TEST_ENV: Env = env;

beforeEach(async () => {
  await reset();
  await env.TELEMETRY_DB.prepare("CREATE TABLE inspected (id INTEGER PRIMARY KEY, label TEXT, payload BLOB)").run();
});

describe("engineering inspection of a D1 database", () => {
  it("writes and reads the named binding's database, BLOBs included", async () => {
    const inspection = new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);

    await expect(inspection.runD1Sql({
      database: "TELEMETRY_DB",
      query: { sql: "INSERT INTO inspected (id, label, payload) VALUES (?, ?, X'0102FF')", bindings: [1, "first"] },
    })).resolves.toMatchObject({
      region: "global",
      database: "TELEMETRY_DB",
      result: { rows: [], rowsWritten: 1 },
    });

    await expect(inspection.runD1Sql({
      database: "TELEMETRY_DB",
      query: { sql: "SELECT id, label, payload FROM inspected", bindings: [] },
    })).resolves.toMatchObject({
      region: "global",
      database: "TELEMETRY_DB",
      result: {
        columns: ["id", "label", "payload"],
        rows: [{ id: 1, label: "first", payload: { type: "blob", base64: "AQL/" } }],
      },
    });

    const telemetry = await env.TELEMETRY_DB.prepare("SELECT label FROM inspected").all();
    expect(telemetry.results).toEqual([{ label: "first" }]);
    await expect(inspection.runD1Sql({
      database: "DB",
      query: { sql: "SELECT label FROM inspected", bindings: [] },
    })).rejects.toThrow(/no such table/);
  });

  it("refuses the audit database without running the statement", async () => {
    await env.AUDIT_DB.prepare("CREATE TABLE audited (id INTEGER PRIMARY KEY)").run();
    await env.AUDIT_DB.prepare("INSERT INTO audited (id) VALUES (1)").run();
    const inspection = new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);

    await expect(inspection.runD1Sql({
      database: "AUDIT_DB",
      query: { sql: "DELETE FROM audited", bindings: [] },
    } as never)).rejects.toThrow();

    const audit = await env.AUDIT_DB.prepare("SELECT id FROM audited").all();
    expect(audit.results).toEqual([{ id: 1 }]);
  });
});
