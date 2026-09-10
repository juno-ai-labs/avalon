import { resolveMemorySearchAccess } from './memory-search-authorization';
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { asWorkspaceId, MEMORY_RECALL_QUERY_LIMIT } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { OpenRouterError, type HarnessTool, type HarnessToolResult } from "@rally/agent-harness";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceMemoryAddResultSchema,
  WorkspaceMemoryCandidateListSchema,
  WorkspaceMemoryItemForWriteResultSchema,
  WorkspaceMemoryItemListSchema,
  WorkspaceMemoryOutboxClaimResultSchema,
  WorkspaceMemoryOutboxDueListSchema,
  WorkspaceMemoryProjectionSourceResultSchema,
  WorkspaceMemoryReceiptResultSchema,
  WorkspaceMemoryScopeSchema,
  WorkspaceMemoryWriteResultSchema,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryOutboxRow,
} from "../durable-objects/workspace-memory-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { isMemoryEmbeddingModel, MEMORY_EMBEDDING_MODEL, runEmbeddingInference } from "./structured-inference";

export const MEMORY_EMBEDDING_DIMENSIONS = 1_024;
const MEMORY_EMBEDDING_SPACE_VERSION = "v1";

export const MEMORY_SCOPE_KINDS = ["workstream", "automation", "user", "workspace"] as const;
/**
 * The scope kinds as the model names them. A Sidekick's scope is stored as
 * `automation`, the kind the rows and the vector metadata carry; the model
 * reads and writes it as `sidekick`, and the two meet only at the tool
 * boundary, in {@link modelScopeKind} and {@link storedScopeKind}.
 */
export const MODEL_MEMORY_SCOPE_KINDS = ["workstream", "sidekick", "user", "workspace"] as const;
const SEARCH_CANDIDATES_PER_LEG = 20;
const SEARCH_RESULTS = 10;
const RRF_OFFSET = 60;

export type MemoryScopeKind = typeof MEMORY_SCOPE_KINDS[number];
export type ModelMemoryScopeKind = typeof MODEL_MEMORY_SCOPE_KINDS[number];

/** The stored kind as the model reads it. */
export function modelScopeKind(kind: MemoryScopeKind): ModelMemoryScopeKind {
  return kind === "automation" ? "sidekick" : kind;
}

/** The kind the model named, as it is stored. */
export function storedScopeKind(kind: ModelMemoryScopeKind): MemoryScopeKind {
  return kind === "sidekick" ? "automation" : kind;
}

export interface MemoryScope {
  memoryScopeId: string;
  workspaceId: string;
  kind: MemoryScopeKind;
  ownerId: string;
  writable: boolean;
}

export interface MemorySearchItem {
  memoryItemId: string;
  memoryScopeId: string;
  scopeKind: ModelMemoryScopeKind;
  text: string;
  revision: number;
  expiresAt: string | null;
}

export type MemoryRetrievalMode = "hybrid" | "fts_only" | "vector_only" | "none";

export interface MemorySearchResult {
  query: string;
  retrievalMode: MemoryRetrievalMode;
  results: MemorySearchItem[];
}

export interface FrozenMemoryContext extends MemorySearchResult {
  memoryScopeIds: string[];
  memoryContextHash: string;
}

interface MemoryRunLease {
  attemptId: string;
  owner: string;
}

interface RankedCandidate {
  memoryItemId: string;
  revision: number;
}

interface MutationResult {
  memoryItemId: string;
  memoryScopeId: string;
  scopeKind: ModelMemoryScopeKind;
  revision: number;
  invalidated: boolean;
}

/** The WorkspaceDO that owns this workspace's memory tables. */
function workspaceMemoryObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/**
 * The message matters more than usual here. The wire schema no longer declares
 * the exclusivity — a `oneOf` of bare `required` branches does not survive
 * sanitization — so this rejection is the model's only feedback. Left to its
 * default a union reports each branch's own complaint, which for two `.strict()`
 * objects reads `Unrecognized key: "memoryItemId"` and `Unrecognized key:
 * "query"`: together, "neither key is allowed", and a model that believes it
 * retries with `{}`, which fails too.
 */
const SearchInputSchema = z.union([
  z.strictObject({ query: z.string().trim().min(1).max(MEMORY_RECALL_QUERY_LIMIT) }),
  z.strictObject({ memoryItemId: z.string().uuid() }),
], { error: "Send exactly one of query or memoryItemId: query to search, memoryItemId to reread one known item." });

const AddInputSchema = z.strictObject({
  scopeKind: z.enum(MODEL_MEMORY_SCOPE_KINDS).transform(storedScopeKind),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
});

const UpdateInputSchema = z.strictObject({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
});

const InvalidateInputSchema = z.strictObject({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
});

class MemoryToolError extends Error {
  override readonly name = "MemoryToolError";

  constructor(
    readonly code: string,
    message: string,
    readonly details: { reason: string },
  ) {
    super(message);
  }
}

function memoryRevisionConflict(): MemoryToolError {
  return new MemoryToolError(
    "memory_revision_conflict",
    "The durable memory changed after it was read. Read it again by memoryItemId, inspect the current text and revision, and rebuild the mutation.",
    {
      reason: "Call memory_search with this memoryItemId, inspect its current text and revision, and rebuild the update or invalidation. Do not retry with the old revision.",
    },
  );
}

/**
 * The scope kinds a refusal names, narrowest first.
 *
 * `MEMORY_SCOPE_KINDS` is declared in that order and the plugin policy asks for
 * the narrowest scope that fits, so a retry list has to agree with both. The
 * union itself resolves broadest first — workspace, then user, then the work
 * stream — and handing that order back told the model to try workspace first,
 * which is the widest audience and the one an ordinary member usually cannot
 * write at all.
 */
function scopeList(scopes: readonly MemoryScope[]): string {
  if (scopes.length === 0) return "none";
  return [...scopes]
    .sort((left, right) =>
      MEMORY_SCOPE_KINDS.indexOf(left.kind) - MEMORY_SCOPE_KINDS.indexOf(right.kind))
    .map((scope) => modelScopeKind(scope.kind))
    .join(", ");
}

/**
 * What a refusal may tell the model to retry with: the scopes it can actually
 * write, never the ones it may only read. Naming a readable-but-unwritable
 * scope spends the model's next turn on a second refusal.
 */
function retryInstruction(scopes: readonly MemoryScope[]): string {
  const writable = scopes.filter((scope) => scope.writable);
  return writable.length === 0
    ? "This run can write no durable memory at all. Say the fact could not be stored rather than looking for another scope."
    : `Retry with one of: ${scopeList(writable)} — narrowest first. If none of them fits, say the fact could not be stored durably instead of storing it elsewhere.`;
}

/**
 * The two refusals a write tool raises when the kind the model chose is not in
 * this run's union — each naming the kinds that are.
 *
 * `scopeKind` is declared as the whole static enum, so every run is offered
 * kinds it may not resolve, and a bare `memory_scope_not_available:workstream`
 * told the model only that its choice was wrong, never which to make instead.
 * That became a routine answer rather than an edge case when runs carrying no
 * automation subscription started reaching the tool loop in a work stream an
 * automation created: they hold no work-stream scope, and the standing plugin
 * policy points a conversational run at that kind first. Typed for the reason
 * `memoryRevisionConflict` is — an untyped `Error` reaches the model with no
 * code and no next action (`docs/agent-tools.md`).
 */
export function unavailableScopeError(
  kind: MemoryScopeKind,
  scopes: readonly MemoryScope[],
): MemoryToolError {
  return new MemoryToolError(
    "memory_scope_not_available",
    `This run cannot reach ${modelScopeKind(kind)} memory. Its scopes are: ${scopeList(scopes)}.`,
    { reason: retryInstruction(scopes) },
  );
}

export function unwritableScopeError(
  kind: MemoryScopeKind,
  scopes: readonly MemoryScope[],
): MemoryToolError {
  const writable = scopes.filter((scope) => scope.writable);
  return new MemoryToolError(
    "memory_scope_not_writable",
    writable.length === 0
      ? `This run may read ${modelScopeKind(kind)} memory, and has no writable memory scope at all.`
      : `This run may read ${modelScopeKind(kind)} memory but not write it. It may write: ${scopeList(writable)}.`,
    { reason: retryInstruction(scopes) },
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function vectorId(memoryItemId: string, revision: number): string {
  return `${memoryItemId}:${revision}`;
}

function parseVectorId(value: string): RankedCandidate | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const memoryItemId = value.slice(0, separator);
  const revision = Number.parseInt(value.slice(separator + 1), 10);
  if (!Number.isInteger(revision) || revision <= 0) return null;
  return { memoryItemId, revision };
}

function ftsQuery(value: string): string | null {
  const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return [...new Set(tokens.map((token) => token.toLocaleLowerCase()))]
    .slice(0, 96)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export async function ensureScope(
  env: Env,
  workspaceId: string,
  kind: MemoryScopeKind,
  ownerId: string,
  writable: boolean,
): Promise<MemoryScope> {
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const scope = WorkspaceMemoryScopeSchema.parse(await workspace.ensureMemoryScope({
    workspaceId,
    proposedScopeId: newId(),
    kind,
    ownerId,
    at: nowIso(),
  }));
  return {
    memoryScopeId: scope.memoryScopeId,
    workspaceId: scope.workspaceId,
    kind: scope.kind,
    ownerId: scope.ownerId,
    writable,
  };
}

/** Resolve the complete memory scope union from host-owned run authority. */
export async function resolveMemoryAccess(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "parentKind" | "harnessRunId" | "executionPrincipal">,
): Promise<MemoryScope[]> {
  const [run, workstream] = await Promise.all([
    createHarnessRunObjectPort(env, input.workspaceId, input.parentId)
      .run({ runId: input.harnessRunId }),
    createIdentityObjectPort(env, input.workspaceId, input.parentId).identity(),
  ]);
  if (!run || !workstream) throw new Error("memory_run_context_not_found");
  if (stableJson(JSON.parse(run.execution_principal_json)) !== stableJson(input.executionPrincipal)) {
    throw new Error("memory_run_principal_mismatch");
  }
  if (run.parent_tool_call_id) return [];

  let memberRole: "owner" | "admin" | "member" | null = null;
  if (input.executionPrincipal.type === "workspace") {
    if (input.executionPrincipal.workspaceId !== input.workspaceId) {
      throw new Error("memory_workspace_principal_mismatch");
    }
  } else {
    const member = await env.DB.prepare(
      `SELECT role FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(input.workspaceId, input.executionPrincipal.userId)
      .first<{ role: "owner" | "admin" | "member" }>();
    if (!member) throw new Error("memory_user_not_active_workspace_member");
    memberRole = member.role;
  }

  const workspaceWritable = input.executionPrincipal.type === "workspace"
    || memberRole === "owner"
    || memberRole === "admin";
  const scopes: MemoryScope[] = [
    await ensureScope(env, input.workspaceId, "workspace", input.workspaceId, workspaceWritable),
  ];

  // An automation's conversations, its draft chat and its runs alike, share
  // the automation's own scope: what a run learns is what the next run should
  // know, and what the person said while drafting is part of that. The
  // person's own scope stays out of it, because a run acts for the automation
  // rather than as the person, and a workspace automation's runs would
  // otherwise write into whichever member happened to be its principal.
  if (input.parentKind === "automation") {
    scopes.push(await ensureScope(env, input.workspaceId, "automation", input.parentId, true));
    return scopes;
  }

  // Everything below is the union for a run whose parent is a work stream. The
  // parent kind on the run's input is the fact that decides it: an automation
  // run carries `parentKind: "automation"` and took the branch above, and the
  // container's own row says nothing more. This used to be decided by a
  // subscription id on the run plus the identity root's `origin_type`, the
  // second of which was a weaker copy of the first and has no writer now.
  if (input.executionPrincipal.type === "user") {
    scopes.push(await ensureScope(
      env,
      input.workspaceId,
      "user",
      input.executionPrincipal.userId,
      true,
    ));
  }
  scopes.push(await ensureScope(
    env,
    input.workspaceId,
    "workstream",
    input.parentId,
    input.executionPrincipal.type === "user",
  ));
  return scopes;
}

async function searchFts(
  env: Env,
  workspaceId: string,
  scopeIds: readonly string[],
  query: string,
): Promise<RankedCandidate[]> {
  const match = ftsQuery(query);
  if (!match || scopeIds.length === 0) return [];
  const workspace = await workspaceMemoryObject(env, workspaceId);
  return WorkspaceMemoryCandidateListSchema.parse(await workspace.searchMemoryItemsFts({
    workspaceId,
    match,
    scopeIds: [...scopeIds],
    now: nowIso(),
    limit: SEARCH_CANDIDATES_PER_LEG,
  })).candidates;
}

interface MemoryEmbeddingContext {
  workspaceId: string;
  workstreamId?: string;
  substreamId?: string;
  harnessRunId?: string;
  requestId?: string;
  executionPrincipal?: WorkstreamWorkflowInput["executionPrincipal"];
}

interface MemoryEmbedding {
  values: number[];
}

async function embedMemory(
  env: Env,
  text: string,
  inputType: "search_query" | "search_document",
  context: MemoryEmbeddingContext,
): Promise<MemoryEmbedding> {
  const contextUserId = context.executionPrincipal?.type === "user"
    ? context.executionPrincipal.userId
    : undefined;
  const result = await runEmbeddingInference(env, {
    context: {
      workspaceId: context.workspaceId,
      ...(context.workstreamId ? { workstreamId: context.workstreamId } : {}),
      ...(context.substreamId ? { substreamId: context.substreamId } : {}),
      ...(contextUserId ? { userId: contextUserId } : {}),
    },
    text,
    inputType,
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    generationName: inputType === "search_query" ? "memory_query_embedding" : "memory_document_embedding",
    ...(context.harnessRunId ? { harnessRunId: context.harnessRunId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.executionPrincipal ? {
      executionPrincipalType: context.executionPrincipal.type,
      executionPrincipalId: context.executionPrincipal.type === "user"
        ? context.executionPrincipal.userId
        : context.executionPrincipal.workspaceId,
    } : {}),
  });
  if (
    result.requestedModel !== MEMORY_EMBEDDING_MODEL
    || !isMemoryEmbeddingModel(result.resolvedModel)
  ) {
    throw new Error("memory_embedding_model_mismatch");
  }
  const values = result.embeddings[0];
  if (!values) throw new Error(`memory_${inputType}_embedding_empty`);
  return { values };
}

async function memoryVectorNamespace(scopeId: string): Promise<string> {
  const space = (await sha256(
    `${MEMORY_EMBEDDING_SPACE_VERSION}:${MEMORY_EMBEDDING_MODEL}:${MEMORY_EMBEDDING_DIMENSIONS}`,
  )).slice(0, 12);
  return `${scopeId}:${space}`;
}

async function searchVector(
  env: Env,
  input: WorkstreamWorkflowInput,
  scopes: readonly MemoryScope[],
  query: string,
): Promise<RankedCandidate[]> {
  if (!env.MEMORY_INDEX) throw new Error("memory_vector_binding_unavailable");
  const embedding = await embedMemory(env, query, "search_query", {
    workspaceId: input.workspaceId,
    workstreamId: input.parentId,
    ...(input.substreamId ? { substreamId: input.substreamId } : {}),
    harnessRunId: input.harnessRunId,
    executionPrincipal: input.executionPrincipal,
  });
  const matchesByScope = await Promise.all(scopes.map(async (scope) => env.MEMORY_INDEX.query(
    embedding.values,
    {
      topK: SEARCH_CANDIDATES_PER_LEG,
      namespace: await memoryVectorNamespace(scope.memoryScopeId),
      returnMetadata: false,
      returnValues: false,
    },
  )));
  return matchesByScope
    .flatMap((result) => result.matches)
    .sort((left, right) => right.score - left.score)
    .map((match) => parseVectorId(match.id))
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .slice(0, SEARCH_CANDIDATES_PER_LEG);
}

async function loadCanonicalItems(
  env: Env,
  workspaceId: string,
  scopeIds: readonly string[],
  memoryItemIds: readonly string[],
): Promise<WorkspaceMemoryItem[]> {
  if (scopeIds.length === 0 || memoryItemIds.length === 0) return [];
  const workspace = await workspaceMemoryObject(env, workspaceId);
  return WorkspaceMemoryItemListSchema.parse(await workspace.canonicalMemoryItems({
    workspaceId,
    scopeIds: [...scopeIds],
    memoryItemIds: [...memoryItemIds],
    now: nowIso(),
  })).items;
}

async function recordAccess(
  env: Env,
  workspaceId: string,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const workspace = await workspaceMemoryObject(env, workspaceId);
  await workspace.recordMemoryItemAccess({
    workspaceId,
    memoryItemIds: [...itemIds],
    at: nowIso(),
  });
}

async function hybridMemorySearch(
  env: Env,
  input: WorkstreamWorkflowInput,
  query: string,
  trackAccess = true,
): Promise<MemorySearchResult & { scopes: MemoryScope[] }> {
  const scopes = await resolveMemorySearchAccess(env, input);
  if (scopes.length === 0) {
    return { query, retrievalMode: "none", results: [], scopes };
  }
  const scopeIds = scopes.map((scope) => scope.memoryScopeId);
  const [ftsSettled, vectorSettled] = await Promise.allSettled([
    searchFts(env, input.workspaceId, scopeIds, query),
    searchVector(env, input, scopes, query),
  ]);
  const fts = ftsSettled.status === "fulfilled" ? ftsSettled.value : [];
  const vector = vectorSettled.status === "fulfilled" ? vectorSettled.value : [];
  const retrievalMode: MemoryRetrievalMode = ftsSettled.status === "fulfilled"
    ? vectorSettled.status === "fulfilled" ? "hybrid" : "fts_only"
    : vectorSettled.status === "fulfilled" ? "vector_only" : "none";

  const canonicalScopeIds = scopeIds;
  const candidateIds = [...new Set([...fts, ...vector].map((candidate) => candidate.memoryItemId))];
  const canonicalRows = await loadCanonicalItems(
    env,
    input.workspaceId,
    canonicalScopeIds,
    candidateIds,
  );
  const canonicalById = new Map(canonicalRows.map((row) => [row.memoryItemId, row]));
  const scores = new Map<string, number>();
  for (const candidates of [fts, vector]) {
    candidates.forEach((candidate, index) => {
      const canonical = canonicalById.get(candidate.memoryItemId);
      if (!canonical || canonical.revision !== candidate.revision) return;
      scores.set(
        candidate.memoryItemId,
        (scores.get(candidate.memoryItemId) ?? 0) + 1 / (RRF_OFFSET + index + 1),
      );
    });
  }
  const ranked = [...scores.entries()]
    .sort(([leftId, leftScore], [rightId, rightScore]) => {
      if (rightScore !== leftScore) return rightScore - leftScore;
      const updated = canonicalById.get(rightId)!.updatedAt.localeCompare(
        canonicalById.get(leftId)!.updatedAt,
      );
      return updated || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
    })
    .slice(0, SEARCH_RESULTS)
    .map(([memoryItemId]): MemorySearchItem => {
      const row = canonicalById.get(memoryItemId)!;
      return {
        memoryItemId: row.memoryItemId,
        memoryScopeId: row.memoryScopeId,
        scopeKind: modelScopeKind(row.scopeKind),
        text: row.text,
        revision: row.revision,
        expiresAt: row.expiresAt,
      };
    });
  if (trackAccess) {
    // Retrieval remains available when non-authoritative access counters cannot
    // be updated; projected scope admission and the canonical item read above have already succeeded.
    await recordAccess(env, input.workspaceId, ranked.map((item) => item.memoryItemId))
      .catch(() => undefined);
  }
  return { query, retrievalMode, results: ranked, scopes };
}

export async function memorySearch(
  env: Env,
  input: WorkstreamWorkflowInput,
  query: string,
): Promise<MemorySearchResult> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const parsed = SearchInputSchema.parse({ query });
  if (!("query" in parsed)) throw new Error("memory_search_query_expected");
  const result = await hybridMemorySearch(env, input, parsed.query);
  return { query: result.query, retrievalMode: result.retrievalMode, results: result.results };
}

async function memoryReadById(
  env: Env,
  input: WorkstreamWorkflowInput,
  memoryItemId: string,
) {
  const scopes = await resolveMemoryAccess(env, input);
  const scopeIds = scopes.map((scope) => scope.memoryScopeId);
  const row = (await loadCanonicalItems(env, input.workspaceId, scopeIds, [memoryItemId]))[0];
  const currentScopes = await resolveMemoryAccess(env, input);
  const currentlyAuthorized = new Set(currentScopes.map((scope) => scope.memoryScopeId));
  const visible = row && currentlyAuthorized.has(row.memoryScopeId) ? row : null;
  if (visible) {
    await recordAccess(env, input.workspaceId, [visible.memoryItemId]).catch(() => undefined);
  }
  return {
    query: null,
    memoryItemId,
    retrievalMode: "exact" as const,
    results: visible ? [{
      memoryItemId: visible.memoryItemId,
      memoryScopeId: visible.memoryScopeId,
      scopeKind: modelScopeKind(visible.scopeKind),
      text: visible.text,
      revision: visible.revision,
      expiresAt: visible.expiresAt,
    }] : [],
  };
}

function parseFrozenContext(row: {
  memory_scope_ids_json: string;
  query_text: string;
  // The object stores what it was given; the narrow union is the runtime's.
  retrieval_mode: string;
  results_json: string;
  memory_context_hash: string;
}): FrozenMemoryContext {
  return {
    memoryScopeIds: JSON.parse(row.memory_scope_ids_json) as string[],
    query: row.query_text,
    retrievalMode: row.retrieval_mode as MemoryRetrievalMode,
    results: JSON.parse(row.results_json) as MemorySearchItem[],
    memoryContextHash: row.memory_context_hash,
  };
}

export async function freezeRunMemoryContext(
  env: Env,
  input: WorkstreamWorkflowInput,
  lease: MemoryRunLease,
  rawQuery: string,
): Promise<FrozenMemoryContext> {
  // Bounded to what the recall surfaces accept, because this query is assembled
  // from run content rather than chosen by anyone: `memoryQueryParts` joins the
  // objective, the trigger context and the full text of the triggering message.
  // An automation triggered by a long email or chat message therefore built a
  // query over the automation memory tool's 2000-character bound, and the
  // ZodError from that parse escaped run setup — before the frozen scope, before
  // the first inference — so the run failed on every attempt and stayed failed,
  // with a bare `harness_execution_failed` naming nothing anyone could act on.
  //
  // The two branches lose different amounts, and only one of them loses
  // nothing. On the automation side the match is `instr(lower(text),
  // lower(?))`, so a query longer than any stored memory could never have
  // matched and truncation costs nothing at all. The workspace side is
  // `hybridMemorySearch`, whose vector leg embeds the query — a 2000-character
  // prefix genuinely does retrieve differently from the whole string, and that
  // branch had no bound of its own forcing this.
  //
  // It is still the right cut, because of what the tail is. `memoryQueryParts`
  // appends in order: the recallable objective first, then the trigger context,
  // then the full text of the triggering message. Truncating drops the end of a
  // long email or chat message, not the objective the recall is about.
  //
  // The bound is the receiving schema's rather than a new number of this
  // function's choosing, and it is applied before the hash and the persisted
  // text so a replay freezes the same query.
  const query = (rawQuery.trim() || "Current work-stream objective and trigger")
    .slice(0, MEMORY_RECALL_QUERY_LIMIT);
  const runs = createHarnessRunObjectPort(env, input.workspaceId, input.parentId);
  const fence = {
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
  };
  const existing = await runs.memoryContext(fence);
  if (existing) return parseFrozenContext(existing);

  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const workspaceRecall = await hybridMemorySearch(env, input, query);
  const memoryScopeIds = workspaceRecall.scopes.map((scope) => scope.memoryScopeId).sort();
  const results = workspaceRecall.results;
  const retrievalMode = workspaceRecall.retrievalMode;
  const memoryContextHash = await sha256(stableJson({ memoryScopeIds, query, retrievalMode, results }));
  // The recall above costs a vector search, so the read and the write cannot be
  // one operation. A loser gets the winner's row rather than an outcome to
  // interpret: freezing recall exists so every replay of this attempt sees the
  // same memories, which makes the row the run will actually use the only
  // useful answer.
  const frozen = await runs.persistMemoryContext({
    ...fence,
    now: Date.now(),
    memoryScopeIdsJson: JSON.stringify(memoryScopeIds),
    queryText: query,
    retrievalMode,
    resultsJson: JSON.stringify(results),
    memoryContextHash,
  });
  if (frozen.outcome === "ownership_lost") {
    throw new Error("memory_context_run_ownership_lost");
  }
  return parseFrozenContext(frozen.row);
}

function requireReceipt(context: { providerIdempotencyKey?: string }): string {
  const receipt = context.providerIdempotencyKey?.trim();
  if (!receipt) throw new Error("Memory writes require a durable provider idempotency key");
  return receipt;
}

async function loadReceipt(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "harnessRunId">,
  receiptId: string,
  operation: "add" | "update" | "invalidate",
  inputHash: string,
): Promise<MutationResult | null> {
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const receipt = WorkspaceMemoryReceiptResultSchema.parse(await workspace.memoryMutationReceipt({
    workspaceId: input.workspaceId,
    harnessRunId: input.harnessRunId,
    receiptId,
  }));
  if (receipt.outcome === "none") return null;
  if (receipt.operation !== operation || receipt.inputHash !== inputHash) {
    throw new Error("memory_mutation_receipt_mismatch");
  }
  return JSON.parse(receipt.resultJson) as MutationResult;
}

async function mutationInputHash(operation: string, args: unknown): Promise<string> {
  return sha256(stableJson({ operation, args }));
}

function mutationToolResult(result: MutationResult, summary: string): HarnessToolResult {
  return { output: result, summary, providerOperationId: result.memoryItemId };
}

/**
 * The one place a write tool turns a model-chosen scope kind into a scope.
 *
 * Exported because `table_create` enforces the same rule on the same union and
 * had grown its own copy of the find-and-throw: two sites to keep in step every
 * time the refusal changes, which is exactly what went wrong when both were
 * still raising bare codes.
 */
export async function writableScope(
  env: Env,
  input: WorkstreamWorkflowInput,
  kind: MemoryScopeKind,
): Promise<MemoryScope> {
  const scopes = await resolveMemoryAccess(env, input);
  const scope = scopes.find((candidate) => candidate.kind === kind);
  if (!scope) throw unavailableScopeError(kind, scopes);
  if (!scope.writable) throw unwritableScopeError(kind, scopes);
  return scope;
}

async function addMemory(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const parsed = AddInputSchema.parse(raw);
  const args = {
    ...parsed,
    ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt).toISOString() } : {}),
  };
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("add", args);
  const replay = await loadReceipt(env, input, receiptId, "add", inputHash);
  if (replay) return mutationToolResult(replay, "Added durable memory");
  const scope = await writableScope(env, input, args.scopeKind);
  const memoryItemId = newId();
  const memoryMutationId = newId();
  const at = nowIso();
  const result: MutationResult = {
    memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    scopeKind: modelScopeKind(scope.kind),
    revision: 1,
    invalidated: false,
  };
  const provenance = {
    source: "agent",
    harnessRunId: input.harnessRunId,
    workstreamId: input.parentId,
    executionPrincipal: input.executionPrincipal,
    rationale: args.rationale,
  };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryAddResultSchema.parse(await workspace.addMemoryItem({
    workspaceId: input.workspaceId,
    memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    text: args.text,
    expiresAt: args.expiresAt ?? null,
    provenanceJson: JSON.stringify(provenance),
    mutation: {
      memoryMutationId,
      receiptId,
      actorPrincipalJson: JSON.stringify(input.executionPrincipal),
      harnessRunId: input.harnessRunId,
      workstreamId: input.parentId,
      rationale: args.rationale,
      inputHash,
      mutationJson: JSON.stringify({ text: args.text, expiresAt: args.expiresAt ?? null }),
      resultJson: JSON.stringify(result),
    },
    at,
  }));
  // A replay that raced this write past the preflight read above settles
  // inside the object's transaction and answers with the recorded result.
  if (outcome.outcome === "replayed") {
    return mutationToolResult(JSON.parse(outcome.resultJson) as MutationResult, "Added durable memory");
  }
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_mutation_receipt_mismatch");
  return mutationToolResult(result, "Added durable memory");
}

async function loadWritableItem(
  env: Env,
  input: WorkstreamWorkflowInput,
  memoryItemId: string,
): Promise<{ item: WorkspaceMemoryItem; scope: MemoryScope }> {
  const scopes = await resolveMemoryAccess(env, input);
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const found = WorkspaceMemoryItemForWriteResultSchema.parse(await workspace.memoryItemForWrite({
    workspaceId: input.workspaceId,
    memoryItemId,
  }));
  if (found.outcome !== "found") throw new Error("memory_item_not_found");
  const scope = scopes.find((candidate) => candidate.memoryScopeId === found.item.memoryScopeId);
  if (!scope) throw new Error("memory_item_not_authorized");
  if (!scope.writable) throw new Error(`memory_scope_not_writable:${modelScopeKind(scope.kind)}`);
  return { item: found.item, scope };
}

async function updateMemory(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const parsed = UpdateInputSchema.parse(raw);
  const args = {
    ...parsed,
    ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt).toISOString() } : {}),
  };
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("update", args);
  const replay = await loadReceipt(env, input, receiptId, "update", inputHash);
  if (replay) return mutationToolResult(replay, "Updated durable memory");
  const { item, scope } = await loadWritableItem(env, input, args.memoryItemId);
  if (item.invalidatedAt) throw new Error("memory_item_invalidated");
  if (item.revision !== args.expectedRevision) throw memoryRevisionConflict();
  const nextRevision = args.expectedRevision + 1;
  const memoryMutationId = newId();
  const at = nowIso();
  const expiresAt = args.expiresAt ?? item.expiresAt;
  const result: MutationResult = {
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    scopeKind: modelScopeKind(scope.kind),
    revision: nextRevision,
    invalidated: false,
  };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryWriteResultSchema.parse(await workspace.updateMemoryItem({
    workspaceId: input.workspaceId,
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    expectedRevision: args.expectedRevision,
    text: args.text,
    expiresAt,
    mutation: {
      memoryMutationId,
      receiptId,
      actorPrincipalJson: JSON.stringify(input.executionPrincipal),
      harnessRunId: input.harnessRunId,
      workstreamId: input.parentId,
      rationale: args.rationale,
      inputHash,
      mutationJson: JSON.stringify({ text: args.text, expiresAt }),
      resultJson: JSON.stringify(result),
    },
    at,
  }));
  if (outcome.outcome === "replayed") {
    return mutationToolResult(JSON.parse(outcome.resultJson) as MutationResult, "Updated durable memory");
  }
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_mutation_receipt_mismatch");
  // The object's transaction settles a replay before checking the revision,
  // so a conflict here is genuinely another writer's, not this receipt's.
  if (outcome.outcome === "revision_conflict") throw memoryRevisionConflict();
  return mutationToolResult(result, "Updated durable memory");
}

async function invalidateMemory(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = InvalidateInputSchema.parse(raw);
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("invalidate", args);
  const replay = await loadReceipt(env, input, receiptId, "invalidate", inputHash);
  if (replay) return mutationToolResult(replay, "Invalidated durable memory");
  const { item, scope } = await loadWritableItem(env, input, args.memoryItemId);
  if (item.invalidatedAt) throw new Error("memory_item_invalidated");
  if (item.revision !== args.expectedRevision) throw memoryRevisionConflict();
  const nextRevision = args.expectedRevision + 1;
  const memoryMutationId = newId();
  const at = nowIso();
  const principalJson = JSON.stringify(input.executionPrincipal);
  const result: MutationResult = {
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    scopeKind: modelScopeKind(scope.kind),
    revision: nextRevision,
    invalidated: true,
  };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryWriteResultSchema.parse(await workspace.invalidateMemoryItem({
    workspaceId: input.workspaceId,
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    expectedRevision: args.expectedRevision,
    reason: args.reason,
    mutation: {
      memoryMutationId,
      receiptId,
      actorPrincipalJson: principalJson,
      harnessRunId: input.harnessRunId,
      workstreamId: input.parentId,
      rationale: args.reason,
      inputHash,
      mutationJson: JSON.stringify({ reason: args.reason }),
      resultJson: JSON.stringify(result),
    },
    at,
  }));
  if (outcome.outcome === "replayed") {
    return mutationToolResult(JSON.parse(outcome.resultJson) as MutationResult, "Invalidated durable memory");
  }
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_mutation_receipt_mismatch");
  if (outcome.outcome === "revision_conflict") throw memoryRevisionConflict();
  return mutationToolResult(result, "Invalidated durable memory");
}

export function createMemoryTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const tools: HarnessTool[] = [
    {
      definition: {
        name: "search",
        description: "Search every durable memory scope authorized by the host using query, or reread one exact authorized item using memoryItemId. Pass exactly one; scope selection is not accepted.",
        capability: "memory.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: MEMORY_RECALL_QUERY_LIMIT },
            memoryItemId: { type: "string", format: "uuid" },
          },
          // Exclusivity is stated in the description and enforced by
          // `SearchInputSchema`; a `oneOf` of bare `required` branches does not
          // survive schema sanitization. See `docs/agent-tools.md`.
        },
      },
      // The exclusivity the description states is unrepresentable in the
      // declared schema, so `{}` and both-keys-at-once both pass it and are
      // then rejected here. Without the hook the runtime reads that as the
      // tool's data being bad rather than the model's arguments, and the
      // carefully worded union message below never reaches the model at all.
      validateInput: (raw) => {
        const result = SearchInputSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: async (raw) => {
        const args = SearchInputSchema.parse(raw);
        const result = "query" in args
          ? await memorySearch(env, input, args.query)
          : await memoryReadById(env, input, args.memoryItemId);
        return {
          output: result,
          summary: `Found ${result.results.length} durable memor${result.results.length === 1 ? "y" : "ies"} (${result.retrievalMode})`,
        };
      },
    },
    {
      definition: {
        name: "add",
        description: "Add one durable memory to the narrowest host-authorized scope of the requested kind.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scopeKind: { type: "string", enum: MODEL_MEMORY_SCOPE_KINDS },
            text: { type: "string", minLength: 1, maxLength: 16_000 },
            expiresAt: { type: "string", format: "date-time" },
            rationale: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          required: ["scopeKind", "text", "rationale"],
        },
      },
      execute: (raw, context) => addMemory(env, input, raw, context),
    },
    {
      definition: {
        name: "update",
        description: "Replace an authorized durable memory. Copy memoryItemId and expectedRevision from memory_search; after a revision conflict, call memory_search with memoryItemId and rebuild the update from that exact result.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memoryItemId: { type: "string", format: "uuid" },
            expectedRevision: {
              type: "integer",
              minimum: 1,
              description: "Copy revision exactly from memory_search for this memoryItemId.",
            },
            text: { type: "string", minLength: 1, maxLength: 16_000 },
            expiresAt: { type: "string", format: "date-time" },
            rationale: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          required: ["memoryItemId", "expectedRevision", "text", "rationale"],
        },
      },
      execute: (raw, context) => updateMemory(env, input, raw, context),
    },
    {
      definition: {
        name: "invalidate",
        description: "Reversibly invalidate an authorized durable memory. Copy memoryItemId and expectedRevision from memory_search; after a revision conflict, call memory_search with memoryItemId and retry from that exact result.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memoryItemId: { type: "string", format: "uuid" },
            expectedRevision: {
              type: "integer",
              minimum: 1,
              description: "Copy revision exactly from memory_search for this memoryItemId.",
            },
            reason: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          required: ["memoryItemId", "expectedRevision", "reason"],
        },
      },
      execute: (raw, context) => invalidateMemory(env, input, raw, context),
    },
  ];
  return tools;
}

async function projectOutboxRow(
  env: Env,
  workspace: Awaited<ReturnType<typeof workspaceMemoryObject>>,
  row: WorkspaceMemoryOutboxRow,
): Promise<void> {
  if (!env.MEMORY_INDEX) throw new Error("memory_vector_binding_unavailable");
  const current = WorkspaceMemoryProjectionSourceResultSchema.parse(
    await workspace.memoryIndexProjectionSource({
      workspaceId: row.workspaceId,
      memoryItemId: row.memoryItemId,
      memoryScopeId: row.memoryScopeId,
    }),
  );
  const priorVectorId = row.revision > 1 ? vectorId(row.memoryItemId, row.revision - 1) : null;
  if (
    row.operation === "delete"
    || current.outcome === "none"
    || current.revision !== row.revision
    || current.invalidatedAt
    || (current.expiresAt != null && current.expiresAt <= nowIso())
  ) {
    await env.MEMORY_INDEX.deleteByIds([
      vectorId(row.memoryItemId, row.revision),
      ...(priorVectorId ? [priorVectorId] : []),
    ]);
    return;
  }
  const embedding = await embedMemory(env, current.text, "search_document", {
    workspaceId: row.workspaceId,
    ...(current.scopeKind === "workstream" ? { workstreamId: current.scopeOwnerId } : {}),
    requestId: row.outboxId,
  });
  await env.MEMORY_INDEX.upsert([{
    id: vectorId(row.memoryItemId, row.revision),
    values: embedding.values,
    namespace: await memoryVectorNamespace(row.memoryScopeId),
    metadata: {
      workspaceId: row.workspaceId,
      scopeKind: current.scopeKind,
      revision: row.revision,
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDimensions: MEMORY_EMBEDDING_DIMENSIONS,
    },
  }]);
  if (priorVectorId) await env.MEMORY_INDEX.deleteByIds([priorVectorId]);
}

function memoryProjectionFailureCode(error: unknown): string {
  if (error instanceof OpenRouterError) {
    return error.status == null ? "openrouter_error" : `openrouter_http_${error.status}`;
  }
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return "embedding_aborted";
    if (error.name === "TimeoutError") return "embedding_timeout";
  }
  if (error instanceof TypeError) return "embedding_network_error";
  return "embedding_failure";
}

/**
 * Replay the transactional embedding outbox. Safe for concurrent workers: a
 * row is claimed under a lease before its projection leaves the object, and a
 * lost lease means another worker finished it. Runs inside WorkspaceDO's own
 * alarm in production, where {@link durableObjectStubForWorkspace} hands back
 * the registered instance rather than an RPC round trip to itself.
 */
export async function processMemoryIndexOutbox(
  env: Env,
  limit = 50,
  workspaceId?: string,
): Promise<number> {
  if (!workspaceId) throw new Error("memory_index_workspace_required");
  if (!env.OPENROUTER_API_KEY || !env.MEMORY_INDEX) return 0;
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const due = WorkspaceMemoryOutboxDueListSchema.parse(await workspace.dueMemoryIndexOutbox({
    workspaceId,
    now: nowIso(),
    limit: Math.max(1, Math.min(200, limit)),
  }));
  let completed = 0;
  for (const row of due.rows) {
    const leaseToken = newId();
    const claim = WorkspaceMemoryOutboxClaimResultSchema.parse(
      await workspace.claimMemoryIndexOutboxRow({
        workspaceId,
        outboxId: row.outboxId,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        now: nowIso(),
      }),
    );
    if (!claim.claimed) continue;
    try {
      await projectOutboxRow(env, workspace, row);
      await workspace.completeMemoryIndexOutboxRow({
        workspaceId,
        outboxId: row.outboxId,
        leaseToken,
        at: nowIso(),
      });
      completed += 1;
    } catch (error) {
      const delaySeconds = Math.min(3_600, 2 ** Math.min(12, row.attemptCount + 1));
      await workspace.retryMemoryIndexOutboxRow({
        workspaceId,
        outboxId: row.outboxId,
        leaseToken,
        availableAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
        // Provider messages may echo request content. Persist only a closed,
        // content-free failure class in durable state.
        lastError: memoryProjectionFailureCode(error),
        at: nowIso(),
      });
    }
  }
  return completed;
}

export const __memoryTesting = {
  AddInputSchema,
  InvalidateInputSchema,
  SearchInputSchema,
  UpdateInputSchema,
  ftsQuery,
  hybridMemorySearch,
  parseVectorId,
  vectorId,
};
