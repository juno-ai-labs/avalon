import { Turbopuffer } from "@turbopuffer/turbopuffer";
import type { Filter, RankBy } from "@turbopuffer/turbopuffer";
import { z } from "zod";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import type { SearchDocumentDisplay } from "./search-document";
import { MEMORY_EMBEDDING_MODEL } from "./structured-inference";
import { SEARCH_CHUNK_MAX_TOKENS, SEARCH_CHUNK_OVERLAP_TOKENS } from "./semantic-chunks";

export const SEARCH_EMBEDDING_DIMENSIONS = 1_024;
export const SEARCH_CHUNK_ALGORITHM = "recursive-sliding-v1";
export const QWEN_MODEL_COMMIT = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";

const SEARCH_DOCUMENT_SCHEMA = {
  text: { type: "string", full_text_search: true, glob: true },
  source: { type: "string" },
  source_id: { type: "string" },
  scope_id: { type: "string" },
  substream_id: { type: "string" },
  revision: { type: "uint" },
  deleted: { type: "bool" },
  record_type: { type: "string" },
  generation: { type: "string" },
  chunk_start: { type: "uint" },
  chunk_end: { type: "uint" },
  chunk_strategies: { type: "[]string" },
  // Display attributes the read path renders without a canonical reload.
  // `title`, `source_label` and `archived` stay filterable because a display
  // patch addresses the rows that still carry the previous values.
  title: { type: "string" },
  source_label: { type: "string" },
  archived: { type: "bool" },
  url: { type: "string", filterable: false },
  mime_type: { type: "string", filterable: false },
  occurred_at: { type: "uint", filterable: false },
  transcript_sequence: { type: "uint", filterable: false },
} as const;

/** Every attribute a page needs to render and admit a candidate without a loader. */
const CANDIDATE_ATTRIBUTES = ["source", "source_id", "scope_id", "substream_id", "revision", "chunk_start", "chunk_end",
  "text", "title", "source_label", "archived", "url", "mime_type", "occurred_at", "transcript_sequence"] as const;

/** Separate deployments and embedding spaces; EU never falls back to Global. */
export async function workspaceSearchIndex(env: Env, workspaceId: string): Promise<TextSearchIndex> {
  const apiKey = env.APP_ENV === "production"
    ? env.TURBO_PUFFER_PROD_API_KEY : env.TURBO_PUFFER_DEV_API_KEY;
  if (!apiKey) throw new Error("search_credentials_unavailable");
  const space = await sha256Hex(JSON.stringify([
    env.APP_ENV, env.AVALON_REGION, workspaceId,
    MEMORY_EMBEDDING_MODEL, SEARCH_EMBEDDING_DIMENSIONS,
  ]));
  const semanticSpace = await sha256Hex(JSON.stringify([
    space, SEARCH_CHUNK_ALGORITHM, QWEN_MODEL_COMMIT,
    // Keep the former environment-string encoding; changing it requires semantic backfill.
    String(SEARCH_CHUNK_MAX_TOKENS), String(SEARCH_CHUNK_OVERLAP_TOKENS),
  ]));
  return new TextSearchIndex({
    apiKey,
    // https://turbopuffer.com/docs/regions, verified 2026-09-04.
    region: env.AVALON_REGION === "eu" ? "gcp-europe-west1" : "gcp-us-west1",
    namespace: `rally-search-v3-${space}`,
    semanticNamespace: `rally-search-v3-semantic-${semanticSpace}`,
  });
}

/** Queued offsets must never be interpreted under a different embedding policy. */
export function searchChunkIdentity(): string {
  return JSON.stringify([SEARCH_CHUNK_ALGORITHM, QWEN_MODEL_COMMIT, MEMORY_EMBEDDING_MODEL,
    SEARCH_EMBEDDING_DIMENSIONS, SEARCH_CHUNK_MAX_TOKENS, SEARCH_CHUNK_OVERLAP_TOKENS]);
}

/** JSON escaping preserves lone UTF-16 surrogates that UTF-8 alone would replace. */
export function searchContentHash(text: string): Promise<string> {
  return sha256Hex(JSON.stringify(text));
}

export function searchDocumentId(source: string, scopeId: string, sourceId: string): Promise<string> {
  return sha256Hex(JSON.stringify([source, scopeId, sourceId]));
}

/** Product surfaces choose sources; this module never decides who may read them. */
export const TextSearchModeSchema = z.enum(["text", "substring", "semantic"]);
export type TextSearchMode = z.infer<typeof TextSearchModeSchema>;

export interface TextSearchDocument {
  id: string;
  source: string;
  sourceId: string;
  scopeId: string;
  substreamId?: string | undefined;
  revision: number;
  text: string;
  vector?: number[];
  /** Hash of the complete canonical text for independently delivered chunks. */
  generation?: string;
  chunk?: { start: number; end: number; strategies: string[] };
  display?: SearchDocumentDisplay | undefined;
}

/**
 * A row as the index returns it. Display attributes are optional because rows
 * written before they existed, and deletion watermarks, carry none; a caller
 * that needs them omits such a row rather than reloading its source.
 */
const CandidateSchema = z.object({
  id: z.string(),
  source: z.string(),
  source_id: z.string(),
  scope_id: z.string(),
  substream_id: z.string().nullable().optional(),
  revision: z.number().int().nonnegative(),
  generation: z.string().nullable().optional(),
  chunk_start: z.number().int().nonnegative().nullable().optional(),
  chunk_end: z.number().int().nonnegative().nullable().optional(),
  text: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  source_label: z.string().nullable().optional(),
  archived: z.boolean().nullable().optional(),
  url: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  occurred_at: z.number().int().nonnegative().nullable().optional(),
  transcript_sequence: z.number().int().positive().nullable().optional(),
});
export type TextSearchCandidate = z.infer<typeof CandidateSchema>;

/** The display a conversation's rows carry; patched in place when the conversation changes. */
export interface ConversationDisplay { title: string; archived: boolean }

/** Created by a source's authority resolver, never deserialized from a request. */
export interface AuthorizedSearchSource<T> {
  source: string;
  /** null searches this workspace namespace; load must authorize every candidate. */
  scopeIds: readonly string[] | null;
  /** Admit the candidates after the external search await and build results from their attributes. */
  load: (candidates: readonly TextSearchCandidate[]) => Promise<ReadonlyMap<string, T>>;
}

export interface TextSearchOptions {
  query: string;
  mode: TextSearchMode;
  limit: number;
  vector?: number[];
  signal?: AbortSignal;
  onTiming?: (phase: "retrieval" | "hydration", durationMs: number) => void;
}

/** Escape syntax so a person's substring is always literal, including * and ?. */
export function literalSubstringPattern(text: string): string {
  return `*${text.replace(/[\\*?[\]{}]/g, "\\$&")}*`;
}

export function searchRanking(options: TextSearchOptions): RankBy {
  if (options.mode === "semantic") {
    if (!options.vector) throw new Error("search_embedding_required");
    return ["vector", "ANN", options.vector];
  }
  return options.mode === "substring" ? ["id", "asc"] : ["text", "BM25", options.query];
}

/** The sole Turbopuffer boundary. Credentials and namespace stay on the server. */
export class TextSearchIndex {
  private readonly namespace;
  private readonly lexicalNamespace;

  constructor(config: { apiKey: string; region: string; namespace: string; semanticNamespace?: string }) {
    const client = new Turbopuffer({
      apiKey: config.apiKey,
      region: config.region,
    });
    this.namespace = client.namespace(config.semanticNamespace ?? `${config.namespace}-semantic`);
    this.lexicalNamespace = client.namespace(`${config.namespace}-text`);
  }

  async upsert(documents: readonly TextSearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const lexical = documents.filter((document) => !document.chunk);
    const semantic = documents.filter((document) => document.chunk);
    if (lexical.length && semantic.length) {
      await this.upsert(lexical);
      await this.upsert(semantic);
      return;
    }
    const isSemantic = semantic.length > 0;
    if (isSemantic && semantic.some((document) => !document.vector)) throw new Error("search_embedding_required");
    await (isSemantic ? this.namespace : this.lexicalNamespace).write({
      ...(isSemantic ? { distance_metric: "cosine_distance" as const } : {}),
      schema: SEARCH_DOCUMENT_SCHEMA,
      upsert_rows: documents.map((document) => ({
        id: document.id,
        source: document.source,
        source_id: document.sourceId,
        scope_id: document.scopeId,
        substream_id: document.substreamId ?? null,
        revision: document.revision,
        text: document.text,
        ...(isSemantic ? { vector: document.vector! } : {}),
        generation: document.generation ?? null,
        deleted: false,
        record_type: document.chunk ? "chunk" : "document",
        chunk_start: document.chunk?.start ?? null,
        chunk_end: document.chunk?.end ?? null,
        chunk_strategies: document.chunk?.strategies ?? [],
        title: document.display?.title ?? null,
        source_label: document.display?.sourceLabel ?? null,
        archived: document.display?.archived ?? null,
        url: document.display?.url ?? null,
        mime_type: document.display?.mimeType ?? null,
        occurred_at: document.display?.occurredAt ?? null,
        transcript_sequence: document.display?.transcriptSequence ?? null,
      })),
      upsert_condition: ["Or", [
        ["revision", "Lt", { $ref_new: "revision" }],
        ["And", [["revision", "Eq", { $ref_new: "revision" }], ["deleted", "Eq", false]]],
      ]],
    }).catch(() => { throw new Error("search_index_write_failed"); });
  }

  /** Reclaim obsolete vectors; canonical source checks still fence racing writes. */
  async removeSemanticGenerations(document: Pick<TextSearchDocument, "source" | "scopeId" | "sourceId" | "revision">,
    comparison: "Lt" | "Lte", includeLegacyCurrent = false): Promise<void> {
    await this.deleteSemanticRows(["And", [
      ["source", "Eq", document.source], ["scope_id", "Eq", document.scopeId],
      ["source_id", "Eq", document.sourceId],
      includeLegacyCurrent ? ["Or", [["revision", comparison, document.revision],
        ["And", [["revision", "Eq", document.revision], ["generation", "Eq", null]]]]]
        : ["revision", comparison, document.revision],
    ]]);
  }

  private async deleteSemanticRows(filter: Filter): Promise<void> {
    try {
      await this.namespace.write({ schema: SEARCH_DOCUMENT_SCHEMA, delete_by_filter: filter });
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404) return;
      // Live API, 2026-09-06: delete filters see the schema before this write.
      // Existing pre-fan-out namespaces need a separate schema initialization.
      if (error instanceof Error && "status" in error && error.status === 400
        && error.message.includes("filter error in key `generation`: attribute not found")) {
        try {
          await this.namespace.write({ schema: SEARCH_DOCUMENT_SCHEMA });
          await this.namespace.write({ delete_by_filter: filter });
          return;
        } catch { throw new Error("search_index_write_failed"); }
      }
      throw new Error("search_index_write_failed", { cause: error });
    }
  }

  /** Persisted batch IDs make duplicate deliveries receipts, without a separate ledger. */
  async countSemanticChunks(document: Pick<TextSearchDocument, "source" | "scopeId" | "sourceId" | "revision">,
    ids: string[]): Promise<number> {
    const result = await this.namespace.query({
      aggregate_by: { count: ["Count"] },
      filters: ["And", [
        ["source", "Eq", document.source], ["scope_id", "Eq", document.scopeId],
        ["source_id", "Eq", document.sourceId], ["revision", "Eq", document.revision],
        ["record_type", "Eq", "chunk"], ["deleted", "Eq", false],
        ["id", "In", ids],
      ]],
      consistency: { level: "strong" },
    }).catch((error: unknown) => {
      if (error instanceof Error && "status" in error && error.status === 404) return { aggregations: { count: 0 } };
      throw new Error("search_index_query_failed");
    });
    return z.object({ count: z.number().int().nonnegative() }).parse(result.aggregations).count;
  }

  /** Never delete a newer generation when an old batch finishes late. */
  async removeSemanticGeneration(document: Pick<TextSearchDocument, "source" | "scopeId" | "sourceId" | "revision">,
    generation: string): Promise<void> {
    await this.deleteSemanticRows(["And", [
      ["source", "Eq", document.source], ["scope_id", "Eq", document.scopeId],
      ["source_id", "Eq", document.sourceId], ["revision", "Eq", document.revision],
      ["generation", "Eq", generation],
    ]]);
  }

  /**
   * A conversation's title or archive state changed: patch every live row that
   * still shows the previous values. Each pass excludes the rows it patched, so
   * the loop ends on its own once the conversation's rows agree, however many
   * there are; a row with no display yet is left for its backfill rewrite.
   */
  async patchConversationDisplay(conversation: { scopeId: string; substreamId: string },
    display: ConversationDisplay): Promise<number> {
    let patched = 0;
    const passes: Array<{ source: string; stale: Filter; patch: Record<string, string | boolean> }> = [
      { source: "messages", patch: { title: display.title, source_label: display.title, archived: display.archived },
        stale: ["Or", [["title", "NotEq", display.title], ["source_label", "NotEq", display.title], ["archived", "NotEq", display.archived]]] },
      { source: "conversation_links", patch: { source_label: display.title, archived: display.archived },
        stale: ["Or", [["source_label", "NotEq", display.title], ["archived", "NotEq", display.archived]]] },
    ];
    for (const pass of passes) {
      for (;;) {
        const result = await this.lexicalNamespace.write({
          patch_by_filter: { filters: ["And", [["source", "Eq", pass.source], ["scope_id", "Eq", conversation.scopeId],
            ["substream_id", "Eq", conversation.substreamId], ["deleted", "Eq", false], ["record_type", "Eq", "document"],
            pass.stale]], patch: pass.patch },
          // The provider patches a bounded number of rows per request; the
          // next pass picks up the rest because patched rows no longer match.
          patch_by_filter_allow_partial: true,
        }).catch((error: unknown) => {
          // A namespace does not exist until its first write; nothing to patch.
          if (error instanceof Error && "status" in error && error.status === 404) return { rows_patched: 0 };
          throw new Error("search_index_write_failed");
        });
        const rows = result.rows_patched ?? 0;
        patched += rows;
        if (rows === 0) break;
      }
    }
    return patched;
  }

  /** Keep a version watermark so a delayed upsert cannot resurrect deleted text. */
  async remove(id: string, revision: number): Promise<void> {
    await this.lexicalNamespace.write({
      schema: SEARCH_DOCUMENT_SCHEMA,
      upsert_rows: [{
        id, revision, deleted: true,
      }],
      upsert_condition: ["revision", "Lte", { $ref_new: "revision" }],
    }).catch(() => { throw new Error("search_index_write_failed"); });
  }

  async query<T>(
    sources: readonly AuthorizedSearchSource<T>[],
    options: TextSearchOptions,
  ): Promise<T[]> {
    return (await this.readPage(sources, options)).results;
  }

  /** One candidate page; the caller can continue past rejected rows without blocking first paint. */
  async queryPage<T>(sources: readonly AuthorizedSearchSource<T>[], options: TextSearchOptions, cursor?: string) {
    return this.readPage(sources, options, cursor);
  }

  private async readPage<T>(sources: readonly AuthorizedSearchSource<T>[], options: TextSearchOptions,
    cursor?: string): Promise<{ results: T[]; nextCursor: string | null }> {
    const authorized = sources.filter((source) => source.scopeIds === null || source.scopeIds.length > 0);
    if (authorized.length === 0) return { results: [], nextCursor: null };
    const filters: Filter = ["And", [["deleted", "Eq", false],
      ["record_type", "Eq", options.mode === "semantic" ? "chunk" : "document"],
      // Member search renders from the row, and an archived row or one written
      // before the display attributes existed is never rendered. Excluding them
      // here keeps them from consuming the candidate page; a null `archived`
      // does not match `Eq false`, so pre-rewrite rows are excluded too.
      ...(options.mode === "substring" ? [["archived", "Eq", false] as Filter] : []),
      ["Or", authorized.map((source): Filter => ["And", [
      ["source", "Eq", source.source],
      ...(source.scopeIds === null ? [] : [["scope_id", "In", [...source.scopeIds]] as Filter]),
    ]])]]];
    const values: T[] = [];
    const afterId = cursor;
    options.signal?.throwIfAborted();
    const pageFilters: Filter[] = [filters];
    if (options.mode === "substring") pageFilters.push(["text", "IGlob", literalSubstringPattern(options.query)]);
    if (afterId !== undefined) pageFilters.push(["id", "Gt", afterId]);
    const namespace = options.mode === "semantic" ? this.namespace : this.lexicalNamespace;
    const query = (includeGeneration: boolean) => namespace.query({
      filters: ["And", pageFilters],
      include_attributes: [...CANDIDATE_ATTRIBUTES, ...includeGeneration ? ["generation"] : []],
      rank_by: searchRanking(options),
      limit: options.limit,
      consistency: { level: "strong" },
    }, ...options.signal ? [{ signal: options.signal }] as const : []);
    const retrievalStarted = performance.now();
    const result = await query(options.mode === "semantic").catch((error: unknown) => {
      // Pre-fan-out namespaces have no generation attribute until their first
      // new write. Preserve their existing revision-based retrieval contract.
      if (options.mode === "semantic" && error instanceof Error && "status" in error && error.status === 400
        && error.message.includes('attribute "generation" not found in schema')) return query(false);
      throw error;
    }).catch((error: unknown) => {
      // A namespace does not exist until its first write.
      if (error instanceof Error && "status" in error && error.status === 404) return { rows: [] };
      // A namespace with no write since the display attributes shipped lacks
      // them in its schema, so the provider refuses to return or filter on
      // them (verified live: `attribute "x" not found in schema` for
      // include_attributes, `filter error in key \`x\`: attribute not found`
      // for filters). None of its rows carries a display to render.
      if (options.mode === "substring" && error instanceof Error && "status" in error && error.status === 400
        && /attribute (?:"[^"]*" )?not found/.test(error.message)) return { rows: [] };
      throw new Error("search_index_query_failed");
    });
    options.signal?.throwIfAborted();
    options.onTiming?.("retrieval", performance.now() - retrievalStarted);
    const hydrationStarted = performance.now();
    const candidates = z.array(CandidateSchema).parse(result.rows ?? []);
    // Index metadata is never authority, including on continuation pages.
    const loaded = await Promise.all(authorized.map(async (source) => {
      const scopes = source.scopeIds === null ? null : new Set(source.scopeIds);
      return source.load(candidates.filter((row) =>
        row.source === source.source && (scopes === null || scopes.has(row.scope_id))));
    }));
    options.onTiming?.("hydration", performance.now() - hydrationStarted);
    const rows = new Map(loaded.flatMap((items) => [...items]));
    for (const candidate of candidates) {
      const row = rows.get(candidate.id);
      if (row !== undefined) { values.push(row); }
    }
    const nextCursor = candidates.length === options.limit && options.mode === "substring" ? candidates.at(-1)!.id : null;
    if (nextCursor !== null && afterId !== undefined && nextCursor <= afterId) throw new Error("search_index_cursor_invalid");
    // One candidate batch per call. Continuation is a position, never an access grant.
    return { results: values.slice(0, options.limit), nextCursor };
  }
}
