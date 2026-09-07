import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ write: vi.fn(), query: vi.fn(), namespaces: [] as string[] }));
vi.mock("@turbopuffer/turbopuffer", () => ({
  Turbopuffer: class {
    namespace(name: string) { provider.namespaces.push(name); return provider; }
  },
}));

import { asWorkspaceId } from "@rally/contracts";
import { createTestEnv } from "./helpers/cloudflare-test";
import { indexSemanticBatch, searchEmbeddingJobs } from "../src/services/search-indexing-pipeline";
import { literalSubstringPattern, searchContentHash, TextSearchIndex, TextSearchModeSchema, workspaceSearchIndex } from "../src/services/text-search";

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

  it("keeps pre-fan-out semantic namespaces readable without hiding other provider errors", async () => {
    const missing = Object.assign(new Error('attribute "generation" not found in schema'), { status: 400 });
    provider.query.mockRejectedValueOnce(missing).mockResolvedValueOnce({ rows: [] });
    const sources = [{ source: "note", scopeIds: ["private"], load: async () => new Map() }];
    expect(await index.query(sources, { query: "topic", mode: "semantic", limit: 10, vector: [1, 0] })).toEqual([]);
    expect(provider.query.mock.calls[1]![0].include_attributes).not.toContain("generation");
    provider.query.mockRejectedValueOnce(Object.assign(new Error("unrelated bad request"), { status: 400 }));
    await expect(index.query(sources, { query: "topic", mode: "semantic", limit: 10, vector: [1, 0] }))
      .rejects.toThrow("search_index_query_failed");
    expect(provider.query).toHaveBeenCalledTimes(3);
  });

  it("escapes glob operators in literal substring input", () => {
    expect(literalSubstringPattern("a*b? [c] {d} \\e")).toBe("*a\\*b\\? \\[c\\] \\{d\\} \\\\e*");
  });
});

describe("semantic indexing", () => {
  const index = new TextSearchIndex({ apiKey: "test", region: "gcp-us-west1", namespace: "test" });
  const reference = { type: "resource_search_projection_v1" as const, region: "global" as const,
    workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000001"), resourceId: "00000000-0000-7000-8000-000000000002" };
  const document = { id: "test-document", source: "note", sourceId: "n1", scopeId: "private", revision: 3, text: "alpha\n\nbeta\n\ngamma" };
  const policy = { maxTokens: 12, overlapTokens: 4, countTokens: (text: string) => text.length };
  const load = async () => ({ documents: [document], retry: false });
  const vectors = (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 1));
  beforeEach(() => {
    vi.resetAllMocks();
    provider.write.mockResolvedValue({});
    provider.query.mockResolvedValue({ aggregations: { count: 0 } });
  });

  it.each(["qwen/qwen3-embedding-8b", "Qwen/Qwen3-Embedding-8B"])("writes both chunk strategies for %s with source authority", async (model) => {
    const [job] = await searchEmbeddingJobs(reference, document, policy);
    await indexSemanticBatch(index, job!, load, async (texts) => ({ model, vectors: vectors(texts) }));
    expect(provider.write).toHaveBeenCalledWith(expect.objectContaining({
      upsert_rows: expect.arrayContaining([
        expect.objectContaining({ source: "note", source_id: "n1", scope_id: "private", revision: 3,
          generation: job!.generation, record_type: "chunk", chunk_strategies: ["recursive"] }),
        expect.objectContaining({ record_type: "chunk", chunk_strategies: ["sliding_window"] }),
      ]),
    }));
  });

  it("distinguishes canonical UTF-16 text that UTF-8 would collapse", async () => {
    expect(await searchContentHash("\ud800")).not.toBe(await searchContentHash("\ufffd"));
    expect(await searchContentHash("é")).not.toBe(await searchContentHash("e\u0301"));
  });

  it("fans out a document across the approved batch boundary with all source ranges", async () => {
    const long = { ...document, text: "a".repeat(65) };
    const jobs = await searchEmbeddingJobs(reference, long, { maxTokens: 1, overlapTokens: 0, countTokens: (text) => text.length });
    expect(jobs.map((job) => job.spans.length)).toEqual([64, 1]);
    expect(jobs.flatMap((job) => job.spans).map(({ start, end }) => long.text.slice(start, end)).join("")).toBe(long.text);
    expect(jobs.every((job) => job.totalChunks === 65)).toBe(true);
    expect(JSON.stringify(jobs)).not.toContain(long.text);
  });

  it("pairs each vector with its source range and retires only after the final chunk count", async () => {
    const [job] = await searchEmbeddingJobs(reference, document, policy);
    provider.query.mockResolvedValueOnce({ aggregations: { count: 0 } })
      .mockResolvedValueOnce({ aggregations: { count: job!.totalChunks } });
    const embed = vi.fn(async (texts: string[]) => ({ model: "Qwen/Qwen3-Embedding-8B",
      vectors: texts.map((_text, i) => Array.from({ length: 1024 }, () => i)) }));
    await indexSemanticBatch(index, job!, load, embed);
    expect(embed).toHaveBeenCalledWith(job!.spans.map(({ start, end }) => document.text.slice(start, end)));
    expect(provider.write).toHaveBeenCalledWith(expect.objectContaining({
      upsert_rows: job!.spans.map((span, i) => expect.objectContaining({
        chunk_start: span.start, chunk_end: span.end, vector: Array.from({ length: 1024 }, () => i),
      })),
    }));
    expect(provider.write).toHaveBeenLastCalledWith(expect.objectContaining({ delete_by_filter:
      ["And", expect.arrayContaining([["Or", expect.arrayContaining([["revision", "Lt", document.revision]])]])] }));
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({ consistency: { level: "strong" },
      filters: ["And", expect.arrayContaining([["generation", "Eq", job!.generation]])] }));
  });

  it.each(["missing", "extra", "dimension", "nonfinite", "model"])("rejects a %s batch without writing its chunks or retiring the previous generation", async (failure) => {
    const [job] = await searchEmbeddingJobs(reference, document, policy);
    await expect(indexSemanticBatch(index, job!, load, async (texts) => {
      const result = vectors(texts);
      if (failure === "missing") result.pop();
      if (failure === "extra") result.push(Array.from({ length: 1024 }, () => 1));
      if (failure === "dimension") result[0]!.pop();
      if (failure === "nonfinite") result[0]![0] = Number.NaN;
      return { model: failure === "model" ? "different-model" : "Qwen/Qwen3-Embedding-8B", vectors: result };
    })).rejects.toThrow("search_embedding_space_mismatch");
    expect(provider.write).not.toHaveBeenCalled();
  });

  it("skips completed provider work on redelivery and leaves incomplete generations alone", async () => {
    const [job] = await searchEmbeddingJobs(reference, document, policy);
    provider.query.mockResolvedValueOnce({ aggregations: { count: job!.spans.length } })
      .mockResolvedValueOnce({ aggregations: { count: job!.totalChunks - 1 } });
    const embed = vi.fn();
    await indexSemanticBatch(index, job!, load, embed);
    expect(embed).not.toHaveBeenCalled();
    expect(provider.write).not.toHaveBeenCalled();
  });

  it("rejects equal-revision content changes before embedding", async () => {
    const [job] = await searchEmbeddingJobs(reference, document, policy);
    const embed = vi.fn();
    await indexSemanticBatch(index, job!, async () => ({ documents: [{ ...document, text: "changed" }], retry: false }), embed);
    expect(embed).not.toHaveBeenCalled();
    expect(provider.write).toHaveBeenCalledWith(expect.objectContaining({ delete_by_filter:
      ["And", expect.arrayContaining([["generation", "Eq", job!.generation]])] }));
  });

  it("does not enqueue blank semantic documents", async () => {
    expect(await searchEmbeddingJobs(reference, { ...document, text: " \n\t" }, policy)).toEqual([]);
  });

  it("issues only ANN for semantic search and only BM25 for full-text search", async () => {
    provider.query.mockResolvedValue({ rows: [] });
    const sources = [{ source: "note", scopeIds: ["private"], load: async () => new Map() }];
    await index.query(sources, { query: "topic", mode: "semantic", limit: 10, vector: [1, 0] });
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({ rank_by: ["vector", "ANN", [1, 0]] }));
    await index.query(sources, { query: "topic", mode: "text", limit: 10 });
    expect(provider.query).toHaveBeenLastCalledWith(expect.objectContaining({ rank_by: ["text", "BM25", "topic"] }));
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
});


describe("search namespace identity", () => {
  it("keeps namespace identity stable and separates workspaces within provider name limits", async () => {
    provider.namespaces.length = 0;
    const env = createTestEnv({ APP_ENV: "development", AVALON_REGION: "global", TURBO_PUFFER_DEV_API_KEY: "test-only" });
    await workspaceSearchIndex(env, "workspace-one");
    await workspaceSearchIndex(env, "workspace-one");
    await workspaceSearchIndex(env, "workspace-two");
    const [semantic, lexical, changedSemantic, sameLexical, otherSemantic, otherLexical] = provider.namespaces;
    // Characterize the former string-valued 512/128 policy. A changed namespace
    // requires an explicit migration decision, not just deterministic output.
    expect(semantic).toBe("rally-search-v3-semantic-84f27d3e97d5ef23fad29343a5be0e392746a5579c14c6ff083a708f71353eb1");
    expect(lexical).toBe("rally-search-v3-da354ca1830dc84c51690d8569b7121aaf6f9dc4d95809293012ff15add194f7-text");
    expect(semantic).toBe(changedSemantic);
    expect(lexical).toBe(sameLexical);
    expect(semantic).not.toBe(otherSemantic);
    expect(lexical).not.toBe(otherLexical);
    // https://turbopuffer.com/docs/write: the provider's namespace contract.
    for (const name of provider.namespaces) expect(name).toMatch(/^[A-Za-z0-9-_.]{1,128}$/u);
  });
});
