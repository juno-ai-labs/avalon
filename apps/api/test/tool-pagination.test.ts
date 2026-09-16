import { describe, expect, it, vi } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { formatToolArgumentValidationError } from "@rally/agent-harness";
import type { HarnessTool, HarnessToolContext } from "@rally/agent-harness";
import { withToolPagination, type PaginationHost } from "../src/services/tool-pagination";

// Projection-only tests. Receipt lifecycle and RPC are tested on real workerd.
const context: HarnessToolContext = {
  workspaceId: "workspace", workstreamId: "room", harnessRunId: "run", toolCallId: "call", effectIntentId: "effect",
  executionPrincipal: { type: "workspace", workspaceId: asWorkspaceId("00000000-0000-4000-8000-000000000001") }, signal: new AbortController().signal,
};
function host(): PaginationHost {
  return { prefix: "workstream", connectionId: null, fence: { runId: "run", attemptId: "attempt", owner: "owner" }, receipts: {
    issuePage: vi.fn(async () => "workstream_quiet_amber_rapid_otter"),
    claimPage: vi.fn(async () => ({ inputJson: '{"cursor":"private","limit":7}' })),
  } };
}
function tool(name = "list_resources"): HarnessTool {
  return { definition: { name, description: "Read", capability: "workstream.resources.list", mode: "read", idempotency: "safe",
    pagination: { cursorParameter: "cursor" }, inputSchema: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" } } } },
    execute: vi.fn(async () => ({ output: { items: [{ cursor: "content, not pagination" }] }, summary: "done", pagination: { continuations: [] } })),
  };
}

describe("model-facing authored pagination", () => {
  it.each([
    {}, null, { pageId: null }, { pageId: 42 }, { pageId: "" },
    { pageId: "private-provider-token==" },
    { pageId: "slack_quiet_amber_rapid_otter" },
    { pageId: "google_2_quiet_amber_otter" },
    { pageId: "google_2_extra_quiet_amber_rapid_otter" },
    { pageId: "google_2_Quiet_amber_rapid_otter" },
    { pageId: "google_2_quiet_amber_rapid_otter\n" },
    { pageId: "google_2_quiet_amber_rapid_otter", limit: 10 },
  ])("rejects malformed page arguments with actionable, non-echoing guidance: %j", async (input) => {
    const authority = { ...host(), prefix: "google_2" };
    const source = tool();
    const next = withToolPagination(source, authority)[1]!;
    const error = next.validateInput!(input);
    expect(error).toBeTruthy();
    const message = formatToolArgumentValidationError(error!);
    expect(message).toContain('pageId must start with "google_2_"');
    expect(message).toContain("exactly four lowercase words separated by underscores");
    expect(message).toContain("Copy nextPageId exactly from a tool result");
    expect(message).toContain("do not invent or repair an ID");
    expect(message).toContain("If that field is null, stop");
    expect(message).toContain("call google_2_list_resources to start a new read");
    expect(message).not.toContain("private-provider-token");
    await expect(next.execute(input, context)).rejects.toThrow(error!);
    expect(authority.receipts.claimPage).not.toHaveBeenCalled();
    expect(source.execute).not.toHaveBeenCalled();
  });

  it("accepts an exact connection prefix and leaves issuance validation to the authority", async () => {
    const authority = { ...host(), prefix: "google_2" };
    const next = withToolPagination(tool(), authority)[1]!;
    const input = { pageId: "google_2_quiet_amber_rapid_otter" };
    expect(next.validateInput!(input)).toBeNull();
    vi.mocked(authority.receipts.claimPage).mockRejectedValue(new Error("page_id_invalid: restart the read"));
    await expect(next.execute(input, context)).rejects.toThrow("page_id_invalid");
    expect(authority.receipts.claimPage).toHaveBeenCalledWith(expect.objectContaining(input));
  });

  it("explains the correct source field for forward and backward resource reads", () => {
    const [, next, previous] = withToolPagination(tool("read_resource"), host());
    expect(formatToolArgumentValidationError(next!.validateInput!({})!)).toContain("Copy nextPageId or readPageId exactly");
    expect(formatToolArgumentValidationError(previous!.validateInput!({})!)).toContain("Copy previousPageId exactly");
  });

  it("separates first and next arguments and reports an exhausted page", async () => {
    const source = tool();
    const [first, next] = withToolPagination(source, host());
    expect(first!.definition.inputSchema.properties).toEqual({ limit: { type: "integer" } });
    expect(next!.definition.inputSchema).toMatchObject({ required: ["pageId"], additionalProperties: false });
    await expect(first!.execute({ cursor: "private" }, context)).rejects.toThrow();
    await expect(next!.execute({ pageId: "workstream_quiet_amber_rapid_otter", limit: 10 }, context)).rejects.toThrow();
    expect(await next!.execute({ pageId: "workstream_quiet_amber_rapid_otter" }, context)).toEqual({
      output: { items: [{ cursor: "content, not pagination" }], nextPageId: null }, summary: "done",
    });
    expect(source.execute).toHaveBeenCalledWith({ cursor: "private", limit: 7 }, context);
  });

  it.each(["search_resource", "summarize_resource"])("projects only the explicit read slot for %s", async (name) => {
    const source = tool(name);
    source.definition.pagination!.sourceOnly = true;
    const citations = name === "summarize_resource";
    const field = citations ? "citations" : "passages";
    source.execute = async () => ({ output: { [field]: [{ text: "private" }] }, summary: "found", pagination: { continuations: [{
      operation: "read_resource", input: { cursor: "private" }, slot: "readPageId", ...(citations ? { citationIndex: 0 } : { passageIndex: 0 }),
    }] } });
    const authority = host();
    const tools = withToolPagination(source, authority);
    expect(tools).toHaveLength(1);
    expect(await tools[0]!.execute({}, context)).toEqual({ output: { [field]: [{ text: "private", readPageId: "workstream_quiet_amber_rapid_otter" }] }, summary: "found" });
    expect(authority.receipts.issuePage).toHaveBeenCalledWith(expect.objectContaining({ operation: "read_resource", slot: citations ? "citation:0" : "passage:0", inputJson: '{"cursor":"private"}' }));
  });

  it("keeps backwards reads separate and requires a resource on the first read", async () => {
    const source = tool("read_resource");
    source.definition.inputSchema.properties = { resourceId: { type: "string" }, cursor: { type: "string" } };
    const authority = host();
    const [first, next, previous] = withToolPagination(source, authority);
    await expect(first!.execute({}, context)).rejects.toThrow();
    await previous!.execute({ pageId: "workstream_quiet_amber_rapid_otter" }, context);
    expect(authority.receipts.claimPage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "read_resource_previous" }));
    await next!.execute({ pageId: "workstream_quiet_amber_rapid_otter" }, context);
    expect(authority.receipts.claimPage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "read_resource" }));
  });

  it("leaves a pass-through tool and its cursor-bearing output untouched", async () => {
    const source = tool("remote_list");
    delete source.definition.pagination;
    source.execute = async () => ({ output: { next_cursor: "provider-token" }, summary: "remote" });
    expect(withToolPagination(source, host())).toEqual([source]);
    expect(await source.execute({ cursor: "provider-token" }, context)).toEqual({ output: { next_cursor: "provider-token" }, summary: "remote" });
  });
});
