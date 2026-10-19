import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { asWorkspaceId, MEMORY_RECALL_QUERY_LIMIT } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type { HarnessTool, HarnessToolResult } from "@rally/agent-harness";
import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceMemoryScopeSchema } from "../durable-objects/workspace-memory-protocol";
import {
  WorkspaceMemoryForgetResultSchema,
  WorkspaceMemoryRecallResultSchema,
  WorkspaceMemoryRememberResultSchema,
  type MemoryConversation,
  type MemoryDerivedFrom,
  type MemoryFact,
  type MemoryReader,
  type WorkspaceMemoryRecallResult,
} from "../durable-objects/workspace-memory-facts-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { memoryScopeRows } from "./memory-scope-cache";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { diagnosticErrorCode, logWarn } from "../observability/logger";

/**
 * Agent memory as the harness sees it: the `rally:memory` plugin's three tools
 * over the fact store in `WorkspaceDO`, and the scope resolution that
 * `rally_tables` still hangs off.
 *
 * The tools never choose a scope, a subject, or a conversation. The host
 * derives who is acting (the run's frozen principal), where (the run's
 * conversation) and what trust class a remembered fact carries (the input that
 * started the run); `WorkspaceDO` decides what is visible and what may be
 * retracted from the facts' own sources. The sweep that writes most facts
 * lives in `memory-sweep-service.ts`. See `docs/agent-memory.md`.
 */

export const MEMORY_SCOPE_KINDS = ["workstream", "sidekick", "user", "workspace"] as const;

export type MemoryScopeKind = typeof MEMORY_SCOPE_KINDS[number];

export interface MemoryScope {
  memoryScopeId: string;
  workspaceId: string;
  kind: MemoryScopeKind;
  ownerId: string;
  writable: boolean;
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

export async function ensureScope(
  env: Env,
  workspaceId: string,
  kind: MemoryScopeKind,
  ownerId: string,
  writable: boolean,
): Promise<MemoryScope> {
  const key = JSON.stringify([workspaceId, kind, ownerId]);
  const known = memoryScopeRows.get(key);
  if (known) return { ...known, writable };
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const scope = WorkspaceMemoryScopeSchema.parse(await workspace.ensureMemoryScope({
    workspaceId,
    proposedScopeId: newId(),
    kind,
    ownerId,
    at: nowIso(),
  }));
  const row = {
    memoryScopeId: scope.memoryScopeId,
    workspaceId: scope.workspaceId,
    kind: scope.kind,
    ownerId: scope.ownerId,
  };
  memoryScopeRows.set(key, row);
  return { ...row, writable };
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
    scopes.push(await ensureScope(env, input.workspaceId, "sidekick", input.parentId, true));
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

// -- The three tools ----------------------------------------------------------

const RecallInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(MEMORY_RECALL_QUERY_LIMIT),
  limit: z.number().int().min(1).max(25).optional(),
});

const RememberInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(600),
  kind: z.enum(["standing", "situational"]),
  validUntil: z.string().datetime({ offset: true }).optional(),
  about: z.enum(["me", "this conversation"]).optional(),
});

const ForgetInputSchema = z.strictObject({
  factId: z.string().trim().min(1),
});

const RECALL_DEFAULT_LIMIT = 10;

/** The subject label the model reads; never an id it could reuse as a scope. */
const PERSON_LABEL = "the person you are working for";
const ORGANIZATION_LABEL = "this Organization";

function memoryUnavailable(env: Env, input: WorkstreamWorkflowInput, error: unknown): MemoryToolError {
  // A generic code is a defect without its reason beside it: the log carries
  // the cause the model is not told.
  logWarn(env, "memory_tool_unavailable", {
    workspace_id: input.workspaceId,
    workstream_id: input.parentId,
    substream_id: input.substreamId ?? "0",
    harness_run_id: input.harnessRunId,
    reason: diagnosticErrorCode(error, "memory_unavailable"),
    detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
  });
  return new MemoryToolError(
    "memory_unavailable",
    "Memory is not reachable right now. Continue without it; do not retry this call.",
    { reason: "Memory is not reachable right now. Continue without it; do not retry this call." },
  );
}

/** The conversation a run acts in, as the fact store names one. */
function conversationOf(input: WorkstreamWorkflowInput): MemoryConversation {
  return { parentKind: input.parentKind, parentId: input.parentId, substreamId: input.substreamId ?? "0" };
}

/**
 * Who is acting: the Sidekick, for any run of a Sidekick or in its
 * conversation; otherwise a person from the frozen principal, or the
 * conversation itself when a workspace principal runs in a Thread and nobody
 * in particular is asking.
 *
 * The Sidekick is checked first. A Sidekick run carries the principal it runs
 * as (`run_as_user`), and reading as that person would hand the run — and
 * whoever reads its output — that person's own facts.
 */
function readerOf(
  input: Pick<WorkstreamWorkflowInput, "automationRun" | "parentKind" | "parentId" | "executionPrincipal">,
): MemoryReader {
  if (input.automationRun || input.parentKind === "automation") {
    return { kind: "sidekick", automationId: input.automationRun?.automationId ?? input.parentId };
  }
  if (input.executionPrincipal.type === "user") return { kind: "person", userId: input.executionPrincipal.userId };
  return { kind: "conversation" };
}

/**
 * The trust class of what started this run, which is what a remembered fact
 * inherits: a Slack or email trigger cannot talk the model into a `person`
 * fact, and an agent's message cannot either.
 */
export function derivedFromOf(input: WorkstreamWorkflowInput): Exclude<MemoryDerivedFrom, "mixed"> {
  if (input.agentExchange) return "agent";
  if (input.activityId || input.slackOrigin || input.reason === "inbound_email" || input.reason.startsWith("slack_")) {
    return "external";
  }
  if (input.automationRun && !input.triggerMessageId) return "agent";
  return "person";
}

function iso(instant: number | null): string | null {
  return instant === null ? null : new Date(instant).toISOString();
}

function renderFact(fact: MemoryFact, titles: ReadonlyMap<string, string>, now: number) {
  const subjectLabel = fact.subjectKind === "person"
    ? PERSON_LABEL
    : fact.subjectKind === "organization"
      ? ORGANIZATION_LABEL
      : titles.get(`${fact.subjectKind}:${fact.subjectId}`) ?? fact.subjectKind;
  const source = fact.sourceConversations[0]!;
  return {
    factId: fact.factId,
    subject: { kind: fact.subjectKind, label: subjectLabel },
    kind: fact.kind,
    text: fact.text,
    validFrom: iso(fact.validFrom),
    validUntil: iso(fact.validUntil),
    validUntilBasis: fact.validUntilBasis,
    recordedAt: iso(fact.createdAt),
    derivedFrom: fact.derivedFrom,
    conflict: fact.conflict,
    expired: fact.validUntil !== null && fact.validUntil <= now,
    upcoming: fact.validFrom !== null && fact.validFrom > now,
    source: { conversationId: source, title: titles.get(source) ?? null },
  };
}

function titlesOf(result: WorkspaceMemoryRecallResult): Map<string, string> {
  return new Map(result.titles.map((entry) => [entry.key, entry.title]));
}

/**
 * The gate every tool call passes: the run exists, its principal is the one
 * frozen into it, the person is still a member, and this is a root run. An
 * inline child reaches no memory, as before.
 */
async function admitted(env: Env, input: WorkstreamWorkflowInput): Promise<boolean> {
  return (await resolveMemoryAccess(env, input)).length > 0;
}

async function recall(env: Env, input: WorkstreamWorkflowInput, raw: unknown): Promise<HarnessToolResult> {
  const args = RecallInputSchema.parse(raw);
  if (!(await admitted(env, input))) return { output: { facts: [] }, summary: "Recalled 0 facts" };
  const now = Date.now();
  let result: WorkspaceMemoryRecallResult;
  try {
    const workspace = await workspaceMemoryObject(env, input.workspaceId);
    result = WorkspaceMemoryRecallResultSchema.parse(await workspace.recallMemoryFacts({
      workspaceId: input.workspaceId,
      reader: readerOf(input),
      conversation: conversationOf(input),
      query: args.query,
      now,
      limit: args.limit ?? RECALL_DEFAULT_LIMIT,
    }));
  } catch (error) {
    throw memoryUnavailable(env, input, error);
  }
  const titles = titlesOf(result);
  const facts = result.facts.map((fact) => renderFact(fact, titles, now));
  return { output: { facts }, summary: `Recalled ${facts.length} fact${facts.length === 1 ? "" : "s"}` };
}

function requireReceipt(context: { providerIdempotencyKey?: string }): string {
  if (!context.providerIdempotencyKey) throw new Error("memory_receipt_missing");
  return context.providerIdempotencyKey;
}

async function remember(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = RememberInputSchema.parse(raw);
  if (args.kind === "situational" && args.validUntil === undefined) {
    throw new MemoryToolError(
      "memory_horizon_required",
      "A situational fact needs `validUntil`. Add the date the person gave, or record it as standing.",
      { reason: "Add validUntil as an RFC 3339 date-time, or set kind to standing." },
    );
  }
  if (args.kind === "standing" && args.validUntil !== undefined) {
    throw new MemoryToolError(
      "memory_horizon_forbidden",
      "A standing fact takes no `validUntil`. Remove it, or record the fact as situational.",
      { reason: "Remove validUntil, or set kind to situational." },
    );
  }
  const receiptId = requireReceipt(context);
  if (!(await admitted(env, input))) throw memoryUnavailable(env, input, new Error("memory_run_not_admitted"));
  const now = Date.now();
  let outcome;
  try {
    const workspace = await workspaceMemoryObject(env, input.workspaceId);
    outcome = WorkspaceMemoryRememberResultSchema.parse(await workspace.rememberMemoryFact({
      workspaceId: input.workspaceId,
      reader: readerOf(input),
      conversation: conversationOf(input),
      receiptId,
      harnessRunId: input.harnessRunId,
      factId: newId(),
      text: args.text,
      kind: args.kind,
      validUntil: args.validUntil === undefined ? null : Date.parse(args.validUntil),
      about: args.about ?? "this conversation",
      derivedFrom: derivedFromOf(input),
      now,
    }));
  } catch (error) {
    throw memoryUnavailable(env, input, error);
  }
  if (outcome.outcome === "personal_unavailable") {
    throw new MemoryToolError(
      "memory_personal_unavailable",
      "This run acts for a Sidekick, not a person, so `about: \"me\"` is not available. Record it about this conversation or say it could not be stored personally.",
      { reason: "Call memory_remember again without `about`, or tell the person it could not be stored personally." },
    );
  }
  const deduplicated = outcome.outcome === "deduplicated" || (outcome.outcome === "replayed" && outcome.deduplicated);
  const rendered = renderFact(outcome.fact, new Map(), now);
  return {
    output: {
      factId: rendered.factId,
      subject: rendered.subject,
      kind: rendered.kind,
      text: rendered.text,
      validFrom: rendered.validFrom,
      validUntil: rendered.validUntil,
      derivedFrom: rendered.derivedFrom,
      deduplicated,
    },
    summary: deduplicated ? "That fact was already remembered" : "Remembered one fact",
  };
}

async function forget(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = ForgetInputSchema.parse(raw);
  const receiptId = requireReceipt(context);
  if (!(await admitted(env, input))) throw memoryUnavailable(env, input, new Error("memory_run_not_admitted"));
  let outcome;
  try {
    const workspace = await workspaceMemoryObject(env, input.workspaceId);
    outcome = WorkspaceMemoryForgetResultSchema.parse(await workspace.forgetMemoryFact({
      workspaceId: input.workspaceId,
      reader: readerOf(input),
      conversation: conversationOf(input),
      receiptId,
      harnessRunId: input.harnessRunId,
      factId: args.factId,
      now: Date.now(),
    }));
  } catch (error) {
    throw memoryUnavailable(env, input, error);
  }
  switch (outcome.outcome) {
    case "retracted":
    case "already_retracted":
      return {
        output: { factId: outcome.fact.factId, retractedAt: iso(outcome.fact.retractedAt) },
        summary: outcome.outcome === "retracted" ? "Forgot one fact" : "That fact was already forgotten",
      };
    case "not_found":
      throw new MemoryToolError(
        "memory_fact_not_found",
        "No fact has that id. Search again and use a `factId` from the results.",
        { reason: "Call memory_recall and copy a factId from its results." },
      );
    case "not_visible":
      throw new MemoryToolError(
        "memory_fact_not_visible",
        "That fact is not one this conversation may see. Search again; if it is not in the results, say it could not be forgotten.",
        { reason: "Call memory_recall; if the fact is not in the results, tell the person it could not be forgotten." },
      );
    case "not_forgettable":
      throw new MemoryToolError(
        "memory_fact_not_forgettable",
        "That fact belongs to a Channel or to the Organization, and only an administrator may forget it. Tell the person it can be removed from the review surface by an administrator.",
        { reason: `This ${outcome.subjectKind} fact can be forgotten only by an administrator. Do not retry.` },
      );
  }
}

export function createMemoryTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  return [
    {
      definition: {
        name: "recall",
        description: "Search what Rally remembers that this conversation may use: facts about this Organization, this Channel, this Thread, this Breakout and the person you are working for. Returns facts with when they were true and where each was said. Nothing remembered on the subject is an empty list, not an error.",
        capability: "memory.recall",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_RECALL_QUERY_LIMIT,
              description: "Plain words for what the fact would be about, for example \"which deploy tool this team uses\" or \"when Priya is back\".",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 25,
              description: "How many facts to return, best match first. Defaults to 10.",
            },
          },
          required: ["query"],
        },
      },
      validateInput: (raw) => {
        const result = RecallInputSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: (raw) => recall(env, input, raw),
    },
    {
      definition: {
        name: "remember",
        description: "Record something a person asked Rally to remember. Say it as one or two plain sentences a later run can act on without this conversation. Give validUntil when the person said how long it holds; leave it out for something standing.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              minLength: 1,
              maxLength: 600,
              description: "The fact itself, as a standalone sentence, for example \"Dana prefers release notes as a bulleted summary, not prose.\" Not an instruction, and no pronoun pointing at something said here.",
            },
            kind: {
              type: "string",
              enum: ["standing", "situational"],
              description: "`standing` for something that stays true until it changes; `situational` for something with an end the person named, which then needs validUntil.",
            },
            validUntil: {
              type: "string",
              format: "date-time",
              description: "When a situational fact stops holding, as an RFC 3339 date-time such as 2026-10-27T00:00:00Z. Required for situational; omit for standing.",
            },
            about: {
              type: "string",
              enum: ["me", "this conversation"],
              description: "`me` files the fact under the person you are working for, so it follows them to every conversation. Defaults to `this conversation`.",
            },
          },
          required: ["text", "kind"],
        },
      },
      serial: true,
      validateInput: (raw) => {
        const result = RememberInputSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: (raw, context) => remember(env, input, raw, context),
    },
    {
      definition: {
        name: "forget",
        description: "Retract one remembered fact a person asked Rally to forget, by the factId a recall returned. You may forget a fact about the person you are working for, or a fact this conversation itself established. A Channel's or the Organization's facts can be forgotten only when an administrator asks; otherwise say so. Retraction is immediate for every later run and cannot be undone by you.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            factId: { type: "string", minLength: 1, description: "The fact to retract, copied exactly from a memory_recall result." },
          },
          required: ["factId"],
        },
      },
      serial: true,
      validateInput: (raw) => {
        const result = ForgetInputSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: (raw, context) => forget(env, input, raw, context),
    },
  ];
}
