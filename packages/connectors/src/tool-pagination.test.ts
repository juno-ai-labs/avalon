import { describe, expect, it } from "vitest";
import { granolaPage, linearPage, nextCursorPage, notionPage, paginatedResult } from "./tool-pagination";
import { connectorObservationErrorCode } from "./observability";

describe("authored pagination extraction", () => {
  const opaque = "opaque+/=".repeat(10_000);
  const input = { query: "needle", limit: 7 };
  const project = (data: Record<string, unknown>) => ({ ...data, title: String(data.title).slice(0, 3) });

  it("extracts only declared continuation fields before bounding provider content", () => {
    const cases = [
      { result: linearPage("search", input, { title: "abcdef", pageInfo: { hasNextPage: true, endCursor: opaque } }, "page", project), parameter: "after" },
      { result: notionPage("search", input, { title: "abcdef", has_more: true, next_cursor: opaque }, "page", project), parameter: "startCursor" },
      { result: granolaPage("search", input, { title: "abcdef", hasMore: true, cursor: opaque }, "page", project), parameter: "cursor" },
      { result: nextCursorPage("search", input, { title: "abcdef", next_cursor: opaque, body: { cursor: "document data" } }, "page", project), parameter: "cursor" },
      { result: paginatedResult("search", input, { output: { title: "abc" }, summary: "page" }, "pageToken", opaque), parameter: "pageToken" },
    ];
    for (const { result, parameter } of cases) {
      expect(result.output).toMatchObject({ title: "abc" });
      expect(JSON.stringify(result.output)).not.toContain(opaque);
      expect(result.pagination).toEqual({ continuations: [{ operation: "search", slot: "nextPageId", input: { ...input, [parameter]: opaque } }] });
    }
    expect(cases[3]!.result.output).toMatchObject({ body: { cursor: "document data" } });
  });

  it("rejects a provider promising another page without its continuation", () => {
    expect(() => linearPage("search", input, { pageInfo: { hasNextPage: true, endCursor: null } }, "page", project)).toThrow("endCursor");
    expect(() => notionPage("search", input, { has_more: true, next_cursor: null }, "page", project)).toThrow("next_cursor");
    expect(() => granolaPage("search", input, { hasMore: true, cursor: null }, "page", project)).toThrow("cursor");
  });

  it("names malformed provider fields without exposing rejected data", () => {
    expect(() => notionPage("search", input, { has_more: true, next_cursor: 42 }, "page", project))
      .toThrow("pagination_response_invalid:next_cursor:invalid_type");
    expect(() => linearPage("search", input, { pageInfo: { hasNextPage: "secret" } }, "page", project))
      .toThrow("pagination_response_invalid:pageInfo.hasNextPage:invalid_type");
    try {
      granolaPage("search", input, { hasMore: true }, "page", project);
      expect.unreachable("a promised page without a cursor must fail");
    } catch (error) {
      expect(connectorObservationErrorCode(error)).toBe("schema_invalid:cursor:custom");
    }
  });
});
