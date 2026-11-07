import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";

import { EngineeringSqlLookupSchema } from "./engineering-inspection";

const WORKSPACE = "3f2504e0-4f89-41d3-9a0c-0305e82c3311";
const WORKSTREAM = "3f2504e0-4f89-41d3-9a0c-0305e82c3312";

const RESULT = { columns: ["answer"], rows: [{ answer: 1 }], rowsRead: 1, rowsWritten: 0 };

/**
 * The shape of a result is a deployment contract, not only a type.
 *
 * The MCP Worker parses every regional SQL response through this schema and
 * deploys *after* the regional Workers, so for the length of each rollout an
 * upgraded bridge answers an MCP running the previous build of it. These are
 * the two halves of surviving that window.
 */
describe("engineering SQL result wire compatibility", () => {
  it("accepts a result that omits every per-object-kind id", () => {
    // What `run_workspace_sql` and `run_canvas_sql`
    // send. Byte-identical to what a build predating the Sidekick and artifact
    // tools expects, which is the whole point of omitting rather than nulling.
    expect(EngineeringSqlLookupSchema.parse({
      found: true,
      value: {
        region: "global",
        workspaceId: WORKSPACE,
        workstreamId: WORKSTREAM,
        substreamId: "0",
        result: RESULT,
      },
    })).toMatchObject({ found: true });
  });

});
