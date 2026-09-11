import { describe, expect, it } from "vitest";
import { ignoredSearchDocumentKeys, SearchDocumentBatchSchema } from "../src/services/search-document";

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
    expect(ignoredSearchDocumentKeys(batch)).toEqual(["futureBatchField", "documents.futureField", "documents.display.futureDisplayField"]);
  });

  it("names nothing for a batch from a producer at or behind this build", () => {
    expect(ignoredSearchDocumentKeys({ documents: [document, { ...document, id: "d2", text: null, display: undefined }], retry: true })).toEqual([]);
    expect(ignoredSearchDocumentKeys(null)).toEqual([]);
  });

  it("still rejects a document whose known fields are malformed", () => {
    expect(() => SearchDocumentBatchSchema.parse({ documents: [{ ...document, revision: 0 }], retry: false })).toThrow();
    expect(() => SearchDocumentBatchSchema.parse({ documents: [{ ...document, display: { ...display, archived: "no" } }], retry: false })).toThrow();
  });
});
