import type { Pipeline } from "cloudflare:pipelines";
import { describe, expect, it } from "vitest";

import { writeAuditEvent } from "../src/audit-log";

const principal = { subject: "engineer-1", email: "engineer@rallywith.ai", audience: "engineering-mcp-audience" };

function recordingPipeline() {
  const rows: Record<string, unknown>[] = [];
  const pipeline: Pipeline = { send: async (records) => { rows.push(...records); } };
  return { rows, pipeline };
}

describe("writeAuditEvent", () => {
  it("refuses by name a row over the Pipeline's per-record limit, without sending it", async () => {
    const { rows, pipeline } = recordingPipeline();
    const sql = "x".repeat(1_000_001);

    await expect(writeAuditEvent({ ENGINEERING_AUDIT_LAKEHOUSE: pipeline }, principal, {
      event: "tool_call_started", tool: "run_d1_sql", callId: "call-1", arguments: { sql },
    })).rejects.toThrow("engineering_audit_row_too_large");
    expect(rows).toEqual([]);
  });

  it("sends a row under the limit", async () => {
    const { rows, pipeline } = recordingPipeline();

    await writeAuditEvent({ ENGINEERING_AUDIT_LAKEHOUSE: pipeline }, principal, {
      event: "tool_call_started", tool: "run_d1_sql", callId: "call-1", arguments: { sql: "x".repeat(900_000) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "tool_call_started", tool: "run_d1_sql", call_id: "call-1" });
  });
});
