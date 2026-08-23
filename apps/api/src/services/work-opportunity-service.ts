import {
  renderWorkOpportunityAdmissionMessages,
  renderWorkOpportunityRankingMessages,
} from "@avalon/agent-harness";
import {
  ConnectorError,
} from "@avalon/connectors";
import {
  AutomationPluginIconSchema,
  WorkOpportunityPageSchema,
  asWorkspaceId,
  asWorkstreamId,
  type Scope,
  type UserId,
  type WorkOpportunity,
  type WorkspaceId,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceOpportunityRankingCandidatesResultSchema,
  type WorkspaceOpportunityWorkflowInput,
} from "../durable-objects/workspace-opportunity-protocol";
import { WorkspaceConnectorEventSchema } from "../durable-objects/workspace-connector-event-protocol";
import { SUGGESTED_CONTEXT_ENABLED } from "../lib/suggested-context";
import { resolveAgentModelRouting } from "./agent-model-flags";
import { createActivitySuggestion } from "./activity-suggestion-service";
import { hydrateConnectorActivitySource } from "./integrations";
import { logWarn } from "../observability/logger";
import { runStructuredInference } from "./structured-inference";
import { WorkstreamService } from "./workstream-service";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { withWorkspaceRuntimeDatabase, workspaceRuntimeDatabase } from "./workspace-runtime-database";

const MAX_BATCH_EVENTS = 16;
const MAX_BATCH_CHARACTERS = 24_000;
const MAX_MODEL_CONCURRENCY = 3;
const MAX_RANK_CANDIDATES = 12;
const MAX_RANK_CHARACTERS = 80_000;
const MAX_RANK_CANDIDATE_CHARACTERS = 12_000;
const MAX_RANK_ROUNDS = 10;
const MAX_PROVENANCE_DEPTH = 4;
const MAX_PROVENANCE_NODES = 32;
const OPPORTUNITY_TTL_MS = 14 * 24 * 60 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const IMPRESSION_RERANK_INTERVAL_MS = 60 * 60_000;
// Long enough for a burst of admissions in one window to schedule a single
// ranking rather than one per decision, short enough that a member who is in
// the app watching does not notice the wait.
const DUE_DEBOUNCE_MS = 2 * 60_000;
// Seen this recently and the member is presumed to be looking at Avalon now, so
// their set is ranked ahead of everyone else's.
// Not seen for this long and no amount of incoming activity earns them a model
// tournament. Their set is left due and is picked up on the first scheduler pass
// after they next authenticate.
// Wall-clock a single member's tournament may spend before it settles for the
// finalists it already has. The point is that it always writes something.
const RANK_BUDGET_MS = 2 * 60_000;
// Marking members due is one statement each, so the list is chunked at the size
// the rest of the repository treats as a safe D1 batch.
const MAX_DUE_BATCH_STATEMENTS = 75;

const UserLinkDecisionSchema = z.object({
  userId: z.string().uuid().nullable(),
  role: z.string().min(1).max(80),
  resolution: z.enum(["verified", "inferred", "ambiguous", "unresolved"]),
  reasoning: z.string().max(4_000),
  sourceId: z.string().min(1).max(200),
  sourceText: z.string().max(1_000),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().positive().nullable(),
}).strict();

const AdmissionDecisionSchema = z.object({
  action: z.enum(["add", "ignore", "update_existing", "route_existing"]),
  existingTargetId: z.string().uuid().nullable(),
  displayPrompt: z.string().max(180),
  executionPrompt: z.string().max(20_000),
  admissionReasoning: z.string().max(20_000),
  linkedUsers: z.array(UserLinkDecisionSchema).max(30),
  sourceIds: z.array(z.string().min(1).max(200)).min(1).max(16),
}).strict();
const AdmissionResultSchema = z.object({ decisions: z.array(AdmissionDecisionSchema).max(4) }).strict();

const admissionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "ignore", "update_existing", "route_existing"] },
          existingTargetId: { type: ["string", "null"] },
          displayPrompt: { type: "string" },
          executionPrompt: { type: "string" },
          admissionReasoning: { type: "string" },
          linkedUsers: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                userId: { type: ["string", "null"] },
                role: { type: "string" },
                resolution: { type: "string", enum: ["verified", "inferred", "ambiguous", "unresolved"] },
                reasoning: { type: "string" },
                sourceId: { type: "string" },
                sourceText: { type: "string" },
                startOffset: { type: ["integer", "null"] },
                endOffset: { type: ["integer", "null"] },
              },
              required: ["userId", "role", "resolution", "reasoning", "sourceId", "sourceText", "startOffset", "endOffset"],
            },
          },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["action", "existingTargetId", "displayPrompt", "executionPrompt", "admissionReasoning", "linkedUsers", "sourceIds"],
      },
    },
  },
  required: ["decisions"],
};

const RankingResultSchema = z.object({
  orderedOpportunityIds: z.array(z.string().uuid()).max(4),
  rankingReasoning: z.string().min(1).max(20_000),
}).strict();
const rankingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    orderedOpportunityIds: { type: "array", maxItems: 4, items: { type: "string", format: "uuid" } },
    rankingReasoning: { type: "string", minLength: 1, maxLength: 20_000 },
  },
  required: ["orderedOpportunityIds", "rankingReasoning"],
};

interface WindowRow {
  id: string;
  workspace_id: string;
  partition_key: string;
  audience_scope: "personal" | "workspace";
  audience_user_id: string | null;
  first_event_at: string;
  last_event_at: string;
}

interface BatchEventRow {
  id: string;
  source_kind: "activity" | "message";
  source_id: string;
  occurred_at: string;
  input_characters: number;
  attempt_count: number;
}

interface ModelSource {
  id: string;
  kind: "activity" | "message";
  provider: string;
  providerTenantId: string | null;
  connectionId: string | null;
  title: string;
  summary: string;
  text: string;
  actor: Record<string, unknown>;
  subject: Record<string, unknown>;
  externalPeople: unknown[];
  entityKeys: string[];
  canonicalUrl: string | null;
  workstreamId: string | null;
  occurredAt: string;
}

interface OpportunityCandidateRow {
  id: string;
  version: number;
  display_prompt: string;
  admission_reasoning: string;
  provider_icon: string;
  source_label: string;
  audience_scope: string;
  audience_user_id: string | null;
  created_at: string;
  updated_at: string;
  impression_count: number | null;
  first_impressed_at: string | null;
  last_impressed_at: string | null;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function boundedRecord(value: unknown, limit = 3_000): Record<string, unknown> {
  const record = typeof value === "string" ? parseRecord(value) : value as Record<string, unknown>;
  const serialized = JSON.stringify(record);
  if (serialized.length <= limit) return record;
  return { truncated: true, excerpt: serialized.slice(0, limit - 50) };
}

function boundedArray(value: unknown, limit = 3_000): unknown[] {
  const array = typeof value === "string" ? parseArray(value) : Array.isArray(value) ? value : [];
  const output: unknown[] = [];
  let size = 2;
  for (const item of array.slice(0, 100)) {
    const serialized = JSON.stringify(item);
    if (size + serialized.length > limit) break;
    output.push(item);
    size += serialized.length + 1;
  }
  return output;
}

function deriveExternalPeople(
  provider: string,
  providerTenantId: string | null,
  actor: Record<string, unknown>,
  subject: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const people: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, role: string, depth: number): void => {
    if (depth > 3 || people.length >= 30 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, role, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const providerUserId = record.id ?? record.userId ?? record.user_id ?? record.node_id;
    const handle = record.login ?? record.handle ?? record.username ?? record.name;
    const email = record.email ?? record.emailAddress ?? record.email_address;
    const displayName = record.displayName ?? record.display_name ?? record.name;
    if ([providerUserId, handle, email, displayName].some((item) => typeof item === "string" && item.length > 0)) {
      people.push({
        provider,
        providerTenantId,
        providerUserId: typeof providerUserId === "string" || typeof providerUserId === "number" ? String(providerUserId) : null,
        handle: typeof handle === "string" ? handle : null,
        email: typeof email === "string" ? email : null,
        displayName: typeof displayName === "string" ? displayName : null,
        role,
        sourceText: JSON.stringify(record).slice(0, 1_000),
      });
    }
    for (const [key, child] of Object.entries(record)) {
      if (/(actor|sender|author|assignee|reviewer|subscriber|recipient|mention|user|owner)/iu.test(key)) {
        visit(child, key.slice(0, 80), depth + 1);
      }
    }
  };
  visit(actor, "actor", 0);
  for (const [key, value] of Object.entries(subject)) {
    if (/(actor|sender|author|assignee|reviewer|subscriber|recipient|mention|user|owner)/iu.test(key)) {
      visit(value, key.slice(0, 80), 1);
    }
  }
  return people;
}

function granolaHydratedPeople(
  value: unknown,
  providerTenantId: string | null,
): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const note = value as Record<string, unknown>;
  const calendar = note.calendar_event && typeof note.calendar_event === "object" && !Array.isArray(note.calendar_event)
    ? note.calendar_event as Record<string, unknown>
    : {};
  const candidates: Array<{ person: unknown; role: string }> = [
    { person: note.owner, role: "owner" },
    ...((Array.isArray(note.attendees) ? note.attendees : []).map((person) => ({ person, role: "attendee" }))),
    ...((Array.isArray(calendar.invitees) ? calendar.invitees : []).map((person) => ({ person, role: "invitee" }))),
    ...(typeof calendar.organiser === "string" ? [{ person: { email: calendar.organiser }, role: "organizer" }] : []),
  ];
  const seen = new Set<string>();
  return candidates.flatMap(({ person, role }) => {
    if (!person || typeof person !== "object" || Array.isArray(person)) return [];
    const record = person as Record<string, unknown>;
    const email = typeof record.email === "string" ? record.email.toLowerCase() : null;
    const displayName = typeof record.name === "string" ? record.name : null;
    if (!email && !displayName) return [];
    const key = `${role}:${email ?? ""}:${displayName ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      provider: "granola",
      providerTenantId,
      providerUserId: null,
      handle: null,
      email,
      displayName,
      role,
      sourceText: JSON.stringify(record).slice(0, 1_000),
    }];
  }).slice(0, 100);
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function compactRankingProvenance(node: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown, limit: number): string | null => (
    typeof value === "string" ? value.slice(0, limit) : null
  );
  return {
    id: node.id,
    kind: node.node_kind,
    sourceId: node.source_id,
    provider: node.provider,
    providerTenantId: node.provider_tenant_id,
    canonicalUrl: text(node.canonical_url, 500),
    label: text(node.label, 300),
    occurredAt: node.occurred_at,
    relationship: node.relationship,
    parentNodeId: node.parent_node_id,
    depth: node.depth,
    locator: text(node.locator_json, 500),
  };
}

function boundRankingCandidate<T extends {
  admissionReasoning: string;
  linkedUsers: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
}>(candidate: T): T {
  const bounded = {
    ...candidate,
    admissionReasoning: candidate.admissionReasoning.slice(0, 8_000),
    linkedUsers: candidate.linkedUsers.slice(0, 12).map((link) => ({
      ...link,
      reasoning: String(link.reasoning ?? "").slice(0, 500),
    })),
    provenance: candidate.provenance.slice(0, 16).map(compactRankingProvenance),
  };
  while (jsonSize(bounded) > MAX_RANK_CANDIDATE_CHARACTERS && bounded.provenance.length > 1) {
    bounded.provenance.pop();
  }
  while (jsonSize(bounded) > MAX_RANK_CANDIDATE_CHARACTERS && bounded.linkedUsers.length > 1) {
    bounded.linkedUsers.pop();
  }
  const overflow = jsonSize(bounded) - MAX_RANK_CANDIDATE_CHARACTERS;
  if (overflow > 0) {
    bounded.admissionReasoning = bounded.admissionReasoning.slice(
      0,
      Math.max(1_000, bounded.admissionReasoning.length - overflow - 100),
    );
  }
  return bounded as T;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function iconForProvider(provider: string): WorkOpportunity["icon"] {
  const icon = ({
    github: "brand-github",
    google: "brand-google",
    gmail: "brand-google",
    notion: "brand-notion",
    slack: "brand-slack",
    linear: "linear",
    generic_webhook: "webhook",
  } as Record<string, WorkOpportunity["icon"]>)[provider] ?? "plug";
  return AutomationPluginIconSchema.parse(icon);
}

function identityProvider(provider: string): string {
  return ["gmail", "google_drive", "google_calendar", "drive", "calendar"].includes(provider)
    ? "google"
    : provider;
}

function sourceLabel(sources: ModelSource[]): string {
  const providers = [...new Set(sources.map((source) => source.provider))];
  if (providers.length === 1) return providers[0] === "avalon" ? "Avalon activity" : `From ${providers[0]}`;
  return `From ${providers.length} connected sources`;
}

async function mapConcurrent<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadSource(env: Env, workspaceId: WorkspaceId, event: BatchEventRow): Promise<ModelSource | null> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  );
  if (event.source_kind === "activity") {
    const workspaceEnv = withWorkspaceRuntimeDatabase(env, workspaceId);
    const durable = WorkspaceConnectorEventSchema.nullable().parse(
      await workspace.connectorEvent({ workspaceId, eventId: event.source_id }),
    );
    if (!durable) return null;
    const activity = durable.activity;
    const connection = await workspaceEnv.DB.prepare(
      `SELECT provider_account_id FROM connector_connections
        WHERE id = ? AND workspace_id = ? LIMIT 1`,
    ).bind(activity.connectionId, workspaceId).first<{ provider_account_id: string | null }>();
    const metadata = activity.metadata;
    const actor = boundedRecord(activity.actor);
    const subject = boundedRecord(activity.subject);
    let hydratedText = "";
    let hydratedCanonicalUrl: string | null = null;
    let hydratedPeople: Array<Record<string, unknown>> = [];
    if (
      ["notion", "granola"].includes(activity.provider)
      && activity.providerResourceId !== null
      && activity.resourceType !== null
    ) {
      try {
        const hydrated = await hydrateConnectorActivitySource(workspaceEnv, {
          workspaceId,
          connectionId: activity.connectionId,
          providerResourceId: activity.providerResourceId,
          resourceType: activity.resourceType,
        });
        hydratedText = hydrated == null ? "" : JSON.stringify(hydrated).slice(0, 8_000);
        if (activity.provider === "granola") {
          const hydratedRecord = boundedRecord(hydrated);
          hydratedCanonicalUrl = [hydratedRecord.web_url, hydratedRecord.webUrl, hydratedRecord.url]
            .find((value): value is string => typeof value === "string")?.slice(0, 2_000) ?? null;
          hydratedPeople = granolaHydratedPeople(
            hydrated,
            connection?.provider_account_id ?? null,
          );
        }
      } catch (error) {
        if (isTransientSourceHydrationError(error)) throw error;
        logWarn(env, "work_opportunity_source_hydration_failed", {
          activity_id: event.source_id,
          provider: activity.provider,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const explicitPeople = (activity.externalPeople ?? []).slice(0, 100);
    return {
      id: event.source_id,
      kind: "activity",
      provider: activity.provider,
      providerTenantId: connection?.provider_account_id ?? null,
      connectionId: activity.connectionId,
      title: activity.title.slice(0, 1_000),
      summary: activity.summary.slice(0, 3_000),
      text: (hydratedText || activity.textSnippet).slice(0, 8_000),
      actor,
      subject,
      externalPeople: explicitPeople.length > 0 || hydratedPeople.length > 0
        ? [...explicitPeople, ...hydratedPeople].slice(0, 100)
        : deriveExternalPeople(activity.provider, connection?.provider_account_id ?? null, actor, subject),
      entityKeys: activity.entityKeys.slice(0, 20).map((item) => item.slice(0, 200)),
      canonicalUrl: [hydratedCanonicalUrl, metadata.canonicalUrl, metadata.canonical_url, metadata.url]
        .find((value): value is string => typeof value === "string")?.slice(0, 2_000) ?? null,
      workstreamId: null,
      occurredAt: activity.occurredAt,
    };
  }
  const activity = await workspace.activityEventSource({
    workspaceId,
    sourceKind: "workstream_message",
    sourceId: event.source_id,
  });
  if (!activity?.audienceWorkstreamId) return null;
  const author = activity.actorUserId
    ? await env.DB.prepare("SELECT id, name, email FROM users WHERE id = ? LIMIT 1")
      .bind(activity.actorUserId).first<{ id: string; name: string; email: string }>()
    : null;
  return {
    id: event.source_id,
    kind: "message",
    provider: "avalon",
    providerTenantId: workspaceId,
    connectionId: null,
    title: activity.title,
    summary: "A workspace member mentioned someone in an Avalon work stream.",
    text: activity.body.slice(0, 8_000),
    actor: author ?? { id: activity.actorUserId, name: activity.actorLabel },
    subject: {},
    externalPeople: [],
    entityKeys: [activity.audienceWorkstreamId],
    canonicalUrl: null,
    workstreamId: activity.audienceWorkstreamId,
    occurredAt: activity.occurredAt,
  };
}

function isTransientSourceHydrationError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (!(error instanceof ConnectorError)) return false;
  const details = error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown>
    : {};
  const status = typeof details.status === "number" ? details.status : null;
  return error.code === "unauthorized"
    || status === 408
    || status === 429
    || (status != null && status >= 500)
    || (error.code === "provider_error" && status == null);
}

function packBatches(events: Array<{ event: BatchEventRow; source: ModelSource }>): Array<Array<{ event: BatchEventRow; source: ModelSource }>> {
  const grouped = new Map<string, Array<{ event: BatchEventRow; source: ModelSource }>>();
  for (const original of events) {
    let source = original.source;
    if (jsonSize(source) > MAX_BATCH_CHARACTERS) {
      source = {
        ...source,
        actor: boundedRecord(source.actor, 2_000),
        subject: boundedRecord(source.subject, 2_000),
        externalPeople: boundedArray(source.externalPeople, 2_000),
        entityKeys: source.entityKeys.slice(0, 10).map((key) => key.slice(0, 120)),
      };
      for (const field of ["text", "summary", "title"] as const) {
        const excess = jsonSize(source) - MAX_BATCH_CHARACTERS;
        if (excess <= 0) break;
        source = { ...source, [field]: source[field].slice(0, Math.max(0, source[field].length - excess - 100)) };
      }
    }
    const item = { event: original.event, source };
    const key = item.source.workstreamId
      ?? item.source.entityKeys[0]
      ?? `${item.source.provider}:${item.source.connectionId ?? "workspace"}`;
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  const ordered = [...grouped.values()].flat();
  const batches: Array<Array<{ event: BatchEventRow; source: ModelSource }>> = [];
  let current: Array<{ event: BatchEventRow; source: ModelSource }> = [];
  let characters = 0;
  for (const item of ordered) {
    const size = jsonSize(item.source);
    if (current.length > 0 && (current.length >= MAX_BATCH_EVENTS || characters + size > MAX_BATCH_CHARACTERS)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(item);
    characters += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function syncVerifiedIdentityDirectory(env: Env, workspaceId: WorkspaceId): Promise<void> {
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const [connections, slackLinks] = await Promise.all([
    env.DB.prepare(
      `SELECT connector_type, owner_user_id, provider_account_id, config_json
       FROM connector_connections
       WHERE workspace_id = ? AND scope = 'personal' AND owner_user_id IS NOT NULL
         AND provider_account_id IS NOT NULL AND status <> 'disabled'`,
    ).bind(workspaceId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT user_id, slack_team_id, slack_user_id FROM slack_user_links
       WHERE workspace_id = ? AND status = 'active'`,
    ).bind(workspaceId).all<Record<string, unknown>>(),
  ]);
  const entries: Array<{
    userId: string;
    provider: string;
    tenant: string;
    subject: string;
    handle: string | null;
    email: string | null;
    displayName: string | null;
    source: string;
  }> = [];
  for (const connection of connections.results) {
    const provider = String(connection.connector_type);
    const account = String(connection.provider_account_id);
    const config = parseRecord(connection.config_json);
    const githubUserId = typeof config.githubUserId === "string" ? config.githubUserId : null;
    const githubLogin = typeof config.githubLogin === "string" ? config.githubLogin : null;
    const configuredSubject = typeof config.providerUserId === "string" ? config.providerUserId : null;
    const configuredTenant = typeof config.providerTenantId === "string" ? config.providerTenantId : null;
    const configuredHandle = typeof config.handle === "string" ? config.handle : null;
    const configuredEmail = typeof config.verifiedEmail === "string" ? config.verifiedEmail : null;
    const configuredName = typeof config.identityDisplayName === "string" ? config.identityDisplayName : null;
    entries.push({
      userId: String(connection.owner_user_id),
      provider,
      tenant: configuredTenant ?? account,
      subject: configuredSubject ?? githubUserId ?? account,
      handle: configuredHandle ?? githubLogin,
      email: (configuredEmail ?? (account.includes("@") ? account : null))?.toLocaleLowerCase() ?? null,
      displayName: configuredName ?? githubLogin,
      source: "personal_connector_oauth",
    });
  }
  for (const link of slackLinks.results) {
    entries.push({
      userId: String(link.user_id),
      provider: "slack",
      tenant: String(link.slack_team_id),
      subject: String(link.slack_user_id),
      handle: null,
      email: null,
      displayName: null,
      source: "slack_user_link",
    });
  }
  if (entries.length === 0) return;
  const at = nowIso();
  await env.DB.batch(entries.map((entry) => env.DB.prepare(
    `INSERT INTO external_user_identities
     (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
      handle, email, display_name, verification_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider, provider_tenant_id, provider_user_id) DO UPDATE SET
      user_id = excluded.user_id, handle = COALESCE(excluded.handle, external_user_identities.handle),
      email = COALESCE(excluded.email, external_user_identities.email),
      display_name = COALESCE(excluded.display_name, external_user_identities.display_name),
      verification_source = excluded.verification_source, updated_at = excluded.updated_at`,
  ).bind(
    newId(), workspaceId, entry.userId, entry.provider, entry.tenant, entry.subject,
    entry.handle, entry.email, entry.displayName, entry.source, at, at,
  )));
}

async function loadAdmissionContext(env: Env, window: WindowRow) {
  await syncVerifiedIdentityDirectory(env, asWorkspaceId(window.workspace_id));
  const authority = await readWorkstreamAuthorityControl(env);
  const workspacePromise = authority.phase === "durable_object_open"
    ? durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      window.workspace_id,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(window.workspace_id)),
    )
    : null;
  const workRowsPromise = workspacePromise
    ? workspacePromise.then((workspace) => workspace.recentWorkstreamDirectory({
      workspaceId: window.workspace_id,
      userId: window.audience_scope === "workspace" ? null : window.audience_user_id,
      includeSystem: false,
      participantsOnly: false,
      limit: 20,
    })).then((page) => ({ results: page.items.map((item) => ({
      id: item.workstreamId,
      title: item.title,
      objective: item.description,
    })) }))
    : env.DB.prepare(
      `SELECT w.id, w.title, w.objective FROM workstreams w
       LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
       WHERE w.workspace_id = ? AND w.archived_at IS NULL AND w.system_kind IS NULL
         AND (
           ? = 'workspace' OR w.automation_subscription_id IS NULL OR s.scope = 'workspace'
           OR s.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM workstream_participants p
             WHERE p.workstream_id = w.id AND p.user_id = ? AND p.removed_at IS NULL
           )
         )
       ORDER BY w.last_activity_at DESC LIMIT 20`,
    ).bind(
      window.workspace_id, window.audience_scope, window.audience_user_id, window.audience_user_id,
    ).all<{ id: string; title: string; objective: string }>();
  const opportunityRowsPromise = workspacePromise
    ? workspacePromise.then((workspace) => workspace.existingOpportunities({
      workspaceId: window.workspace_id,
      audience: { scope: window.audience_scope, userId: window.audience_user_id },
      now: nowIso(),
      limit: 12,
    })).then((results) => ({ results: results.map((row) => ({
      id: row.id,
      display_prompt: row.displayPrompt,
      admission_reasoning: row.admissionReasoning,
    })) }))
    : env.DB.prepare(
      `SELECT id, display_prompt, admission_reasoning FROM work_opportunities
       WHERE workspace_id = ? AND status = 'active' AND expires_at > ?
         AND ((? = 'workspace' AND audience_scope = 'workspace')
           OR (? = 'personal' AND audience_scope = 'personal' AND audience_user_id = ?))
       ORDER BY updated_at DESC LIMIT 12`,
    ).bind(
      window.workspace_id, nowIso(), window.audience_scope, window.audience_scope, window.audience_user_id,
    ).all<{ id: string; display_prompt: string; admission_reasoning: string }>();
  const [memberRows, identityRows, workRows, opportunityRows] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.status = 'active' ORDER BY u.name LIMIT 250`,
    ).bind(window.workspace_id).all<{ id: string; name: string; email: string }>(),
    workspaceRuntimeDatabase(env, window.workspace_id).prepare(
      `SELECT user_id, provider, provider_tenant_id, provider_user_id, handle, email, display_name
       FROM external_user_identities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1000`,
    ).bind(window.workspace_id).all<Record<string, unknown>>(),
    workRowsPromise,
    opportunityRowsPromise,
  ]);
  const aliases = new Map<string, string[]>();
  for (const identity of identityRows.results) {
    const values = [
      `${identity.provider}:${identity.provider_tenant_id}:id:${identity.provider_user_id}`,
      typeof identity.handle === "string"
        ? `${identity.provider}:${identity.provider_tenant_id}:handle:${identity.handle.toLocaleLowerCase()}`
        : null,
      typeof identity.email === "string" ? `email:${identity.email.toLocaleLowerCase()}` : null,
      typeof identity.display_name === "string"
        ? `${identity.provider}:${identity.provider_tenant_id}:name:${identity.display_name.toLocaleLowerCase()}`
        : null,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    aliases.set(String(identity.user_id), [...(aliases.get(String(identity.user_id)) ?? []), ...values]);
  }
  return {
    members: memberRows.results.map((member) => ({ ...member, verifiedAliases: aliases.get(member.id) ?? [] })),
    existingWork: workRows.results,
    existingOpportunities: opportunityRows.results.map((row) => ({
      id: row.id,
      displayPrompt: row.display_prompt,
      admissionReasoning: row.admission_reasoning.slice(0, 4_000),
    })),
  };
}

/**
 * Ask for these members' suggestions to be ranked again — soon, not now.
 *
 * This replaced a workspace-wide version counter that invalidated every member's
 * set on every admission, including for opportunities scoped to one person's
 * private audience that could never appear in anyone else's candidates. Ranking
 * is the expensive half of this feature, so who is asked for it has to be exact:
 * a personal window means one member, a workspace window means the members whose
 * candidate list actually gained something.
 *
 * The due time is pushed into the near future rather than set to now so a window
 * that admits several opportunities in a row coalesces into one ranking, and an
 * existing earlier due time always wins — being asked again must never delay a
 * ranking that was already waiting.
 *
 * `request_seq` is what makes the ask *visible* when `MIN` keeps the existing
 * due time. Without it, asking during a running tournament left the row
 * byte-identical, and the scheduler cleared the request on the way out as though
 * it had answered this one too.
 */
async function markSuggestedWorkDue(
  env: Env,
  workspaceId: WorkspaceId,
  userIds: string[],
  delayMs: number = DUE_DEBOUNCE_MS,
): Promise<void> {
  const targets = [...new Set(userIds)].filter((userId) => userId.length > 0);
  if (targets.length === 0) return;
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    await workspace.markOpportunityRankingDue(workspaceId, targets, delayMs);
    return;
  }
  const at = nowIso();
  const dueAt = new Date(Date.now() + delayMs).toISOString();
  const statements = targets.map((userId) => env.DB.prepare(
    `INSERT INTO suggested_work_sets
     (workspace_id, user_id, candidate_fingerprint, due_at, request_seq, created_at, updated_at)
     VALUES (?, ?, '', ?, 1, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      due_at = MIN(COALESCE(suggested_work_sets.due_at, excluded.due_at), excluded.due_at),
      request_seq = suggested_work_sets.request_seq + 1,
      updated_at = excluded.updated_at`,
  ).bind(workspaceId, userId, dueAt, at, at));
  // One statement per member, so the list is chunked rather than handed to D1
  // whole: an opportunity naming many people, or a window whose decisions name
  // different ones, produces a batch far larger than anything else here sends.
  for (let index = 0; index < statements.length; index += MAX_DUE_BATCH_STATEMENTS) {
    await env.DB.batch(statements.slice(index, index + MAX_DUE_BATCH_STATEMENTS));
  }
}

/**
 * The same request, for every active member of a workspace.
 *
 * Set-based rather than a statement per member, because the caller's member list
 * is the admission prompt's, which is capped at 250 by name — past that the
 * remainder would never be re-ranked at all, which is worse than the
 * workspace-wide invalidation this replaced.
 */
async function markWorkspaceSuggestedWorkDue(
  env: Env,
  workspaceId: WorkspaceId,
  delayMs: number = DUE_DEBOUNCE_MS,
): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    await workspace.markWorkspaceOpportunityRankingDue(workspaceId, delayMs);
    return;
  }
  const at = nowIso();
  const dueAt = new Date(Date.now() + delayMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO suggested_work_sets
     (workspace_id, user_id, candidate_fingerprint, due_at, request_seq, created_at, updated_at)
     SELECT workspace_id, user_id, '', ?, 1, ?, ? FROM workspace_members
      WHERE workspace_id = ? AND status = 'active'
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      due_at = MIN(COALESCE(suggested_work_sets.due_at, excluded.due_at), excluded.due_at),
      request_seq = suggested_work_sets.request_seq + 1,
      updated_at = excluded.updated_at`,
  ).bind(dueAt, at, at, workspaceId).run();
}

async function provenanceNodeForSource(
  env: Env,
  window: WindowRow,
  source: ModelSource,
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM opportunity_provenance_nodes
     WHERE workspace_id = ? AND node_kind = ? AND source_id = ?
       AND visibility_scope = ? AND visibility_user_id IS ? LIMIT 1`,
  ).bind(
    window.workspace_id, source.kind, source.id, window.audience_scope, window.audience_user_id,
  ).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO opportunity_provenance_nodes
     (id, workspace_id, node_kind, source_id, provider, provider_tenant_id, canonical_url,
      label, occurred_at, visibility_scope, visibility_user_id, locator_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, window.workspace_id, source.kind, source.id, source.provider, source.providerTenantId,
    source.canonicalUrl, source.title.slice(0, 500), source.occurredAt, window.audience_scope,
    window.audience_user_id,
    JSON.stringify({ sourceId: source.id, connectionId: source.connectionId, workstreamId: source.workstreamId }),
    nowIso(),
  ).run();
  if (source.canonicalUrl) {
    const urlSourceId = `url:${await sha256(source.canonicalUrl)}`;
    let urlNode = await env.DB.prepare(
      `SELECT id FROM opportunity_provenance_nodes
       WHERE workspace_id = ? AND node_kind = 'provider_url' AND source_id = ?
         AND visibility_scope = ? AND visibility_user_id IS ? LIMIT 1`,
    ).bind(
      window.workspace_id, urlSourceId, window.audience_scope, window.audience_user_id,
    ).first<{ id: string }>();
    if (!urlNode) {
      urlNode = { id: newId() };
      await env.DB.prepare(
        `INSERT INTO opportunity_provenance_nodes
         (id, workspace_id, node_kind, source_id, provider, provider_tenant_id, canonical_url,
          label, occurred_at, visibility_scope, visibility_user_id, locator_json, created_at)
         VALUES (?, ?, 'provider_url', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      ).bind(
        urlNode.id, window.workspace_id, urlSourceId, source.provider, source.providerTenantId,
        source.canonicalUrl, source.title.slice(0, 500), source.occurredAt, window.audience_scope,
        window.audience_user_id, nowIso(),
      ).run();
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO opportunity_provenance_edges
       (workspace_id, parent_node_id, child_node_id, relationship, created_at)
       VALUES (?, ?, ?, 'part_of', ?)`,
    ).bind(window.workspace_id, id, urlNode.id, nowIso()).run();
  }
  for (const [index, reference] of source.externalPeople.slice(0, 30).entries()) {
    const person = typeof reference === "object" && reference !== null
      ? reference as Record<string, unknown>
      : { sourceText: String(reference) };
    const referenceText = String(person.sourceText ?? person.displayName ?? person.handle ?? person.email ?? "External person").slice(0, 1_000);
    const personId = newId();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO opportunity_provenance_nodes
         (id, workspace_id, node_kind, source_id, provider, provider_tenant_id, label,
          occurred_at, visibility_scope, visibility_user_id, locator_json, created_at)
         VALUES (?, ?, 'external_person', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        personId, window.workspace_id, `${source.id}:external-person:${index}`, source.provider,
        source.providerTenantId, referenceText, source.occurredAt, window.audience_scope,
        window.audience_user_id, JSON.stringify(person), nowIso(),
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO opportunity_provenance_edges
         (workspace_id, parent_node_id, child_node_id, relationship, created_at)
         SELECT ?, ?, id, ?, ? FROM opportunity_provenance_nodes
         WHERE workspace_id = ? AND node_kind = 'external_person' AND source_id = ?
           AND visibility_scope = ? AND visibility_user_id IS ?`,
      ).bind(
        window.workspace_id, id, String(person.role ?? "mentions") === "assignee" ? "assigned_to" : "mentions",
        nowIso(), window.workspace_id, `${source.id}:external-person:${index}`,
        window.audience_scope, window.audience_user_id,
      ),
    ]);
  }
  if (source.workstreamId) {
    let workstreamNode = await env.DB.prepare(
      `SELECT id FROM opportunity_provenance_nodes
       WHERE workspace_id = ? AND node_kind = 'workstream' AND source_id = ?
         AND visibility_scope = ? AND visibility_user_id IS ? LIMIT 1`,
    ).bind(
      window.workspace_id, source.workstreamId, window.audience_scope, window.audience_user_id,
    ).first<{ id: string }>();
    if (!workstreamNode) {
      workstreamNode = { id: newId() };
      await env.DB.prepare(
        `INSERT INTO opportunity_provenance_nodes
         (id, workspace_id, node_kind, source_id, label, visibility_scope, visibility_user_id, locator_json, created_at)
         VALUES (?, ?, 'workstream', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        workstreamNode.id, window.workspace_id, source.workstreamId, source.title.slice(0, 500),
        window.audience_scope, window.audience_user_id, JSON.stringify({ workstreamId: source.workstreamId }), nowIso(),
      ).run();
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO opportunity_provenance_edges
       (workspace_id, parent_node_id, child_node_id, relationship, created_at)
       VALUES (?, ?, ?, 'part_of', ?)`,
    ).bind(window.workspace_id, id, workstreamNode.id, nowIso()).run();
  }
  return id;
}

function audienceKey(window: WindowRow): string {
  return window.audience_scope === "workspace"
    ? "workspace"
    : `personal:${window.audience_user_id ?? "missing"}`;
}

async function opportunityFingerprint(window: WindowRow, sources: ModelSource[]): Promise<string> {
  const sourceKeys = [...new Set(sources.map((source) => `${source.kind}:${source.id}`))].sort();
  return sha256([`audience:${audienceKey(window)}`, ...sourceKeys].join("\n"));
}

async function routeExistingDecision(
  env: Env,
  window: WindowRow,
  decision: z.infer<typeof AdmissionDecisionSchema>,
  sources: ModelSource[],
  existingWork: Array<{ id: string; title: string; objective: string }>,
): Promise<boolean> {
  if (!SUGGESTED_CONTEXT_ENABLED) return false;
  if (window.audience_scope !== "workspace") return false;
  const targetId = decision.existingTargetId;
  if (!targetId || !existingWork.some((workstream) => workstream.id === targetId)) return false;
  const referenced = sources.filter((source) => decision.sourceIds.includes(source.id));
  const activities = referenced.filter((source) => source.kind === "activity");
  if (activities.length === 0) {
    return referenced.some((source) => source.kind === "message" && source.workstreamId === targetId);
  }
  const reason = decision.displayPrompt.trim() || "Recent connected activity belongs in this existing work stream.";
  const routed = await Promise.all(activities.map((source) => createActivitySuggestion(env, {
    region: env.AVALON_REGION,
    workspaceId: asWorkspaceId(window.workspace_id),
    activityId: source.id,
    activityTitle: source.title,
    activitySummary: source.summary,
    workstreamId: asWorkstreamId(targetId),
    confidence: 1,
    reason,
    matchedEntities: source.entityKeys,
    // This path publishes the same card contextual routing does, and the
    // resolution feeds routing's feedback gates. Saying so is what keeps a
    // dismissal of *this* agent's deliberate whole-window decision from being
    // counted as evidence that *that* one's per-event guess was wrong.
    // `docs/contextual-routing.md` owns what the distinction is used for.
    source: "suggested_work",
  })));
  return routed.some(Boolean);
}

async function persistDecision(
  env: Env,
  window: WindowRow,
  decision: z.infer<typeof AdmissionDecisionSchema>,
  sources: ModelSource[],
  members: Array<{ id: string; name: string; email: string; verifiedAliases: string[] }>,
): Promise<{ opportunityId: string | null; eagerUserIds: string[] }> {
  if (decision.action === "ignore" || decision.action === "route_existing") return { opportunityId: null, eagerUserIds: [] };
  if (!decision.displayPrompt.trim() || !decision.executionPrompt.trim() || !decision.admissionReasoning.trim()) {
    return { opportunityId: null, eagerUserIds: [] };
  }
  const referenced = sources.filter((source) => decision.sourceIds.includes(source.id));
  if (referenced.length === 0) return { opportunityId: null, eagerUserIds: [] };
  const fingerprint = await opportunityFingerprint(window, referenced);
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const memberById = new Map(members.map((member) => [member.id, member]));
    const links = await Promise.all(decision.linkedUsers.map(async (link) => {
      const source = referenced.find((item) => item.id === link.sourceId);
      if (!source) return null;
      const requestedUserId = link.userId && memberById.has(link.userId) ? link.userId : null;
      const member = requestedUserId ? memberById.get(requestedUserId) : null;
      const people = source.externalPeople.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      );
      const ownerPronoun = window.audience_scope === "personal"
        && requestedUserId === window.audience_user_id
        && /^(?:you|your|yours)$/iu.test(link.sourceText.trim());
      const verifiedEvidence = ownerPronoun || Boolean(
        source.provider !== "generic_webhook" && member && people.some((person) => {
          const tenant = String(person.providerTenantId ?? source.providerTenantId ?? "");
          const provider = identityProvider(String(person.provider ?? source.provider));
          const subject = person.providerUserId == null ? null : String(person.providerUserId);
          const handle = typeof person.handle === "string" ? person.handle.toLocaleLowerCase() : null;
          const email = typeof person.email === "string" ? person.email.toLocaleLowerCase() : null;
          return (subject && member.verifiedAliases.includes(`${provider}:${tenant}:id:${subject}`))
            || (handle && member.verifiedAliases.includes(`${provider}:${tenant}:handle:${handle}`))
            || (email && (
              member.email.toLocaleLowerCase() === email || member.verifiedAliases.includes(`email:${email}`)
            ));
        }),
      );
      const requestedResolution = link.resolution === "verified" && !verifiedEvidence
        ? "inferred"
        : link.resolution;
      const resolution = requestedUserId
        ? requestedResolution
        : (requestedResolution === "ambiguous" ? "ambiguous" : "unresolved");
      const allowedTarget = window.audience_scope === "workspace" || requestedUserId === window.audience_user_id;
      const userId = allowedTarget && (resolution === "verified" || resolution === "inferred")
        ? requestedUserId
        : null;
      const verifiedIdentity = resolution === "verified" && userId
        ? await workspaceRuntimeDatabase(env, window.workspace_id).prepare(
          `SELECT id, provider, provider_tenant_id FROM external_user_identities
            WHERE workspace_id = ? AND user_id = ? AND provider = ? AND provider_tenant_id = ?
            ORDER BY updated_at DESC LIMIT 1`,
        ).bind(
          window.workspace_id,
          userId,
          identityProvider(source.provider),
          source.providerTenantId ?? "",
        ).first<{ id: string; provider: string; provider_tenant_id: string }>()
        : null;
      return {
        id: newId(),
        sourceId: link.sourceId,
        userId,
        role: link.role,
        resolution,
        reasoning: link.reasoning,
        sourceText: link.sourceText,
        startOffset: link.startOffset,
        endOffset: link.endOffset,
        verifiedIdentity: verifiedIdentity ? {
          id: verifiedIdentity.id,
          provider: verifiedIdentity.provider,
          providerTenantId: verifiedIdentity.provider_tenant_id,
        } : null,
      };
    }));
    const normalizedLinks = links.filter((link): link is NonNullable<typeof link> => link !== null);
    const eagerUserIds = [...new Set(normalizedLinks.flatMap((link) => (
      link.userId && (link.resolution === "verified"
        || (link.resolution === "inferred" && window.audience_scope === "workspace"))
        ? [link.userId]
        : []
    )))];
    const rankUserIds = window.audience_scope === "personal"
      ? (window.audience_user_id ? [window.audience_user_id] : [])
      : (await env.DB.prepare(
        `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active' LIMIT 10000`,
      ).bind(window.workspace_id).all<{ user_id: string }>()).results.map((row) => row.user_id);
    const displayPrompt = decision.displayPrompt.trim().slice(0, 180);
    const executionPrompt = decision.executionPrompt.trim().slice(0, 20_000);
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      window.workspace_id,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(window.workspace_id)),
    );
    const persisted = await workspace.persistOpportunity({
      workspaceId: window.workspace_id,
      audience: { scope: window.audience_scope, userId: window.audience_user_id },
      proposedId: newId(),
      existingTargetId: decision.action === "update_existing" ? decision.existingTargetId : null,
      sourceFingerprint: fingerprint,
      displayPrompt,
      executionPrompt,
      admissionReasoning: decision.admissionReasoning.trim().slice(0, 20_000),
      providerIcon: iconForProvider(referenced[0]?.provider ?? "plug"),
      sourceLabel: sourceLabel(referenced).slice(0, 180),
      displayPromptHash: await sha256(displayPrompt),
      executionPromptHash: await sha256(executionPrompt),
      expiresAt: new Date(Date.now() + OPPORTUNITY_TTL_MS).toISOString(),
      sources: referenced,
      links: normalizedLinks,
      rankUserIds,
      eagerUserIds,
      rankDueAt: new Date(Date.now() + DUE_DEBOUNCE_MS).toISOString(),
    });
    return { opportunityId: persisted.opportunityId, eagerUserIds: persisted.eagerUserIds };
  }
  const existing = decision.action === "update_existing" && decision.existingTargetId
    ? await env.DB.prepare(
      `SELECT id, version FROM work_opportunities
       WHERE id = ? AND workspace_id = ? AND audience_scope = ? AND audience_user_id IS ? LIMIT 1`,
    ).bind(
      decision.existingTargetId, window.workspace_id, window.audience_scope, window.audience_user_id,
    ).first<{ id: string; version: number }>()
    : await env.DB.prepare(
      "SELECT id, version FROM work_opportunities WHERE workspace_id = ? AND source_fingerprint = ? LIMIT 1",
    ).bind(window.workspace_id, fingerprint).first<{ id: string; version: number }>();
  const id = existing?.id ?? newId();
  const version = (existing?.version ?? 0) + 1;
  const displayPrompt = decision.displayPrompt.trim().slice(0, 180);
  const executionPrompt = decision.executionPrompt.trim().slice(0, 20_000);
  const admissionReasoning = decision.admissionReasoning.trim().slice(0, 20_000);
  const displayHash = await sha256(displayPrompt);
  const executionHash = await sha256(executionPrompt);
  const at = nowIso();
  const icon = iconForProvider(referenced[0]?.provider ?? "plug");
  const label = sourceLabel(referenced).slice(0, 180);
  const expiresAt = new Date(Date.now() + OPPORTUNITY_TTL_MS).toISOString();
  if (existing) {
    await env.DB.prepare(
      `UPDATE work_opportunities SET audience_scope = ?, audience_user_id = ?, display_prompt = ?,
       execution_prompt = ?, admission_reasoning = ?, provider_icon = ?, source_label = ?, source_fingerprint = ?,
       version = ?, display_prompt_hash = ?, execution_prompt_hash = ?, status = 'active', expires_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(
      window.audience_scope, window.audience_user_id, displayPrompt, executionPrompt, admissionReasoning,
      icon, label, fingerprint, version, displayHash, executionHash, expiresAt, at, id, window.workspace_id,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO work_opportunities
       (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
        admission_reasoning, provider_icon, source_label, source_fingerprint, version,
        display_prompt_hash, execution_prompt_hash, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      id, window.workspace_id, window.audience_scope, window.audience_user_id, displayPrompt,
      executionPrompt, admissionReasoning, icon, label, fingerprint, displayHash, executionHash,
      expiresAt, at, at,
    ).run();
  }
  await env.DB.prepare("DELETE FROM work_opportunity_user_links WHERE opportunity_id = ?")
    .bind(id).run();

  const rootIds: string[] = [];
  for (const source of referenced) rootIds.push(await provenanceNodeForSource(env, window, source));
  await env.DB.batch(rootIds.map((nodeId, position) => env.DB.prepare(
    `INSERT INTO work_opportunity_provenance_roots (opportunity_id, node_id, position)
     VALUES (?, ?, ?) ON CONFLICT(opportunity_id, node_id) DO UPDATE SET position = excluded.position`,
  ).bind(id, nodeId, position)));

  const eagerUserIds: string[] = [];
  const memberById = new Map(members.map((member) => [member.id, member]));
  for (const link of decision.linkedUsers) {
    const source = referenced.find((item) => item.id === link.sourceId);
    if (!source) continue;
    const userId = link.userId && memberById.has(link.userId) ? link.userId : null;
    const member = userId ? memberById.get(userId) : null;
    const people = source.externalPeople.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
    const ownerPronoun = window.audience_scope === "personal"
      && userId === window.audience_user_id
      && /^(?:you|your|yours)$/iu.test(link.sourceText.trim());
    const verifiedEvidence = ownerPronoun || Boolean(source.provider !== "generic_webhook" && member && people.some((person) => {
      const tenant = String(person.providerTenantId ?? source.providerTenantId ?? "");
      const provider = identityProvider(String(person.provider ?? source.provider));
      const subject = person.providerUserId == null ? null : String(person.providerUserId);
      const handle = typeof person.handle === "string" ? person.handle.toLocaleLowerCase() : null;
      const email = typeof person.email === "string" ? person.email.toLocaleLowerCase() : null;
      return (subject && member.verifiedAliases.includes(`${provider}:${tenant}:id:${subject}`))
        || (handle && member.verifiedAliases.includes(`${provider}:${tenant}:handle:${handle}`))
        || (email && (member.email.toLocaleLowerCase() === email || member.verifiedAliases.includes(`email:${email}`)));
    }));
    const requestedResolution = link.resolution === "verified" && !verifiedEvidence ? "inferred" : link.resolution;
    const resolution = userId
      ? requestedResolution
      : (requestedResolution === "ambiguous" ? "ambiguous" : "unresolved");
    const allowedTarget = window.audience_scope === "workspace" || userId === window.audience_user_id;
    const storedUserId = allowedTarget && (resolution === "verified" || resolution === "inferred") ? userId : null;
    const rootIndex = referenced.indexOf(source);
    const rootId = rootIds[rootIndex] ?? null;
    let mentionNodeId: string | null = rootId;
    if (rootId && link.sourceText.trim()) {
      const mentionSourceId = `${source.id}:model-person:${await sha256(`${link.role}:${link.sourceText}`)}`;
      const existingMention = await env.DB.prepare(
        `SELECT id FROM opportunity_provenance_nodes
         WHERE workspace_id = ? AND node_kind = 'external_person' AND source_id = ?
           AND visibility_scope = ? AND visibility_user_id IS ? LIMIT 1`,
      ).bind(
        window.workspace_id, mentionSourceId, window.audience_scope, window.audience_user_id,
      ).first<{ id: string }>();
      mentionNodeId = existingMention?.id ?? newId();
      const exactOffsets = link.startOffset !== null && link.endOffset !== null
        && link.endOffset > link.startOffset
        && source.text.slice(link.startOffset, link.endOffset) === link.sourceText;
      if (!existingMention) {
        await env.DB.prepare(
          `INSERT INTO opportunity_provenance_nodes
           (id, workspace_id, node_kind, source_id, provider, provider_tenant_id, label, occurred_at,
            visibility_scope, visibility_user_id, locator_json, created_at)
           VALUES (?, ?, 'external_person', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          mentionNodeId, window.workspace_id, mentionSourceId, source.provider, source.providerTenantId,
          link.sourceText.slice(0, 500), source.occurredAt, window.audience_scope, window.audience_user_id,
          JSON.stringify({
            role: link.role,
            sourceText: link.sourceText,
            startOffset: exactOffsets ? link.startOffset : null,
            endOffset: exactOffsets ? link.endOffset : null,
            suppliedAs: exactOffsets ? "exact_span" : "model_reference",
          }),
          at,
        ).run();
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO opportunity_provenance_edges
         (workspace_id, parent_node_id, child_node_id, relationship, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        window.workspace_id, rootId, mentionNodeId,
        link.role.toLocaleLowerCase().includes("assign") ? "assigned_to" : "mentions", at,
      ).run();
    }
    if (mentionNodeId && storedUserId) {
      const verifiedMapping = resolution === "verified"
        ? await workspaceRuntimeDatabase(env, window.workspace_id).prepare(
          `SELECT id, provider, provider_tenant_id FROM external_user_identities
           WHERE workspace_id = ? AND user_id = ? AND provider = ? AND provider_tenant_id = ?
           ORDER BY updated_at DESC LIMIT 1`,
        ).bind(
          window.workspace_id, storedUserId, identityProvider(source.provider), source.providerTenantId ?? "",
        ).first<{ id: string; provider: string; provider_tenant_id: string }>()
        : null;
      const identitySourceId = verifiedMapping ? `mapping:${verifiedMapping.id}` : `member:${storedUserId}`;
      let identityNode = await env.DB.prepare(
        `SELECT id FROM opportunity_provenance_nodes
         WHERE workspace_id = ? AND node_kind = 'identity' AND source_id = ? LIMIT 1`,
      ).bind(window.workspace_id, identitySourceId).first<{ id: string }>();
      if (!identityNode) {
        identityNode = { id: newId() };
        await env.DB.prepare(
          `INSERT INTO opportunity_provenance_nodes
           (id, workspace_id, node_kind, source_id, provider, provider_tenant_id, label,
            visibility_scope, locator_json, created_at)
           VALUES (?, ?, 'identity', ?, ?, ?, ?, 'workspace', ?, ?)`,
        ).bind(
          identityNode.id, window.workspace_id, identitySourceId,
          verifiedMapping?.provider ?? "avalon", verifiedMapping?.provider_tenant_id ?? null,
          verifiedMapping ? "Verified external identity mapping" : `Avalon member ${storedUserId}`,
          JSON.stringify(verifiedMapping ? { externalIdentityId: verifiedMapping.id } : { userId: storedUserId }), at,
        ).run();
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO opportunity_provenance_edges
         (workspace_id, parent_node_id, child_node_id, relationship, created_at)
         VALUES (?, ?, ?, 'resolved_as', ?)`,
      ).bind(window.workspace_id, mentionNodeId, identityNode.id, at).run();
    }
    await env.DB.prepare(
      `INSERT INTO work_opportunity_user_links
       (id, workspace_id, opportunity_id, user_id, role, resolution, reasoning, provenance_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(opportunity_id, user_id, role, resolution) DO UPDATE SET
        reasoning = excluded.reasoning, provenance_node_id = excluded.provenance_node_id, updated_at = excluded.updated_at`,
    ).bind(
      newId(), window.workspace_id, id, storedUserId, link.role, resolution,
      link.reasoning.slice(0, 4_000), mentionNodeId, at, at,
    ).run();
    if (storedUserId && (resolution === "verified" || (resolution === "inferred" && window.audience_scope === "workspace"))) {
      eagerUserIds.push(storedUserId);
    }
  }
  if (window.audience_scope === "personal") {
    await markSuggestedWorkDue(env, asWorkspaceId(window.workspace_id), window.audience_user_id ? [window.audience_user_id] : []);
  } else {
    await markWorkspaceSuggestedWorkDue(env, asWorkspaceId(window.workspace_id));
  }
  return { opportunityId: id, eagerUserIds };
}

async function processModelBatch(
  env: Env,
  window: WindowRow,
  batch: Array<{ event: BatchEventRow; source: ModelSource }>,
  context: Awaited<ReturnType<typeof loadAdmissionContext>>,
  durableLeaseId?: string,
): Promise<{ ok: boolean; eagerUserIds: string[] }> {
  const at = nowIso();
  await mutateOpportunityEvents(env, window, batch.map(({ event }) => event.id), "processing", null, durableLeaseId, at);
  try {
    const { result } = await runStructuredInference(env, {
      role: "work_opportunity_admission",
      context: {
        workspaceId: window.workspace_id,
        userId: window.audience_user_id ?? undefined,
      },
      messages: renderWorkOpportunityAdmissionMessages({
        audience: { scope: window.audience_scope, userId: window.audience_user_id },
        members: context.members,
        existingWork: context.existingWork,
        existingOpportunities: context.existingOpportunities,
        sources: batch.map(({ source }) => source),
      }),
      schemaName: "work_opportunity_admission",
      jsonSchema: admissionJsonSchema,
      parse: (value) => AdmissionResultSchema.parse(value),
      reasoningEffort: "high",
    });
    const sourceIds = new Set(batch.map(({ source }) => source.id));
    const eagerUserIds: string[] = [];
    for (const decision of result.decisions) {
      if (!decision.sourceIds.every((sourceId) => sourceIds.has(sourceId))) continue;
      if (decision.action === "route_existing") {
        await routeExistingDecision(
          env, window, decision, batch.map(({ source }) => source), context.existingWork,
        );
        continue;
      }
      const persisted = await persistDecision(env, window, decision, batch.map(({ source }) => source), context.members);
      eagerUserIds.push(...persisted.eagerUserIds);
    }
    await mutateOpportunityEvents(
      env, window, batch.map(({ event }) => event.id), "completed", null, durableLeaseId,
    );
    return { ok: true, eagerUserIds };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Opportunity batch failed").slice(0, 2_000);
    await mutateOpportunityEvents(
      env, window, batch.map(({ event }) => event.id), "failed", message, durableLeaseId,
    );
    return { ok: false, eagerUserIds: [] };
  }
}

async function mutateOpportunityEvents(
  env: Env,
  window: WindowRow,
  eventIds: string[],
  outcome: "processing" | "completed" | "failed" | "missing",
  error: string | null,
  durableLeaseId?: string,
  at = nowIso(),
): Promise<void> {
  if (eventIds.length === 0) return;
  if (durableLeaseId) {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      window.workspace_id,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(window.workspace_id)),
    );
    await workspace.mutateOpportunityBatchEvents({
      workspaceId: window.workspace_id,
      windowId: window.id,
      leaseId: durableLeaseId,
      eventIds,
      outcome,
      error,
    });
    return;
  }
  const status = outcome === "missing" ? "completed" : outcome;
  await env.DB.batch(eventIds.map((id) => env.DB.prepare(
    `UPDATE opportunity_batch_events SET status = ?,
       attempt_count = attempt_count + CASE WHEN ? = 'processing' THEN 1 ELSE 0 END,
       error_text = ?, updated_at = ? WHERE id = ?`,
  ).bind(status, outcome, error, at, id)));
}

export async function processClaimedOpportunityWindow(
  env: Env,
  input: Extract<WorkspaceOpportunityWorkflowInput, { kind: "admission" }>,
): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  const stored = await workspace.opportunityWindow({
    workspaceId: input.workspaceId,
    windowId: input.windowId,
    leaseId: input.leaseId,
  });
  const window: WindowRow = {
    id: stored.id,
    workspace_id: input.workspaceId,
    partition_key: stored.partitionKey,
    audience_scope: stored.audience.scope,
    audience_user_id: stored.audience.userId,
    first_event_at: stored.firstEventAt,
    last_event_at: stored.lastEventAt,
  };
  const events: BatchEventRow[] = stored.events.map((event) => ({
    id: event.id,
    source_kind: event.sourceKind,
    source_id: event.sourceId,
    occurred_at: event.occurredAt,
    input_characters: event.inputCharacters,
    attempt_count: event.attemptCount,
  }));
  const loaded = await Promise.all(events.map(async (event) => ({
    event,
    source: await loadSource(env, input.workspaceId, event),
  })));
  const valid = loaded.filter(
    (item): item is { event: BatchEventRow; source: ModelSource } => item.source !== null,
  );
  await mutateOpportunityEvents(
    env,
    window,
    loaded.filter((item) => item.source === null).map((item) => item.event.id),
    "missing",
    "Source no longer exists",
    input.leaseId,
  );
  const context = await loadAdmissionContext(env, window);
  if (env.OPENROUTER_API_KEY) {
    await mapConcurrent(packBatches(valid), MAX_MODEL_CONCURRENCY, (batch) =>
      processModelBatch(env, window, batch, context, input.leaseId));
  } else {
    await mutateOpportunityEvents(
      env,
      window,
      valid.map(({ event }) => event.id),
      "processing",
      null,
      input.leaseId,
    );
    await mutateOpportunityEvents(
      env,
      window,
      valid.map(({ event }) => event.id),
      "failed",
      "Model unavailable",
      input.leaseId,
    );
  }
  await workspace.settleOpportunityWindow({
    workspaceId: input.workspaceId,
    windowId: input.windowId,
    leaseId: input.leaseId,
    retryDelayMs: RETRY_DELAY_MS,
  });
}


async function loadBoundedProvenance(env: Env, opportunityId: string, userId: string): Promise<Array<Record<string, unknown>>> {
  const roots = await env.DB.prepare(
    `SELECT n.* FROM work_opportunity_provenance_roots r
     JOIN opportunity_provenance_nodes n ON n.id = r.node_id
     WHERE r.opportunity_id = ? AND (n.visibility_scope = 'workspace' OR n.visibility_user_id = ?)
     ORDER BY r.position LIMIT ?`,
  ).bind(opportunityId, userId, MAX_PROVENANCE_NODES).all<Record<string, unknown>>();
  const output: Array<Record<string, unknown>> = roots.results.map((node) => ({ ...node, depth: 0 }));
  const seen = new Set(output.map((node) => String(node.id)));
  let frontier = output.map((node) => String(node.id));
  for (let depth = 1; depth <= MAX_PROVENANCE_DEPTH && frontier.length > 0 && output.length < MAX_PROVENANCE_NODES; depth += 1) {
    const edges = await env.DB.prepare(
      `SELECT e.parent_node_id, e.child_node_id, e.relationship, n.*
       FROM opportunity_provenance_edges e JOIN opportunity_provenance_nodes n ON n.id = e.child_node_id
       WHERE e.parent_node_id IN (SELECT value FROM json_each(?))
         AND (n.visibility_scope = 'workspace' OR n.visibility_user_id = ?) LIMIT ?`,
    ).bind(JSON.stringify(frontier), userId, MAX_PROVENANCE_NODES - output.length).all<Record<string, unknown>>();
    frontier = [];
    for (const node of edges.results) {
      const id = String(node.id);
      if (seen.has(id)) continue;
      seen.add(id);
      frontier.push(id);
      output.push({ ...node, depth });
    }
  }
  return output.map((node) => ({
    id: node.id,
    kind: node.node_kind,
    label: String(node.label ?? "").slice(0, 500),
    provider: node.provider == null ? null : String(node.provider).slice(0, 80),
    occurredAt: node.occurred_at,
    canonicalUrl: node.canonical_url == null ? null : String(node.canonical_url).slice(0, 2_000),
    depth: node.depth,
  }));
}

async function rankingCandidates(env: Env, workspaceId: WorkspaceId, userId: UserId) {
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    const candidates = WorkspaceOpportunityRankingCandidatesResultSchema.parse(
      await workspace.opportunityRankingCandidates({ workspaceId, userId, now: nowIso() }),
    );
    return candidates.map((candidate) => boundRankingCandidate({
      ...candidate,
      public: {
        ...candidate.public,
        icon: AutomationPluginIconSchema.catch("plug").parse(candidate.public.icon),
      } satisfies WorkOpportunity,
    }));
  }
  const [rows, currentSet] = await Promise.all([
    env.DB.prepare(
    `SELECT o.id, o.version, o.display_prompt, o.admission_reasoning, o.provider_icon, o.source_label,
            o.audience_scope, o.audience_user_id, o.created_at, o.updated_at,
            s.impression_count, s.first_impressed_at, s.last_impressed_at
     FROM work_opportunities o
     LEFT JOIN work_opportunity_user_states s ON s.opportunity_id = o.id AND s.user_id = ?
     WHERE o.workspace_id = ? AND o.status = 'active' AND o.expires_at > ?
       AND (o.audience_scope = 'workspace' OR o.audience_user_id = ?)
       AND COALESCE(s.status, '') != 'dismissed'
     ORDER BY o.updated_at DESC LIMIT 60`,
    ).bind(userId, workspaceId, nowIso(), userId).all<OpportunityCandidateRow>(),
    env.DB.prepare(
      "SELECT opportunity_ids_json FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ? LIMIT 1",
    ).bind(workspaceId, userId).first<{ opportunity_ids_json: string }>(),
  ]);
  const currentIds = new Set(parseArray(currentSet?.opportunity_ids_json).filter((id): id is string => typeof id === "string"));
  return Promise.all(rows.results.map(async (row) => {
    const links = await env.DB.prepare(
      `SELECT user_id, role, resolution, reasoning FROM work_opportunity_user_links
       WHERE opportunity_id = ? ORDER BY resolution, role LIMIT 30`,
    ).bind(row.id).all<Record<string, unknown>>();
    return boundRankingCandidate({
      id: row.id,
      version: row.version,
      displayPrompt: row.display_prompt,
      admissionReasoning: row.admission_reasoning,
      linkedUsers: links.results.slice(0, 20).map((link) => ({
        ...link,
        reasoning: String(link.reasoning ?? "").slice(0, 1_000),
      })),
      provenance: await loadBoundedProvenance(env, row.id, userId),
      age: { createdAt: row.created_at, updatedAt: row.updated_at },
      impressions: {
        count: Number(row.impression_count ?? 0),
        firstAt: row.first_impressed_at,
        lastAt: row.last_impressed_at,
      },
      currentlySuggested: currentIds.has(row.id),
      public: {
        id: row.id,
        version: row.version,
        displayPrompt: row.display_prompt,
        icon: AutomationPluginIconSchema.catch("plug").parse(row.provider_icon),
        sourceLabel: row.source_label,
      } satisfies WorkOpportunity,
    });
  }));
}

async function rankBatch(
  env: Env,
  workspaceId: WorkspaceId,
  userId: UserId,
  userName: string,
  candidates: Awaited<ReturnType<typeof rankingCandidates>>,
  roundNumber: number,
  // Elimination rounds answer "which four of these twelve survive", which is a
  // coarser question than the final "in what order do these deserve attention",
  // and it is asked several times per tournament. Spending the deep reasoning
  // budget on every one of them is most of why a ranking could not finish.
  reasoningEffort: "low" | "high" = "high",
) {
  const ranking = await runStructuredInference(env, {
    role: "work_opportunity_ranking",
    context: { workspaceId, userId },
    messages: renderWorkOpportunityRankingMessages({
      user: { id: userId, name: userName },
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        version: candidate.version,
        displayPrompt: candidate.displayPrompt,
        admissionReasoning: candidate.admissionReasoning,
        linkedUsers: candidate.linkedUsers,
        provenance: candidate.provenance,
        age: candidate.age,
        impressions: candidate.impressions,
        currentlySuggested: candidate.currentlySuggested,
      })),
    }),
    schemaName: "suggested_work_ranking",
    jsonSchema: rankingJsonSchema,
    parse: (value) => RankingResultSchema.parse(value),
    reasoningEffort,
  });
  const result = ranking.result;
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const ids = [...new Set(result.orderedOpportunityIds)].filter((id) => allowed.has(id)).slice(0, 4);
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    await workspace.recordOpportunityRankingRound({
      workspaceId,
      userId,
      roundId: newId(),
      candidateIds: candidates.map((candidate) => candidate.id),
      selectedIds: ids,
      reasoning: result.rankingReasoning,
      model: ranking.model,
      roundNumber,
    });
  } else await env.DB.prepare(
    `INSERT INTO suggested_work_ranking_rounds
     (id, workspace_id, user_id, candidate_ids_json, selected_ids_json, reasoning, model, round_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(), workspaceId, userId, JSON.stringify(candidates.map((candidate) => candidate.id)),
    JSON.stringify(ids), result.rankingReasoning, ranking.model, roundNumber, nowIso(),
  ).run();
  return { ids, reasoning: result.rankingReasoning };
}

function rankingGroups(candidates: Awaited<ReturnType<typeof rankingCandidates>>) {
  const groups: Array<typeof candidates> = [];
  let current: typeof candidates = [];
  let characters = 0;
  for (const candidate of candidates) {
    const size = jsonSize(candidate);
    if (current.length > 0 && (current.length >= MAX_RANK_CANDIDATES || characters + size > MAX_RANK_CHARACTERS)) {
      groups.push(current);
      current = [];
      characters = 0;
    }
    current.push(candidate);
    characters += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export async function rankWorkOpportunitiesForUser(
  env: Env,
  workspaceId: WorkspaceId,
  userId: UserId,
  force = false,
): Promise<WorkOpportunity[]> {
  const candidates = await rankingCandidates(env, workspaceId, userId);
  const fingerprint = await sha256(candidates.map((candidate) => `${candidate.id}:${candidate.version}`).sort().join("|"));
  const authority = await readWorkstreamAuthorityControl(env);
  let cachedFingerprint: string | undefined;
  let cachedIds: string[];
  let cachedStatus: string | undefined;
  if (authority.phase === "durable_object_open") {
    const cached = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    ).then((workspace) => workspace.opportunityRankingState(workspaceId, userId));
    cachedFingerprint = cached?.candidateFingerprint;
    cachedIds = cached?.opportunityIds ?? [];
    cachedStatus = cached?.status;
  } else {
    const cached = await env.DB.prepare(
      `SELECT candidate_fingerprint, opportunity_ids_json, status
       FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ?`,
    ).bind(workspaceId, userId).first<{
      candidate_fingerprint: string;
      opportunity_ids_json: string;
      status: string;
    }>();
    cachedFingerprint = cached?.candidate_fingerprint;
    cachedIds = parseArray(cached?.opportunity_ids_json).filter((id): id is string => typeof id === "string");
    cachedStatus = cached?.status;
  }
  // The fingerprint is the whole freshness test. It hashes the id and version of
  // every candidate this member is eligible for, so it already covers an
  // admission, a revision, an expiry, a dismissal and an opportunity leaving
  // `active` — everything the workspace version counter that used to sit beside
  // it could see, and several things it could not.
  if (!force && cachedStatus === "ready" && cachedFingerprint === fingerprint) {
    const ids = cachedIds;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.public]));
    return ids.map((id) => byId.get(id)).filter((item): item is WorkOpportunity => Boolean(item)).slice(0, 4);
  }
  if (candidates.length === 0) {
    await storeRankingSet(env, workspaceId, userId, fingerprint, [], "No eligible opportunities.", "ready");
    return [];
  }
  const user = await env.DB.prepare("SELECT name FROM users WHERE id = ? LIMIT 1").bind(userId).first<{ name: string }>();
  const recencyOrder = candidates.slice(0, 4).map((candidate) => candidate.id);
  // A member with nothing stored sees nothing at all until this finishes, and
  // this is the expensive part. Put the recency order in front of them first.
  //
  // Stored against an empty fingerprint deliberately: it is a placeholder, not a
  // ranking, and if the tournament below never completes the next scheduler pass
  // has to see a cache miss and try again rather than treat this as the answer.
  if (cachedIds.length === 0 && recencyOrder.length > 0) {
    await storeRankingSet(
      env, workspaceId, userId, "", recencyOrder,
      "Provisional order, most recently revised first, while the ranking runs.",
      "ready",
    );
  }
  const deadline = Date.now() + RANK_BUDGET_MS;
  let selectedIds: string[];
  let reasoning: string;
  if (!env.OPENROUTER_API_KEY) {
    selectedIds = recencyOrder;
    reasoning = "Model ranking was unavailable; retained the most recently revised eligible opportunities.";
  } else {
    let pool = candidates;
    let roundNumber = 0;
    const rationales: string[] = [];
    while (rankingGroups(pool).length > 1) {
      if (roundNumber >= MAX_RANK_ROUNDS) {
        rationales.push("Tournament safety limit reached; retained the first four current finalists for the final comparison.");
        pool = pool.slice(0, 4);
        break;
      }
      if (Date.now() >= deadline) {
        rationales.push("Ranking budget was exhausted mid-tournament; retained the first four current finalists for the final comparison.");
        pool = pool.slice(0, 4);
        break;
      }
      const groups = rankingGroups(pool);
      const rounds = await mapConcurrent(groups, MAX_MODEL_CONCURRENCY, (group) => rankBatch(
        env, workspaceId, userId, user?.name ?? "Workspace member", group, roundNumber, "low",
      ));
      rationales.push(...rounds.map((round) => round.reasoning));
      const finalistIds = [...new Set(rounds.flatMap((round) => round.ids))];
      const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));
      const nextPool = finalistIds.map((id) => byId.get(id))
        .filter((item): item is (typeof candidates)[number] => Boolean(item));
      if (nextPool.length >= pool.length) {
        rationales.push("Tournament groups did not reduce the candidate pool; retained four current finalists for the final comparison.");
        pool = pool.slice(0, 4);
        break;
      }
      pool = nextPool;
      roundNumber += 1;
    }
    if (pool.length === 0) {
      selectedIds = recencyOrder;
      reasoning = [...rationales, "Final ranking omitted every candidate; kept the most recently revised instead."]
        .join("\n\n").slice(0, 20_000);
    } else if (Date.now() >= deadline) {
      // Out of budget with finalists in hand. Their tournament order is already
      // a judgement about what matters; shipping it beats spending another call
      // to sort four items and risking the write never happening at all.
      selectedIds = pool.slice(0, 4).map((candidate) => candidate.id);
      reasoning = [...rationales, "Ranking budget was exhausted before the final comparison; kept the surviving finalists in tournament order."]
        .join("\n\n").slice(0, 20_000);
    } else {
      const finalResult = await rankBatch(
        env, workspaceId, userId, user?.name ?? "Workspace member", pool, roundNumber,
      );
      selectedIds = finalResult.ids;
      reasoning = [...rationales, `Final ranking:\n${finalResult.reasoning}`].join("\n\n").slice(0, 20_000);
    }
  }
  // Never store an empty ranking while candidates exist. The model may return
  // nothing usable — `orderedOpportunityIds` has a maximum and no minimum, and
  // ids it invents are filtered out — and storing that against the real
  // fingerprint produces a set the read path calls unranked and the scheduler
  // then declines to re-rank, because the fingerprint says it is current. That
  // is a loop with no exit: every read asks, every pass burns a candidate load
  // and a ranking slot to change nothing, and it never self-heals.
  const settled = selectedIds.length > 0 ? selectedIds : recencyOrder;
  await storeRankingSet(env, workspaceId, userId, fingerprint, settled, reasoning, "ready");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.public]));
  return settled.map((id) => byId.get(id)).filter((item): item is WorkOpportunity => Boolean(item)).slice(0, 4);
}

async function storeRankingSet(
  env: Env,
  workspaceId: WorkspaceId,
  userId: UserId,
  fingerprint: string,
  ids: string[],
  reasoning: string,
  status: "ready" | "failed",
): Promise<void> {
  const at = nowIso();
  // The ranking agent's flagged model, so this column names the model the set
  // would be produced with rather than a variable the agent may not be using.
  // Still nullable: a deployment with no structured model configured resolves an
  // empty default, and the column has always recorded that as NULL.
  const { model } = await resolveAgentModelRouting(env, "work_opportunity_ranking", { workspaceId, userId });
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, workspaceId),
    );
    await workspace.storeOpportunityRanking({
      workspaceId,
      userId,
      candidateFingerprint: fingerprint,
      opportunityIds: ids,
      reasoning: reasoning.slice(0, 20_000),
      model: model.length > 0 ? model : null,
      status,
    });
    return;
  }
  // Writes the ranking and nothing else. The outstanding request and the lease
  // that claims it belong to the scheduler, which settles both once the run it
  // claimed is actually over — this is called mid-run for the provisional write
  // too, and clearing either here released a claim while its tournament was
  // still going.
  await env.DB.prepare(
    `INSERT INTO suggested_work_sets
     (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json,
      ranking_reasoning, model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      candidate_fingerprint = excluded.candidate_fingerprint,
      opportunity_ids_json = excluded.opportunity_ids_json, ranking_reasoning = excluded.ranking_reasoning,
      model = excluded.model, status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(
    workspaceId, userId, fingerprint, JSON.stringify(ids), reasoning.slice(0, 20_000),
    model.length > 0 ? model : null, status, at, at,
  ).run();
}


export async function processClaimedOpportunityRanking(
  env: Env,
  input: Extract<WorkspaceOpportunityWorkflowInput, { kind: "ranking" }>,
): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  try {
    await rankWorkOpportunitiesForUser(env, input.workspaceId, input.userId);
  } catch (error) {
    await workspace.settleOpportunityRanking({
      workspaceId: input.workspaceId,
      userId: input.userId,
      leaseId: input.leaseId,
      requestSeq: input.requestSeq,
      outcome: "failed",
      retryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    });
    throw error;
  }
  await workspace.settleOpportunityRanking({
    workspaceId: input.workspaceId,
    userId: input.userId,
    leaseId: input.leaseId,
    requestSeq: input.requestSeq,
    outcome: "completed",
    retryAt: null,
  });
}

/**
 * The work-stream scope a suggestion's audience maps to.
 *
 * Anything this cannot read is `personal`, which is the fail-closed direction
 * and the same one `connectorWorkstreamScope` takes for a conversation it could
 * not classify: the row reaches here through a `Record<string, unknown>` from
 * the object, so a shape that drifts must narrow rather than publish.
 */
function opportunityAudienceScope(value: unknown): Scope {
  return value === "workspace" ? "workspace" : "personal";
}

export class WorkOpportunityService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly defer?: (promise: Promise<unknown>) => void,
  ) {}

  /**
   * Read this member's suggestions. No model call, no ranking, no waiting.
   *
   * The stored set is the answer, filtered to what is still showable — an
   * opportunity can expire, be dismissed elsewhere or be started between one
   * ranking and this read, and none of those are worth a re-rank to notice.
   *
   * When there is no usable set, the most recently revised eligible
   * opportunities stand in. That is the same order a ranking falls back to when
   * no model is configured, and it is unambiguously better than the blank
   * section a member used to get while a tournament they were unknowingly
   * blocking on ran to a timeout behind their loading spinner.
   */
  async list(limit: number) {
    const size = Math.min(4, limit);
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase === "durable_object_open") {
      const workspace = await this.workspaceProduct();
      const result = await workspace.listOpportunities({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        now: nowIso(),
        limit: size,
        scheduleAt: new Date(Date.now() + DUE_DEBOUNCE_MS).toISOString(),
      });
      return WorkOpportunityPageSchema.parse(result);
    }
    const stored = await this.env.DB.prepare(
      "SELECT opportunity_ids_json, due_at FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ? LIMIT 1",
    ).bind(this.auth.workspaceId, this.auth.userId).first<{ opportunity_ids_json: string; due_at: string | null }>();
    const rankedIds = parseArray(stored?.opportunity_ids_json).filter((id): id is string => typeof id === "string");
    const ranked = await this.showableOpportunities(rankedIds);
    // Topped up rather than shown short. A hole means the ranking is one or two
    // suggestions lighter than it was, and the next scheduler pass is up to five
    // minutes away; the inline ranking this replaced always returned four, and a
    // home screen that quietly loses a row for minutes at a time would be a
    // regression the member can see.
    const filler = ranked.length < size ? await this.showableOpportunities() : [];
    const seen = new Set(ranked.map((item) => item.id));
    const items = [...ranked, ...filler.filter((item) => !seen.has(item.id))];
    if (!stored || stored.due_at === null) {
      // Two things are worth a ranking, and the difference between them is the
      // difference between a member who is missing suggestions and one who
      // simply has none.
      //
      // A hole: fewer of the ranked suggestions are showable than were ranked,
      // because one expired, was started, or was dismissed. This is the general
      // form of the case `dismiss()` handles directly, and the only thing that
      // catches a workspace-scope suggestion started by somebody else.
      //
      // Unranked candidates: eligible opportunities exist that the stored set
      // does not account for. Asking on "nothing is stored" alone meant a member
      // with no opportunities at all — whose steady state is an empty set —
      // requested a ranking on every single read, and got a scheduler claim and
      // a pair of writes each time, forever.
      const hole = ranked.length < rankedIds.length;
      const unranked = ranked.length === 0 && items.length > 0;
      if (hole || unranked) {
        const request = markSuggestedWorkDue(
          this.env, this.auth.workspaceId, [this.auth.userId], unranked ? 0 : DUE_DEBOUNCE_MS,
        ).catch((error: unknown) => {
          logWarn(this.env, "suggested_work_ranking_schedule_failed", {
            workspace_id: this.auth.workspaceId,
            user_id: this.auth.userId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        });
        if (this.defer) this.defer(request); else await request;
      }
    }
    return WorkOpportunityPageSchema.parse({ items: items.slice(0, size) });
  }

  /**
   * The public shape of the opportunities this member may currently be shown.
   *
   * With ids, the result keeps their order — that order is the ranking. Without,
   * it is the most recently revised first, which is the standing fallback.
   */
  private async showableOpportunities(ids?: string[]): Promise<WorkOpportunity[]> {
    if (ids?.length === 0) return [];
    const filter = ids ? "AND o.id IN (SELECT value FROM json_each(?5))" : "";
    const rows = await this.env.DB.prepare(
      `SELECT o.id, o.version, o.display_prompt, o.provider_icon, o.source_label
         FROM work_opportunities o
         LEFT JOIN work_opportunity_user_states s ON s.opportunity_id = o.id AND s.user_id = ?1
        WHERE o.workspace_id = ?2 AND o.status = 'active' AND o.expires_at > ?3
          AND (o.audience_scope = 'workspace' OR o.audience_user_id = ?1)
          AND COALESCE(s.status, '') != 'dismissed'
          ${filter}
        ORDER BY o.updated_at DESC LIMIT ?4`,
    ).bind(
      this.auth.userId, this.auth.workspaceId, nowIso(), 4,
      ...(ids ? [JSON.stringify(ids)] : []),
    ).all<Record<string, unknown>>();
    const byId = new Map(rows.results.map((row) => [String(row.id), {
      id: String(row.id),
      version: Number(row.version),
      displayPrompt: String(row.display_prompt),
      icon: AutomationPluginIconSchema.catch("plug").parse(row.provider_icon),
      sourceLabel: String(row.source_label),
    } satisfies WorkOpportunity]));
    return ids
      ? ids.map((id) => byId.get(id)).filter((item): item is WorkOpportunity => Boolean(item))
      : [...byId.values()];
  }

  async recordImpressions(opportunityIds: string[]): Promise<void> {
    const ids = [...new Set(opportunityIds)].slice(0, 4);
    if (ids.length === 0) return;
    const at = nowIso();
    const rerankBefore = new Date(Date.now() - IMPRESSION_RERANK_INTERVAL_MS).toISOString();
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase === "durable_object_open") {
      const workspace = await this.workspaceProduct();
      await workspace.recordOpportunityImpressions({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        opportunityIds: ids,
        now: at,
        rerankBefore,
      });
      return;
    }
    await this.env.DB.batch([
      ...ids.map((id) => this.env.DB.prepare(
      `INSERT INTO work_opportunity_user_states
       (workspace_id, opportunity_id, user_id, status, impression_count, first_impressed_at, last_impressed_at, updated_at)
       SELECT ?, o.id, ?, 'impressed', 1, ?, ?, ? FROM work_opportunities o
       WHERE o.id = ? AND o.workspace_id = ? AND o.status = 'active'
         AND (o.audience_scope = 'workspace' OR o.audience_user_id = ?)
       ON CONFLICT(opportunity_id, user_id) DO UPDATE SET
        impression_count = work_opportunity_user_states.impression_count + 1,
        first_impressed_at = COALESCE(work_opportunity_user_states.first_impressed_at, excluded.first_impressed_at),
        last_impressed_at = excluded.last_impressed_at, updated_at = excluded.updated_at`,
      ).bind(this.auth.workspaceId, this.auth.userId, at, at, at, id, this.auth.workspaceId, this.auth.userId)),
      // Impression counts feed the ranking but are not in the candidate
      // fingerprint, so nothing else would ever notice that the same four
      // suggestions have now been looked past a dozen times. This is the one
      // thing that asks for a re-rank when the candidates have not changed, and
      // it is rate-limited to once an hour because that is the only reason it
      // exists.
      //
      // Which is also why it clears the fingerprint. Asking for a ranking is not
      // enough on its own: the scheduler skips a run whose candidates hash to
      // what is already stored, and by definition that is every run this asks
      // for. Blanking the hash is what makes the request survive that check —
      // the stored suggestions are left alone, so nothing changes on screen
      // until a real ranking replaces them.
      this.env.DB.prepare(
        `UPDATE suggested_work_sets SET due_at = COALESCE(due_at, ?), candidate_fingerprint = '',
         request_seq = request_seq + 1, updated_at = ?
         WHERE workspace_id = ? AND user_id = ? AND due_at IS NULL
           AND COALESCE(last_ranked_at, created_at) <= ?`,
      ).bind(at, at, this.auth.workspaceId, this.auth.userId, rerankBefore),
    ]);
  }

  async dismiss(id: string): Promise<void> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase === "durable_object_open") {
      const workspace = await this.workspaceProduct();
      const dismissed = await workspace.dismissOpportunity({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        opportunityId: id,
        now: nowIso(),
      });
      if (!dismissed) throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
      return;
    }
    const visible = await this.visibleOpportunity(id);
    if (!visible) throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO work_opportunity_user_states
         (workspace_id, opportunity_id, user_id, status, impression_count, resolved_at, updated_at)
         VALUES (?, ?, ?, 'dismissed', 0, ?, ?)
         ON CONFLICT(opportunity_id, user_id) DO UPDATE SET status = 'dismissed', resolved_at = excluded.resolved_at, updated_at = excluded.updated_at`,
      ).bind(this.auth.workspaceId, id, this.auth.userId, at, at),
      // Dismissing leaves a hole the member can see, so this one does not wait
      // out the debounce. The read path drops the dismissed suggestion from the
      // stored set immediately; this is what refills the space it left.
      this.env.DB.prepare(
        `UPDATE suggested_work_sets SET due_at = ?, request_seq = request_seq + 1, updated_at = ?
         WHERE workspace_id = ? AND user_id = ?`,
      ).bind(at, at, this.auth.workspaceId, this.auth.userId),
    ]);
  }

  async start(id: string, version: number, idempotencyKey: string) {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase === "durable_object_open") {
      return this.startDurable(id, version, idempotencyKey);
    }
    const opportunity = await this.visibleOpportunity(id);
    if (!opportunity) throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
    if (Number(opportunity.version) !== version) {
      throw new ApiError(409, "stale_work_opportunity", "This suggestion changed; review the latest version before starting");
    }
    if (opportunity.start_idempotency_key === idempotencyKey) {
      const durable = opportunity.created_workstream_id && opportunity.created_message_id
        ? {
          workstreamId: String(opportunity.created_workstream_id),
          messageId: String(opportunity.created_message_id),
        }
        : await this.findDurableStart(id);
      if (durable) {
        await this.ensureStartedBookkeeping(opportunity, version, idempotencyKey, durable);
        return this.startedResponse(durable);
      }
    }
    const at = nowIso();
    const claimed = await this.env.DB.prepare(
      `UPDATE work_opportunities SET status = 'starting', started_by_user_id = ?, start_idempotency_key = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'active'`,
    ).bind(this.auth.userId, idempotencyKey, at, id, this.auth.workspaceId, version).run();
    if (Number(claimed.meta.changes ?? 0) !== 1) {
      const replayed = await this.waitForMatchingStart(id, version, idempotencyKey);
      if (replayed) return replayed;
      throw new ApiError(409, "work_opportunity_already_claimed", "This suggestion has already been started or changed");
    }
    let createdResult: Awaited<ReturnType<WorkstreamService["createFromOpportunity"]>>;
    try {
      createdResult = await new WorkstreamService(this.env, this.auth, this.defer).createFromOpportunity({
        opportunityId: id,
        version,
        displayPrompt: String(opportunity.display_prompt),
        executionPrompt: String(opportunity.execution_prompt),
        displayPromptHash: String(opportunity.display_prompt_hash),
        executionPromptHash: String(opportunity.execution_prompt_hash),
        idempotencyKey,
        // The suggestion's own audience. A `workspace` one was shown to every
        // member, and the work stream it becomes stays theirs to read.
        audienceScope: opportunityAudienceScope(opportunity.audience_scope),
      });
    } catch (error) {
      const durable = await this.findDurableStart(id);
      if (durable) {
        try {
          await this.ensureStartedBookkeeping(opportunity, version, idempotencyKey, durable);
        } catch {
          await this.rollForwardStartedOpportunity(id, version, idempotencyKey, durable);
        }
      } else {
        await this.env.DB.prepare(
          `UPDATE work_opportunities SET status = 'active', started_by_user_id = NULL, start_idempotency_key = NULL, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'starting' AND start_idempotency_key = ?`,
        ).bind(nowIso(), id, this.auth.workspaceId, idempotencyKey).run();
      }
      throw error;
    }

    const durable = { workstreamId: createdResult.workstream.id, messageId: createdResult.messageId };
    try {
      await this.ensureStartedBookkeeping(opportunity, version, idempotencyKey, durable);
    } catch (error) {
      await this.rollForwardStartedOpportunity(id, version, idempotencyKey, durable);
      throw error;
    }
    return createdResult;
  }

  private async findDurableStart(opportunityId: string): Promise<{ workstreamId: string; messageId: string } | null> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    const row = await this.env.DB.prepare(authority.phase === "durable_object_open"
      ? `SELECT workstream_id, message_id
           FROM workstream_create_receipts
          WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id LIKE ?
            AND state = 'completed' AND message_id IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`
      :
      `SELECT w.id AS workstream_id, m.id AS message_id
       FROM workstreams w JOIN messages m ON m.workstream_id = w.id AND m.sequence_number = 1
       WHERE w.workspace_id = ? AND w.created_from_opportunity_id = ? LIMIT 1`,
    ).bind(
      this.auth.workspaceId,
      authority.phase === "durable_object_open" ? this.auth.userId : opportunityId,
      ...(authority.phase === "durable_object_open" ? [`opportunity:${opportunityId}:v%`] : []),
    ).first<{ workstream_id: string; message_id: string }>();
    return row ? { workstreamId: row.workstream_id, messageId: row.message_id } : null;
  }

  private async rollForwardStartedOpportunity(
    opportunityId: string,
    version: number,
    idempotencyKey: string,
    durable: { workstreamId: string; messageId: string },
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE work_opportunities SET status = 'started', created_workstream_id = ?, created_message_id = ?,
       started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ? AND version = ? AND start_idempotency_key = ?`,
    ).bind(
      durable.workstreamId, durable.messageId, nowIso(), nowIso(), opportunityId,
      this.auth.workspaceId, version, idempotencyKey,
    ).run();
  }

  private async ensureStartedBookkeeping(
    opportunity: Record<string, unknown>,
    version: number,
    idempotencyKey: string,
    durable: { workstreamId: string; messageId: string },
  ): Promise<void> {
    const opportunityId = String(opportunity.id);
    const [links, provenance] = await Promise.all([
      this.env.DB.prepare(
        "SELECT user_id, role, resolution, reasoning FROM work_opportunity_user_links WHERE opportunity_id = ? LIMIT 100",
      ).bind(opportunityId).all<Record<string, unknown>>(),
      loadBoundedProvenance(this.env, opportunityId, this.auth.userId),
    ]);
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE work_opportunities SET status = 'started', created_workstream_id = ?, created_message_id = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND workspace_id = ? AND version = ? AND start_idempotency_key = ?`,
      ).bind(
        durable.workstreamId, durable.messageId, at, at, opportunityId,
        this.auth.workspaceId, version, idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT INTO work_opportunity_snapshots
         (id, opportunity_id, opportunity_version, selected_by_user_id, display_prompt_hash,
          execution_prompt_hash, identity_links_json, provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(opportunity_id, opportunity_version, selected_by_user_id) DO UPDATE SET
          display_prompt_hash = excluded.display_prompt_hash, execution_prompt_hash = excluded.execution_prompt_hash,
          identity_links_json = excluded.identity_links_json, provenance_json = excluded.provenance_json`,
      ).bind(
        newId(), opportunityId, version, this.auth.userId, opportunity.display_prompt_hash,
        opportunity.execution_prompt_hash, JSON.stringify(links.results), JSON.stringify(provenance), at,
      ),
      this.env.DB.prepare(
        `INSERT INTO work_opportunity_user_states
         (workspace_id, opportunity_id, user_id, status, impression_count, resolved_at, created_workstream_id, updated_at)
         VALUES (?, ?, ?, 'started', 0, ?, ?, ?)
         ON CONFLICT(opportunity_id, user_id) DO UPDATE SET status = 'started', resolved_at = excluded.resolved_at,
          created_workstream_id = excluded.created_workstream_id, updated_at = excluded.updated_at`,
      ).bind(this.auth.workspaceId, opportunityId, this.auth.userId, at, durable.workstreamId, at),
    ]);
    // Starting one leaves the same hole dismissing one does, so it asks for a
    // refill the same way. The read path would notice on this member's next
    // visit regardless; asking here means the space is usually already filled by
    // the time they come back from the work stream they just started.
    await markSuggestedWorkDue(this.env, this.auth.workspaceId, [this.auth.userId], 0)
      .catch((error: unknown) => {
        logWarn(this.env, "suggested_work_ranking_schedule_failed", {
          workspace_id: this.auth.workspaceId,
          opportunity_id: opportunityId,
          trigger: "start",
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  private async startedResponse(durable: { workstreamId: string; messageId: string }) {
    const existing = await new WorkstreamService(this.env, this.auth).get(durable.workstreamId);
    return { workstream: existing, messageId: durable.messageId, harnessRunId: existing.latestHarnessRunId };
  }

  private async waitForMatchingStart(id: string, version: number, idempotencyKey: string) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const current = await this.visibleOpportunity(id);
      if (!current || Number(current.version) !== version || current.start_idempotency_key !== idempotencyKey) return null;
      const durable = current.created_workstream_id && current.created_message_id
        ? { workstreamId: String(current.created_workstream_id), messageId: String(current.created_message_id) }
        : await this.findDurableStart(id);
      if (durable) {
        await this.ensureStartedBookkeeping(current, version, idempotencyKey, durable);
        return this.startedResponse(durable);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  private visibleOpportunity(id: string): Promise<Record<string, unknown> | null> {
    return this.env.DB.prepare(
      `SELECT o.* FROM work_opportunities o
       LEFT JOIN work_opportunity_user_states s ON s.opportunity_id = o.id AND s.user_id = ?
       WHERE o.id = ? AND o.workspace_id = ? AND o.expires_at > ?
         AND o.status IN ('active', 'starting', 'started')
         AND (o.audience_scope = 'workspace' OR o.audience_user_id = ?)
         AND COALESCE(s.status, '') != 'dismissed' LIMIT 1`,
    ).bind(this.auth.userId, id, this.auth.workspaceId, nowIso(), this.auth.userId).first<Record<string, unknown>>();
  }

  private workspaceProduct() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }

  private async startDurable(id: string, version: number, idempotencyKey: string) {
    const workspace = await this.workspaceProduct();
    const request = {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      opportunityId: id,
      now: nowIso(),
      version,
      idempotencyKey,
    };
    const claim = await workspace.claimOpportunityStart(request);
    if (claim.outcome === "not_found") {
      throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
    }
    if (claim.outcome === "stale") {
      throw new ApiError(409, "stale_work_opportunity", "This suggestion changed; review the latest version before starting");
    }
    const opportunity = claim.opportunity as Record<string, unknown> | null;
    if (!opportunity) throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
    if (claim.outcome === "busy") {
      throw new ApiError(409, "work_opportunity_already_claimed", "This suggestion has already been started or changed");
    }
    if (claim.outcome === "replay") {
      const durable = opportunity.created_workstream_id && opportunity.created_message_id
        ? {
          workstreamId: String(opportunity.created_workstream_id),
          messageId: String(opportunity.created_message_id),
        }
        : await this.findDurableStart(id);
      if (durable) {
        await workspace.completeOpportunityStart({
          ...request,
          workstreamId: durable.workstreamId,
          messageId: durable.messageId,
          snapshotId: newId(),
        });
        return this.startedResponse(durable);
      }
      throw new ApiError(409, "work_opportunity_start_in_progress", "This suggestion is still being started");
    }

    let createdResult: Awaited<ReturnType<WorkstreamService["createFromOpportunity"]>>;
    try {
      createdResult = await new WorkstreamService(this.env, this.auth, this.defer).createFromOpportunity({
        opportunityId: id,
        version,
        displayPrompt: String(opportunity.display_prompt),
        executionPrompt: String(opportunity.execution_prompt),
        displayPromptHash: String(opportunity.display_prompt_hash),
        executionPromptHash: String(opportunity.execution_prompt_hash),
        idempotencyKey,
        // The suggestion's own audience. A `workspace` one was shown to every
        // member, and the work stream it becomes stays theirs to read.
        audienceScope: opportunityAudienceScope(opportunity.audience_scope),
      });
    } catch (error) {
      const durable = await this.findDurableStart(id);
      if (durable) {
        await workspace.completeOpportunityStart({
          ...request,
          workstreamId: durable.workstreamId,
          messageId: durable.messageId,
          snapshotId: newId(),
        });
      } else {
        await workspace.releaseOpportunityStart(request);
      }
      throw error;
    }
    const durable = { workstreamId: createdResult.workstream.id, messageId: createdResult.messageId };
    await workspace.completeOpportunityStart({
      ...request,
      workstreamId: durable.workstreamId,
      messageId: durable.messageId,
      snapshotId: newId(),
    });
    return createdResult;
  }
}

export const __workOpportunityTesting = {
  admissionJsonSchema,
  parseAdmissionResult: (value: unknown) => AdmissionResultSchema.parse(value),
  markSuggestedWorkDue,
  markWorkspaceSuggestedWorkDue,
  packBatches,
  mapConcurrent,
  boundRankingCandidate,
  rankingGroups,
  opportunityFingerprint,
  provenanceNodeForSource,
  routeExistingDecision,
  limits: {
    batchEvents: MAX_BATCH_EVENTS,
    batchCharacters: MAX_BATCH_CHARACTERS,
    modelConcurrency: MAX_MODEL_CONCURRENCY,
    rankCandidates: MAX_RANK_CANDIDATES,
    rankCharacters: MAX_RANK_CHARACTERS,
    rankCandidateCharacters: MAX_RANK_CANDIDATE_CHARACTERS,
  },
};
