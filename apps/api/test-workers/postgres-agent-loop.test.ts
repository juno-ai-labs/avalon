import type { MaterializedRun } from "@avalon/postgres";
import { describe, expect, it } from "vitest";

import { materializedRunMessages } from "../src/workflows/postgres-agent-loop";

function run(parts: MaterializedRun["parts"]): MaterializedRun {
  return {
    version: 1,
    run_id: "018f3000-0000-7000-8000-000000000001",
    workspace_id: "018f3000-0000-7000-8000-000000000002",
    workstream_id: "018f3000-0000-7000-8000-000000000003",
    substream_id: "018f3000-0000-7000-8000-000000000004",
    run_revision: 1,
    control_revision: 1,
    workspace_access_revision: 1,
    workstream_access_revision: 1,
    substream_access_revision: 1,
    scope_revision: 1,
    model_provider: "openrouter",
    model_name: "model",
    execution_principal_kind: "user",
    execution_principal_id: "018f3000-0000-7000-8000-000000000005",
    provider_config_revision: 1,
    compaction: null,
    parts,
  };
}

describe("Postgres agent-loop materialization", () => {
  it("projects an atomic tool exchange into provider-valid adjacent messages", () => {
    const messages = materializedRunMessages(run([
      {
        id: "018f3000-0000-7000-8000-000000000101",
        turn_id: "018f3000-0000-7000-8000-000000000201",
        seq: 1,
        ordinal_in_turn: 0,
        role: "user",
        kind: "text",
        text: "Read the file",
        content_hash: "01".repeat(32),
      },
      {
        id: "018f3000-0000-7000-8000-000000000102",
        turn_id: "018f3000-0000-7000-8000-000000000202",
        seq: 2,
        ordinal_in_turn: 0,
        role: "assistant",
        kind: "tool_call",
        provider_call_id: "call-1",
        structured_payload: {
          tool_name: "read_file",
          plugin_id: "terminal",
          input: { path: "README.md" },
        },
        content_hash: "02".repeat(32),
      },
      {
        id: "018f3000-0000-7000-8000-000000000103",
        turn_id: "018f3000-0000-7000-8000-000000000202",
        seq: 3,
        ordinal_in_turn: 1,
        role: "tool",
        kind: "tool_result",
        provider_call_id: "call-1",
        related_part_id: "018f3000-0000-7000-8000-000000000102",
        structured_payload: {
          tool_name: "read_file",
          plugin_id: "terminal",
          succeeded: true,
          result: { text: "hello" },
        },
        content_hash: "03".repeat(32),
      },
    ]));

    expect(messages).toEqual([
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        }],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"text":"hello"}' },
    ]);
  });

  it("fails closed when a ready Storage reference has not been fetched", () => {
    expect(() => materializedRunMessages(run([{
      id: "018f3000-0000-7000-8000-000000000101",
      turn_id: "018f3000-0000-7000-8000-000000000201",
      seq: 1,
      ordinal_in_turn: 0,
      role: "user",
      kind: "attachment",
      content_ref_id: "018f3000-0000-7000-8000-000000000301",
      content_hash: "01".repeat(32),
    }]))).toThrow("materialized_content_ref_requires_storage_fetch");
  });
});
