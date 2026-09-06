import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ write: vi.fn(), query: vi.fn(), namespaces: [] as string[] }));
vi.mock("@turbopuffer/turbopuffer", () => ({
  Turbopuffer: class {
    namespace(name: string) { provider.namespaces.push(name); return provider; }
  },
}));

import { createTestEnv } from "./helpers/cloudflare-test";
import { indexSemanticDocument } from "../src/services/search-indexing-pipeline";
import { literalSubstringPattern, TextSearchIndex, TextSearchModeSchema, workspaceSearchIndex } from "../src/services/text-search";

// Turbopuffer is an external service. Its query semantics are checked separately
// with a disposable live namespace; these tests prove our authority boundary.
describe("text search authority boundary", () => {
  const index = new TextSearchIndex({ apiKey: "test", region: "gcp-us-west1", namespace: "test" });
  beforeEach(() => {
    vi.resetAllMocks();
    provider.write.mockResolvedValue({});
  });

  it("does not query without an authorized source", async () => {
    expect(await index.query([], { query: "secret", mode: "text", limit: 10 })).toEqual([]);
    expect(provider.query).not.toHaveBeenCalled();
  });

  it("rejects candidates outside the granted source and scopes before loading", async () => {
    const valid = { id: "allowed", source: "memory", source_id: "m1", scope_id: "personal", revision: 1 };
    provider.query.mockResolvedValue({ rows: [
      valid,
      { ...valid, id: "wrong-source", source: "message" },
      { ...valid, id: "wrong-scope", scope_id: "someone-else" },
    ] });
    const load = vi.fn(async () => new Map([["allowed", "canonical text"]]));
    expect(await index.query([{ source: "memory", scopeIds: ["personal"], load }], {
      query: "text", mode: "text", limit: 10,
    })).toEqual(["canonical text"]);
    expect(load).toHaveBeenCalledWith([valid]);
  });

  it("returns no stale indexed text when canonical authorization is revoked", async () => {
    provider.query.mockResolvedValue({ rows: [
      { id: "revoked", source: "message", source_id: "m1", scope_id: "room", revision: 1, text: "stale private text" },
    ] });
    expect(await index.query([{
      source: "message", scopeIds: ["room"], load: async () => new Map(),
    }], { query: "text", mode: "text", limit: 10 })).toEqual([]);
  });

  it("continues past a full page of revoked substring matches", async () => {
    const row = { source: "message", source_id: "m1", scope_id: "room", revision: 1 };
    provider.query.mockResolvedValueOnce({ rows: [{ ...row, id: "a" }, { ...row, id: "b" }] })
      .mockResolvedValueOnce({ rows: [{ ...row, id: "c" }, { ...row, id: "d" }] });
    const result = await index.query([{ source: "message", scopeIds: ["room"], load: async (candidates) =>
      new Map(candidates.filter((candidate) => candidate.id >= "c").map((candidate) => [candidate.id, candidate.id])),
    }], { query: "needle", mode: "substring", limit: 2 });
    expect(result).toEqual(["c", "d"]);
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: ["And", expect.arrayContaining([["id", "Gt", "b"]])],
    }));
  });

  it("rejects the removed hybrid mode", () => {
    expect(TextSearchModeSchema.safeParse("hybrid").success).toBe(false);
  });

  it("requires an embedding for semantic retrieval", async () => {
    await expect(index.query([{
      source: "message", scopeIds: ["room"], load: async () => new Map(),
    }], { query: "text", mode: "semantic", limit: 10 })).rejects.toThrow("search_embedding_required");
    expect(provider.query).not.toHaveBeenCalled();
  });

  it("escapes glob operators in literal substring input", () => {
    expect(literalSubstringPattern("a*b? [c] {d} \\e")).toBe("*a\\*b\\? \\[c\\] \\{d\\} \\\\e*");
  });
});

describe("semantic indexing", () => {
  const index = new TextSearchIndex({ apiKey: "test", region: "gcp-us-west1", namespace: "test" });
  beforeEach(() => {
    vi.resetAllMocks();
    provider.write.mockResolvedValue({});
  });
  const document = { id: "test-document", source: "note", sourceId: "n1", scopeId: "private", revision: 3, text: "alpha\n\nbeta\n\ngamma" };
  const policy = { maxTokens: 12, overlapTokens: 4, countTokens: (text: string) => text.length };

  it("writes both chunk strategies with the parent's authority and revision", async () => {
    const ids = await indexSemanticDocument(index, document, policy, async () => ({
      model: "qwen/qwen3-embedding-8b", vector: Array.from({ length: 1024 }, () => 1),
    }));
    expect(ids.length).toBeGreaterThan(1);
    expect(provider.write).toHaveBeenCalledWith(expect.objectContaining({
      upsert_rows: expect.arrayContaining([
        expect.objectContaining({
          source: "note", source_id: "n1", scope_id: "private", revision: 3,
          record_type: "chunk", chunk_strategies: ["recursive"],
        }),
        expect.objectContaining({ record_type: "chunk", chunk_strategies: ["sliding_window"] }),
      ]),
    }));
  });

  it("rejects model drift before writing any chunks", async () => {
    await expect(indexSemanticDocument(index, document, policy, async () => ({
      model: "different-model", vector: Array.from({ length: 1024 }, () => 1),
    }))).rejects.toThrow("search_embedding_space_mismatch");
    expect(provider.write).not.toHaveBeenCalled();
  });

  it("issues only ANN for semantic search and only BM25 for full-text search", async () => {
    provider.query.mockResolvedValue({ rows: [] });
    const sources = [{ source: "note", scopeIds: ["private"], load: async () => new Map() }];
    await index.query(sources, { query: "topic", mode: "semantic", limit: 10, vector: [1, 0] });
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({
      rank_by: ["vector", "ANN", [1, 0]],
      filters: ["And", expect.arrayContaining([["And", expect.arrayContaining([["record_type", "Eq", "chunk"]])]])],
    }));
    await index.query(sources, { query: "topic", mode: "text", limit: 10 });
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({
      rank_by: ["text", "BM25", "topic"],
      filters: ["And", expect.arrayContaining([["And", expect.arrayContaining([["record_type", "Eq", "document"]])]])],
    }));
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
});


describe("search namespace identity", () => {
  it("keeps namespace identity stable and separates workspaces within provider name limits", async () => {
    provider.namespaces.length = 0;
    const env = createTestEnv({ TURBO_PUFFER_DEV_API_KEY: "test-only" });
    await workspaceSearchIndex(env, "workspace-one");
    await workspaceSearchIndex(env, "workspace-one");
    await workspaceSearchIndex(env, "workspace-two");
    const [semantic, lexical, changedSemantic, sameLexical, otherSemantic, otherLexical] = provider.namespaces;
    expect(semantic).toBe(changedSemantic);
    expect(lexical).toBe(sameLexical);
    expect(semantic).not.toBe(otherSemantic);
    expect(lexical).not.toBe(otherLexical);
    // https://turbopuffer.com/docs/write: the provider's namespace contract.
    for (const name of provider.namespaces) expect(name).toMatch(/^[A-Za-z0-9-_.]{1,128}$/u);
  });
});
