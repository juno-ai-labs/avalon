import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import type { HarnessTool, HarnessToolResult } from "@rally/agent-harness";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createIdentityObjectPort } from "../runtime/identity-port";

export const MEMORY_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b" as const;

export const MEMORY_SCOPE_KINDS = ["workstream", "automation", "user", "workspace"] as const;
const SEARCH_CANDIDATES_PER_LEG = 20;
const SEARCH_RESULTS = 10;
const RRF_OFFSET = 60;

export type MemoryScopeKind = typeof MEMORY_SCOPE_KINDS[number];

export interface MemoryScope {
  memoryScopeId: string;
  workspaceId: string;
  kind: MemoryScopeKind;
  ownerId: string;
  writable: boolean;
}

interface MemoryItemRow {
  memory_item_id: string;
  memory_scope_id: string;
  workspace_id: string;
  scope_kind: MemoryScopeKind;
  text: string;
  revision: number;
  expires_at: string | null;
  invalidated_at: string | null;
  updated_at: string;
}

export interface MemorySearchItem {
  memoryItemId: string;
  memoryScopeId: string;
  scopeKind: MemoryScopeKind;
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

interface ReceiptRow {
  operation: "add" | "update" | "invalidate";
  input_hash: string;
  result_json: string;
}

interface MutationResult {
  memoryItemId: string;
  memoryScopeId: string;
  scopeKind: MemoryScopeKind;
  revision: number;
  invalidated: boolean;
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
  z.object({ query: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ memoryItemId: z.string().uuid() }).strict(),
], { error: "Send exactly one of query or memoryItemId: query to search, memoryItemId to reread one known item." });

const AddInputSchema = z.object({
  scopeKind: z.enum(MEMORY_SCOPE_KINDS),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const UpdateInputSchema = z.object({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const InvalidateInputSchema = z.object({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

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
    .map((scope) => scope.kind)
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
    `This run cannot reach ${kind} memory. Its scopes are: ${scopeList(scopes)}.`,
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
      ? `This run may read ${kind} memory, and has no writable memory scope at all.`
      : `This run may read ${kind} memory but not write it. It may write: ${scopeList(writable)}.`,
    { reason: retryInstruction(scopes) },
  );
}

function d1Changes(result: D1Result<unknown>): number {
  return Number((result.meta as { changes?: unknown } | undefined)?.changes ?? 0);
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
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

async function ensureScope(
  env: Env,
  workspaceId: string,
  kind: MemoryScopeKind,
  ownerId: string,
  writable: boolean,
): Promise<MemoryScope> {
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, kind, owner_id) DO NOTHING`,
  ).bind(newId(), workspaceId, kind, ownerId, createdAt).run();
  const row = await env.DB.prepare(
    `SELECT memory_scope_id, workspace_id, kind, owner_id
       FROM memory_scopes
      WHERE workspace_id = ? AND kind = ? AND owner_id = ?`,
  ).bind(workspaceId, kind, ownerId).first<{
    memory_scope_id: string;
    workspace_id: string;
    kind: MemoryScopeKind;
    owner_id: string;
  }>();
  if (!row) throw new Error("memory_scope_creation_failed");
  return {
    memoryScopeId: row.memory_scope_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    ownerId: row.owner_id,
    writable,
  };
}

/** Resolve the complete memory scope union from host-owned run authority. */
export async function resolveMemoryAccess(
  env: Env,
  input: WorkstreamWorkflowInput,
): Promise<MemoryScope[]> {
  const [run, workstream] = await Promise.all([
    createHarnessRunObjectPort(env, input.workspaceId, input.workstreamId)
      .run({ runId: input.harnessRunId }),
    createIdentityObjectPort(env, input.workspaceId, input.workstreamId).identity(),
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

  if (input.automationSubscriptionId) {
    if (workstream.automation_subscription_id !== input.automationSubscriptionId) {
      throw new Error("memory_automation_workstream_mismatch");
    }
    const subscription = await env.DB.prepare(
      `SELECT scope, owner_user_id
         FROM automation_subscriptions
        WHERE id = ? AND workspace_id = ? AND status = 'active'`,
    ).bind(input.automationSubscriptionId, input.workspaceId).first<{
      scope: "personal" | "workspace";
      owner_user_id: string | null;
    }>();
    if (!subscription) throw new Error("memory_automation_subscription_not_found");
    if (subscription.scope === "personal") {
      if (
        input.executionPrincipal.type !== "user"
        || subscription.owner_user_id !== input.executionPrincipal.userId
      ) {
        throw new Error("memory_personal_automation_principal_mismatch");
      }
      scopes.push(await ensureScope(
        env,
        input.workspaceId,
        "user",
        input.executionPrincipal.userId,
        true,
      ));
    } else if (input.executionPrincipal.type !== "workspace") {
      throw new Error("memory_workspace_automation_principal_mismatch");
    }
    scopes.push(await ensureScope(
      env,
      input.workspaceId,
      "automation",
      input.automationSubscriptionId,
      true,
    ));
    return scopes;
  }

  // Everything below is the union for a run that is *not* an automation run,
  // and the run's own `automationSubscriptionId` is what decides that — not how
  // the work stream was created. This used to also demand
  // `origin_type === "ad_hoc"`, which read as a consistency check and was in
  // fact a refusal of every run a member's reply admits.
  // `assertRunAuthorityStillValid` treats a run with no subscription as a
  // non-automation run in any work stream, and that field is the run's
  // authority claim rather than a description of its container; this is the
  // memory union agreeing with it. See `docs/agent-harness.md` §Scoped durable
  // memory for the class this covers and the two questions left open.
  if (input.executionPrincipal.type === "user") {
    scopes.push(await ensureScope(
      env,
      input.workspaceId,
      "user",
      input.executionPrincipal.userId,
      true,
    ));
  }
  // A work-stream scope, though, belongs only to a work stream that owns one.
  // Migration 0036's `memory_scopes_validate_workstream_owner` refused to create
  // one for a work stream an automation made, because every run of a
  // subscription gets a fresh work stream and memory left in one of them can
  // never be recalled — which is what the subscription's own scope exists for.
  // 0090 dropped that trigger with the rest of D1's product enforcement when
  // memory moved into WorkspaceDO, and nothing retired the rule it stated.
  //
  // Held here rather than back in the schema, and not for lack of visibility:
  // `workspace_workstream_directory` does carry both fields. But that row is a
  // generation-fenced projection behind a waterline, so a constraint reading it
  // would gate scope creation on projection timing and fail closed on a work
  // stream not yet projected — and memory rows there deliberately hold
  // work-stream ids as opaque provenance rather than foreign keys
  // (`docs/workstream-durable-object.md`). This function reads the identity
  // object directly and owes no such timing. It reads it safely only because
  // every automation producer provisions the work stream before dispatching a
  // run into it; a producer that dispatched first would reach this with the
  // identity root's `origin_type` default still standing.
  //
  // Only the subscription id is tested, where 0036 tested the origin label too.
  // The label is a second name for the same bit — the three automation
  // producers set both together and nothing updates either afterwards — and it
  // is the weaker of the two: the identity root declares
  // `origin_type TEXT NOT NULL DEFAULT 'ad_hoc'` with no CHECK, so keying on it
  // would silently drop this scope for any value that is neither. The
  // subscription id is the fact the rule is about, and the same field the
  // automation branch above keys on.
  if (!workstream.automation_subscription_id) {
    scopes.push(await ensureScope(
      env,
      input.workspaceId,
      "workstream",
      input.workstreamId,
      input.executionPrincipal.type === "user",
    ));
  }
  return scopes;
}

async function searchFts(
  env: Env,
  scopeIds: readonly string[],
  query: string,
): Promise<RankedCandidate[]> {
  const match = ftsQuery(query);
  if (!match || scopeIds.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT item.memory_item_id, item.revision
       FROM memory_items_fts
       JOIN memory_items item ON item.rowid = memory_items_fts.rowid
      WHERE memory_items_fts MATCH ?
        AND item.memory_scope_id IN (${placeholders(scopeIds.length)})
        AND item.invalidated_at IS NULL
        AND (item.expires_at IS NULL OR item.expires_at > ?)
      ORDER BY bm25(memory_items_fts), item.updated_at DESC
      LIMIT ${SEARCH_CANDIDATES_PER_LEG}`,
  ).bind(match, ...scopeIds, nowIso()).all<{
    memory_item_id: string;
    revision: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    memoryItemId: row.memory_item_id,
    revision: Number(row.revision),
  }));
}

async function embedQuery(env: Env, query: string): Promise<number[]> {
  if (!env.AI) throw new Error("memory_embedding_binding_unavailable");
  const output = await env.AI.run(MEMORY_EMBEDDING_MODEL, {
    queries: [query],
    instruction: "Retrieve durable facts and preferences relevant to the current Rally task.",
  });
  const embedding = output.data?.[0];
  if (!embedding?.length) throw new Error("memory_query_embedding_empty");
  return embedding;
}

async function embedDocument(env: Env, text: string): Promise<number[]> {
  if (!env.AI) throw new Error("memory_embedding_binding_unavailable");
  const output = await env.AI.run(MEMORY_EMBEDDING_MODEL, { documents: [text] });
  const embedding = output.data?.[0];
  if (!embedding?.length) throw new Error("memory_document_embedding_empty");
  return embedding;
}

async function searchVector(
  env: Env,
  scopes: readonly MemoryScope[],
  query: string,
): Promise<RankedCandidate[]> {
  if (!env.MEMORY_INDEX) throw new Error("memory_vector_binding_unavailable");
  const embedding = await embedQuery(env, query);
  const matchesByScope = await Promise.all(scopes.map((scope) => env.MEMORY_INDEX.query(
    embedding,
    {
      topK: SEARCH_CANDIDATES_PER_LEG,
      namespace: scope.memoryScopeId,
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
): Promise<MemoryItemRow[]> {
  if (scopeIds.length === 0 || memoryItemIds.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT item.memory_item_id, item.memory_scope_id, item.workspace_id,
            scope.kind AS scope_kind, item.text, item.revision, item.expires_at,
            item.invalidated_at, item.updated_at
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.workspace_id = ?
        AND item.memory_scope_id IN (${placeholders(scopeIds.length)})
        AND item.memory_item_id IN (${placeholders(memoryItemIds.length)})
        AND item.invalidated_at IS NULL
        AND (item.expires_at IS NULL OR item.expires_at > ?)`,
  ).bind(workspaceId, ...scopeIds, ...memoryItemIds, nowIso()).all<MemoryItemRow>();
  return rows.results ?? [];
}

async function recordAccess(env: Env, itemIds: readonly string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const at = nowIso();
  await env.DB.batch(itemIds.map((memoryItemId) => env.DB.prepare(
    `UPDATE memory_items
        SET access_count = access_count + 1, last_accessed_at = ?
      WHERE memory_item_id = ? AND invalidated_at IS NULL`,
  ).bind(at, memoryItemId)));
}

async function hybridMemorySearch(
  env: Env,
  input: WorkstreamWorkflowInput,
  query: string,
  trackAccess = true,
): Promise<MemorySearchResult & { scopes: MemoryScope[] }> {
  const scopes = await resolveMemoryAccess(env, input);
  if (scopes.length === 0) {
    return { query, retrievalMode: "none", results: [], scopes };
  }
  const scopeIds = scopes.map((scope) => scope.memoryScopeId);
  const [ftsSettled, vectorSettled] = await Promise.allSettled([
    searchFts(env, scopeIds, query),
    searchVector(env, scopes, query),
  ]);
  const fts = ftsSettled.status === "fulfilled" ? ftsSettled.value : [];
  const vector = vectorSettled.status === "fulfilled" ? vectorSettled.value : [];
  const retrievalMode: MemoryRetrievalMode = ftsSettled.status === "fulfilled"
    ? vectorSettled.status === "fulfilled" ? "hybrid" : "fts_only"
    : vectorSettled.status === "fulfilled" ? "vector_only" : "none";

  // Re-resolve after both retrieval legs so membership, principal, automation,
  // and scope authorization cannot be revoked mid-search yet still leak rows.
  const reauthorizedScopes = await resolveMemoryAccess(env, input);
  const reauthorizedIds = new Set(reauthorizedScopes.map((scope) => scope.memoryScopeId));
  const canonicalScopeIds = scopeIds.filter((scopeId) => reauthorizedIds.has(scopeId));
  const candidateIds = [...new Set([...fts, ...vector].map((candidate) => candidate.memoryItemId))];
  const canonicalRows = await loadCanonicalItems(
    env,
    input.workspaceId,
    canonicalScopeIds,
    candidateIds,
  );
  const canonicalById = new Map(canonicalRows.map((row) => [row.memory_item_id, row]));
  const scores = new Map<string, number>();
  for (const candidates of [fts, vector]) {
    candidates.forEach((candidate, index) => {
      const canonical = canonicalById.get(candidate.memoryItemId);
      if (!canonical || Number(canonical.revision) !== candidate.revision) return;
      scores.set(
        candidate.memoryItemId,
        (scores.get(candidate.memoryItemId) ?? 0) + 1 / (RRF_OFFSET + index + 1),
      );
    });
  }
  const ranked = [...scores.entries()]
    .sort(([leftId, leftScore], [rightId, rightScore]) => {
      if (rightScore !== leftScore) return rightScore - leftScore;
      const updated = canonicalById.get(rightId)!.updated_at.localeCompare(
        canonicalById.get(leftId)!.updated_at,
      );
      return updated || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
    })
    .slice(0, SEARCH_RESULTS)
    .map(([memoryItemId]): MemorySearchItem => {
      const row = canonicalById.get(memoryItemId)!;
      return {
        memoryItemId: row.memory_item_id,
        memoryScopeId: row.memory_scope_id,
        scopeKind: row.scope_kind,
        text: row.text,
        revision: Number(row.revision),
        expiresAt: row.expires_at,
      };
    });
  if (trackAccess) {
    // Retrieval remains available when non-authoritative access counters cannot
    // be updated; the canonical authorization/read above has already succeeded.
    await recordAccess(env, ranked.map((item) => item.memoryItemId)).catch(() => undefined);
  }
  return { query, retrievalMode, results: ranked, scopes: reauthorizedScopes };
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
  const visible = row && currentlyAuthorized.has(row.memory_scope_id) ? row : null;
  if (visible) await recordAccess(env, [visible.memory_item_id]).catch(() => undefined);
  return {
    query: null,
    memoryItemId,
    retrievalMode: "exact" as const,
    results: visible ? [{
      memoryItemId: visible.memory_item_id,
      memoryScopeId: visible.memory_scope_id,
      scopeKind: visible.scope_kind,
      text: visible.text,
      revision: Number(visible.revision),
      expiresAt: visible.expires_at,
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
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const query = rawQuery.trim() || "Current work-stream objective and trigger";
  const runs = createHarnessRunObjectPort(env, input.workspaceId, input.workstreamId);
  const fence = {
    runId: input.harnessRunId,
    attemptId: lease.attemptId,
    owner: lease.owner,
    now: Date.now(),
  };
  const existing = await runs.memoryContext(fence);
  if (existing) return parseFrozenContext(existing);

  const recalled = await hybridMemorySearch(env, input, query);
  const memoryScopeIds = recalled.scopes.map((scope) => scope.memoryScopeId).sort();
  const results = recalled.results;
  const memoryContextHash = await sha256(stableJson({
    memoryScopeIds,
    query,
    retrievalMode: recalled.retrievalMode,
    results,
  }));
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
    retrievalMode: recalled.retrievalMode,
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
  operation: ReceiptRow["operation"],
  inputHash: string,
): Promise<MutationResult | null> {
  const row = await env.DB.prepare(
    `SELECT operation, input_hash, result_json
       FROM memory_mutations
      WHERE receipt_id = ? AND workspace_id = ? AND harness_run_id = ?`,
  ).bind(receiptId, input.workspaceId, input.harnessRunId).first<ReceiptRow>();
  if (!row) return null;
  if (row.operation !== operation || row.input_hash !== inputHash) {
    throw new Error("memory_mutation_receipt_mismatch");
  }
  return JSON.parse(row.result_json) as MutationResult;
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
    scopeKind: scope.kind,
    revision: 1,
    invalidated: false,
  };
  const provenance = {
    source: "agent",
    harnessRunId: input.harnessRunId,
    workstreamId: input.workstreamId,
    executionPrincipal: input.executionPrincipal,
    rationale: args.rationale,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_items
           (memory_item_id, memory_scope_id, workspace_id, text, revision, expires_at,
            provenance_json, last_mutation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        memoryItemId,
        scope.memoryScopeId,
        input.workspaceId,
        args.text,
        args.expiresAt ?? null,
        JSON.stringify(provenance),
        memoryMutationId,
        at,
        at,
      ),
      env.DB.prepare(
        `INSERT INTO memory_mutations
           (memory_mutation_id, receipt_id, memory_item_id, memory_scope_id, workspace_id,
            operation, prior_revision, resulting_revision, actor_principal_json,
            harness_run_id, workstream_id, rationale, input_hash, mutation_json,
            result_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'add', NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        memoryMutationId,
        receiptId,
        memoryItemId,
        scope.memoryScopeId,
        input.workspaceId,
        JSON.stringify(input.executionPrincipal),
        input.harnessRunId,
        input.workstreamId,
        args.rationale,
        inputHash,
        JSON.stringify({ text: args.text, expiresAt: args.expiresAt ?? null }),
        JSON.stringify(result),
        at,
      ),
      env.DB.prepare(
        `INSERT INTO memory_index_outbox
           (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision,
            operation, status, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'upsert', 'pending', ?, ?, ?)`,
      ).bind(newId(), memoryItemId, scope.memoryScopeId, input.workspaceId, at, at, at),
    ]);
  } catch (error) {
    const raced = await loadReceipt(env, input, receiptId, "add", inputHash);
    if (raced) return mutationToolResult(raced, "Added durable memory");
    throw error;
  }
  return mutationToolResult(result, "Added durable memory");
}

async function loadWritableItem(
  env: Env,
  input: WorkstreamWorkflowInput,
  memoryItemId: string,
): Promise<{ row: MemoryItemRow; scope: MemoryScope }> {
  const scopes = await resolveMemoryAccess(env, input);
  const row = await env.DB.prepare(
    `SELECT item.memory_item_id, item.memory_scope_id, item.workspace_id,
            scope.kind AS scope_kind, item.text, item.revision, item.expires_at,
            item.invalidated_at, item.updated_at
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.memory_item_id = ? AND item.workspace_id = ?`,
  ).bind(memoryItemId, input.workspaceId).first<MemoryItemRow>();
  if (!row) throw new Error("memory_item_not_found");
  const scope = scopes.find((candidate) => candidate.memoryScopeId === row.memory_scope_id);
  if (!scope) throw new Error("memory_item_not_authorized");
  if (!scope.writable) throw new Error(`memory_scope_not_writable:${scope.kind}`);
  return { row, scope };
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
  const { row, scope } = await loadWritableItem(env, input, args.memoryItemId);
  if (row.invalidated_at) throw new Error("memory_item_invalidated");
  if (Number(row.revision) !== args.expectedRevision) throw memoryRevisionConflict();
  const nextRevision = args.expectedRevision + 1;
  const memoryMutationId = newId();
  const at = nowIso();
  const expiresAt = args.expiresAt ?? row.expires_at;
  const result: MutationResult = {
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    scopeKind: scope.kind,
    revision: nextRevision,
    invalidated: false,
  };
  try {
    const batch = await env.DB.batch([
      env.DB.prepare(
        `UPDATE memory_items
            SET text = ?, revision = ?, expires_at = ?, last_mutation_id = ?, updated_at = ?
          WHERE memory_item_id = ? AND workspace_id = ? AND memory_scope_id = ?
            AND revision = ? AND invalidated_at IS NULL`,
      ).bind(
        args.text,
        nextRevision,
        expiresAt,
        memoryMutationId,
        at,
        args.memoryItemId,
        input.workspaceId,
        scope.memoryScopeId,
        args.expectedRevision,
      ),
      env.DB.prepare(
        `INSERT INTO memory_mutations
           (memory_mutation_id, receipt_id, memory_item_id, memory_scope_id, workspace_id,
            operation, prior_revision, resulting_revision, actor_principal_json,
            harness_run_id, workstream_id, rationale, input_hash, mutation_json,
            result_json, created_at)
         SELECT ?, ?, memory_item_id, memory_scope_id, workspace_id, 'update', ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?
           FROM memory_items
          WHERE memory_item_id = ? AND last_mutation_id = ?`,
      ).bind(
        memoryMutationId,
        receiptId,
        args.expectedRevision,
        nextRevision,
        JSON.stringify(input.executionPrincipal),
        input.harnessRunId,
        input.workstreamId,
        args.rationale,
        inputHash,
        JSON.stringify({ text: args.text, expiresAt }),
        JSON.stringify(result),
        at,
        args.memoryItemId,
        memoryMutationId,
      ),
      env.DB.prepare(
        `INSERT INTO memory_index_outbox
           (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision,
            operation, status, available_at, created_at, updated_at)
         SELECT ?, memory_item_id, memory_scope_id, workspace_id, ?, 'upsert',
                'pending', ?, ?, ?
           FROM memory_items
          WHERE memory_item_id = ? AND last_mutation_id = ?`,
      ).bind(
        newId(),
        nextRevision,
        at,
        at,
        at,
        args.memoryItemId,
        memoryMutationId,
      ),
    ]);
    if (d1Changes(batch[0]!) === 0) {
      const raced = await loadReceipt(env, input, receiptId, "update", inputHash);
      if (raced) return mutationToolResult(raced, "Updated durable memory");
      throw memoryRevisionConflict();
    }
  } catch (error) {
    const raced = await loadReceipt(env, input, receiptId, "update", inputHash);
    if (raced) return mutationToolResult(raced, "Updated durable memory");
    throw error;
  }
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
  const { row, scope } = await loadWritableItem(env, input, args.memoryItemId);
  if (row.invalidated_at) throw new Error("memory_item_invalidated");
  if (Number(row.revision) !== args.expectedRevision) throw memoryRevisionConflict();
  const nextRevision = args.expectedRevision + 1;
  const memoryMutationId = newId();
  const at = nowIso();
  const principalJson = JSON.stringify(input.executionPrincipal);
  const result: MutationResult = {
    memoryItemId: args.memoryItemId,
    memoryScopeId: scope.memoryScopeId,
    scopeKind: scope.kind,
    revision: nextRevision,
    invalidated: true,
  };
  try {
    const batch = await env.DB.batch([
      env.DB.prepare(
        `UPDATE memory_items
            SET revision = ?, invalidated_at = ?, invalidated_by_principal_json = ?,
                invalidation_reason = ?, last_mutation_id = ?, updated_at = ?
          WHERE memory_item_id = ? AND workspace_id = ? AND memory_scope_id = ?
            AND revision = ? AND invalidated_at IS NULL`,
      ).bind(
        nextRevision,
        at,
        principalJson,
        args.reason,
        memoryMutationId,
        at,
        args.memoryItemId,
        input.workspaceId,
        scope.memoryScopeId,
        args.expectedRevision,
      ),
      env.DB.prepare(
        `INSERT INTO memory_mutations
           (memory_mutation_id, receipt_id, memory_item_id, memory_scope_id, workspace_id,
            operation, prior_revision, resulting_revision, actor_principal_json,
            harness_run_id, workstream_id, rationale, input_hash, mutation_json,
            result_json, created_at)
         SELECT ?, ?, memory_item_id, memory_scope_id, workspace_id, 'invalidate', ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?
           FROM memory_items
          WHERE memory_item_id = ? AND last_mutation_id = ?`,
      ).bind(
        memoryMutationId,
        receiptId,
        args.expectedRevision,
        nextRevision,
        principalJson,
        input.harnessRunId,
        input.workstreamId,
        args.reason,
        inputHash,
        JSON.stringify({ reason: args.reason }),
        JSON.stringify(result),
        at,
        args.memoryItemId,
        memoryMutationId,
      ),
      env.DB.prepare(
        `INSERT INTO memory_index_outbox
           (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision,
            operation, status, available_at, created_at, updated_at)
         SELECT ?, memory_item_id, memory_scope_id, workspace_id, ?, 'delete',
                'pending', ?, ?, ?
           FROM memory_items
          WHERE memory_item_id = ? AND last_mutation_id = ?`,
      ).bind(
        newId(),
        nextRevision,
        at,
        at,
        at,
        args.memoryItemId,
        memoryMutationId,
      ),
    ]);
    if (d1Changes(batch[0]!) === 0) {
      const raced = await loadReceipt(env, input, receiptId, "invalidate", inputHash);
      if (raced) return mutationToolResult(raced, "Invalidated durable memory");
      throw memoryRevisionConflict();
    }
  } catch (error) {
    const raced = await loadReceipt(env, input, receiptId, "invalidate", inputHash);
    if (raced) return mutationToolResult(raced, "Invalidated durable memory");
    throw error;
  }
  return mutationToolResult(result, "Invalidated durable memory");
}

export function createMemoryTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  return [
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
            query: { type: "string", minLength: 1, maxLength: 2_000 },
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
            scopeKind: { type: "string", enum: MEMORY_SCOPE_KINDS },
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
}

interface OutboxRow {
  outbox_id: string;
  memory_item_id: string;
  memory_scope_id: string;
  workspace_id: string;
  revision: number;
  operation: "upsert" | "delete";
  attempt_count: number;
}

async function claimOutboxRow(env: Env, row: OutboxRow, leaseToken: string): Promise<boolean> {
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const result = await env.DB.prepare(
    `UPDATE memory_index_outbox
        SET status = 'processing', lease_token = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE outbox_id = ? AND (
        (status = 'pending' AND available_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )`,
  ).bind(leaseToken, leaseExpiresAt, now, row.outbox_id, now, now).run();
  return d1Changes(result) > 0;
}

async function completeOutboxRow(env: Env, outboxId: string, leaseToken: string): Promise<void> {
  const at = nowIso();
  await env.DB.prepare(
    `UPDATE memory_index_outbox
        SET status = 'completed', completed_at = ?, lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE outbox_id = ? AND status = 'processing' AND lease_token = ?`,
  ).bind(at, at, outboxId, leaseToken).run();
}

async function retryOutboxRow(
  env: Env,
  row: OutboxRow,
  leaseToken: string,
  error: unknown,
): Promise<void> {
  const delaySeconds = Math.min(3_600, 2 ** Math.min(12, row.attempt_count + 1));
  const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
  const at = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(
    `UPDATE memory_index_outbox
        SET status = 'pending', available_at = ?, lease_token = NULL,
            lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND status = 'processing' AND lease_token = ?`,
  ).bind(availableAt, message.slice(0, 2_000), at, row.outbox_id, leaseToken).run();
}

async function projectOutboxRow(env: Env, row: OutboxRow): Promise<void> {
  if (!env.MEMORY_INDEX) throw new Error("memory_vector_binding_unavailable");
  const current = await env.DB.prepare(
    `SELECT item.text, item.revision, item.invalidated_at, item.expires_at,
            scope.kind AS scope_kind
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.memory_item_id = ? AND item.memory_scope_id = ? AND item.workspace_id = ?`,
  ).bind(row.memory_item_id, row.memory_scope_id, row.workspace_id).first<{
    text: string;
    revision: number;
    invalidated_at: string | null;
    expires_at: string | null;
    scope_kind: MemoryScopeKind;
  }>();
  const priorVectorId = row.revision > 1 ? vectorId(row.memory_item_id, row.revision - 1) : null;
  if (
    row.operation === "delete"
    || !current
    || Number(current.revision) !== row.revision
    || current.invalidated_at
    || (current.expires_at != null && current.expires_at <= nowIso())
  ) {
    await env.MEMORY_INDEX.deleteByIds([
      vectorId(row.memory_item_id, row.revision),
      ...(priorVectorId ? [priorVectorId] : []),
    ]);
    return;
  }
  const embedding = await embedDocument(env, current.text);
  await env.MEMORY_INDEX.upsert([{
    id: vectorId(row.memory_item_id, row.revision),
    values: embedding,
    namespace: row.memory_scope_id,
    metadata: {
      workspaceId: row.workspace_id,
      scopeKind: current.scope_kind,
      revision: row.revision,
    },
  }]);
  if (priorVectorId) await env.MEMORY_INDEX.deleteByIds([priorVectorId]);
}

/** Replay the transactional embedding outbox. Safe for concurrent cron workers. */
export async function processMemoryIndexOutbox(
  env: Env,
  limit = 50,
  workspaceId?: string,
): Promise<number> {
  if (!workspaceId && env.WORKSPACE_DOS) throw new Error("memory_index_workspace_required");
  if (workspaceId) env = withWorkspaceRuntimeDatabase(env, workspaceId);
  if (!env.AI || !env.MEMORY_INDEX) return 0;
  const now = nowIso();
  const rows = await env.DB.prepare(
    `SELECT outbox_id, memory_item_id, memory_scope_id, workspace_id,
            revision, operation, attempt_count
       FROM memory_index_outbox
      WHERE (status = 'pending' AND available_at <= ?)
         OR (status = 'processing' AND lease_expires_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
  ).bind(now, now, Math.max(1, Math.min(200, limit))).all<OutboxRow>();
  let completed = 0;
  for (const row of rows.results ?? []) {
    const leaseToken = newId();
    if (!await claimOutboxRow(env, row, leaseToken)) continue;
    try {
      await projectOutboxRow(env, row);
      await completeOutboxRow(env, row.outbox_id, leaseToken);
      completed += 1;
    } catch (error) {
      await retryOutboxRow(env, row, leaseToken, error);
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
