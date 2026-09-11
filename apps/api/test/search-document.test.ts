import { describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  write: vi.fn(async () => ({})),
  query: vi.fn(async () => ({ rows: [], aggregations: { count: 0 } })),
}));
vi.mock("@turbopuffer/turbopuffer", () => ({ Turbopuffer: class { namespace() { return provider; } } }));

import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import { createTestEnv } from "./helpers/cloudflare-test";
import { ignoredSearchDocumentKeys, SearchDocumentBatchSchema } from "../src/services/search-document";
import { createSearchIndexingPipeline } from "../src/services/search-indexing-pipeline";

/**
 * A producer on a newer Worker build hands the consumer fields the consumer's
 * contract does not name for the minutes a deploy runs both versions. The
 * consumer must index what it understands rather than retry into the
 * dead-letter queue, because the source's publish intent is already cleared.
 */
describe("search document contract across Worker versions", () => {
  const display = { title: "Plan", sourceLabel: "Plan", occurredAt: 1, transcriptSequence: null, url: null, mimeType: null, archived: false };
  const document = { id: "d1", source: "files", sourceId: "r1", scopeId: "w1", revision: 2, text: "alpha", display };

  it("indexes a document carrying keys this build does not know instead of rejecting it", () => {
    const batch = { documents: [{ ...document, connectionId: "c1", futureField: { nested: true },
      display: { ...display, futureDisplayField: "x" } }], retry: false, futureBatchField: 1 };
    expect(SearchDocumentBatchSchema.parse(batch)).toEqual({
      documents: [{ ...document, connectionId: "c1" }], retry: false,
    });
    expect([...ignoredSearchDocumentKeys(batch)].sort()).toEqual(["documents.display.futureDisplayField", "documents.futureField", "futureBatchField"]);
  });

  it("names nothing for a batch from a producer at or behind this build", () => {
    expect(ignoredSearchDocumentKeys({ documents: [document, { ...document, id: "d2", text: null, display: undefined }], retry: true })).toEqual([]);
    // A key set to undefined carried nothing, so nothing was lost by dropping it.
    expect(ignoredSearchDocumentKeys({ documents: [{ ...document, futureField: undefined }], retry: false })).toEqual([]);
    expect(ignoredSearchDocumentKeys(null)).toEqual([]);
  });

  it("still rejects a document whose known fields are malformed", () => {
    expect(() => SearchDocumentBatchSchema.parse({ documents: [{ ...document, revision: 0 }], retry: false })).toThrow();
    expect(() => SearchDocumentBatchSchema.parse({ documents: [{ ...document, display: { ...display, archived: "no" } }], retry: false })).toThrow();
  });
});

/**
 * The 2026-09-10 retry log could not name a resource or a turn, which is why
 * that recovery had to re-project the whole fleet. The warning the document
 * phase emits when it strips a field is the signal the next skew window is
 * listed from, so it has to carry the source.
 */
describe("the document phase names what it dropped", () => {
  const env = createTestEnv({ APP_ENV: "development", AVALON_REGION: "global", TURBO_PUFFER_DEV_API_KEY: "test-only" });
  const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
  const resource = { type: "resource_search_projection_v1" as const, region: "global" as const,
    workspaceId, resourceId: "00000000-0000-7000-8000-000000000002" };
  const turn = { type: "search_projection_v1" as const, region: "global" as const, workspaceId,
    parentId: "00000000-0000-7000-8000-000000000003", substreamId: asSubstreamId("0"), turnId: "turn-1", revision: 2 };
  // A tombstone takes the delivery through both loads without planning chunks.
  const tombstone = { id: "d1", source: "files", sourceId: resource.resourceId, scopeId: workspaceId, revision: 2, text: null };
  // Not a literal at the call site, so the extra key is not an excess-property error.
  const skewed = { documents: [{ ...tombstone, futureField: 1 }], retry: false };
  const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((entry) => entry.event === "search_document_keys_ignored");

  it("logs the source and the stripped keys once per delivery, and nothing when nothing was stripped", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const indexSearch = createSearchIndexingPipeline(env);
      await indexSearch(resource, async () => skewed);
      expect(warnings(spy)).toEqual([expect.objectContaining({
        workspace_id: workspaceId, resource_id: resource.resourceId, ignored_keys: "documents.futureField" })]);
      spy.mockClear();
      await indexSearch(turn, async () => skewed);
      expect(warnings(spy)).toEqual([expect.objectContaining({
        workspace_id: workspaceId, parent_id: turn.parentId, substream_id: "0", turn_id: "turn-1", ignored_keys: "documents.futureField" })]);
      spy.mockClear();
      await indexSearch(resource, async () => ({ documents: [tombstone], retry: false }));
      expect(warnings(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
