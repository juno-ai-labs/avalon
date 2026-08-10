import {
  OpenRouterClient,
  renderWorkOpportunityAdmissionMessages,
  renderWorkOpportunityRankingMessages,
} from "@avalon/agent-harness";
import {
  ConnectorError,
} from "@avalon/connectors";
import {
  AutomationPluginIconSchema,
  WorkOpportunityPageSchema,
  type WorkOpportunity,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  resolveAgentModelRouting,
  type AgentModelFlagContext,
  type AgentModelRole,
} from "./agent-model-flags";
import { createActivitySuggestion } from "./activity-suggestion-service";
import { hydrateConnectorActivitySource } from "./integrations";
import { WorkstreamService } from "./workstream-service";

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
const LEASE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const IMPRESSION_RERANK_INTERVAL_MS = 60 * 60_000;

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
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "ignore", "update_existing", "route_existing"] },
          existingTargetId: { type: ["string", "null"], format: "uuid" },
          displayPrompt: { type: "string", maxLength: 180 },
          executionPrompt: { type: "string", maxLength: 20_000 },
          admissionReasoning: { type: "string", maxLength: 20_000 },
          linkedUsers: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                userId: { type: ["string", "null"], format: "uuid" },
                role: { type: "string", maxLength: 80 },
                resolution: { type: "string", enum: ["verified", "inferred", "ambiguous", "unresolved"] },
                reasoning: { type: "string", maxLength: 4_000 },
                sourceId: { type: "string", maxLength: 200 },
                sourceText: { type: "string", maxLength: 1_000 },
                startOffset: { type: ["integer", "null"], minimum: 0 },
                endOffset: { type: ["integer", "null"], minimum: 1 },
              },
              required: ["userId", "role", "resolution", "reasoning", "sourceId", "sourceText", "startOffset", "endOffset"],
            },
          },
          sourceIds: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", maxLength: 200 } },
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

/**
 * Admission and ranking are separate agents with separate flags: admission turns
 * connector activity into prompts, ranking orders them per user, and pinning one
 * to a different model should not move the other.
 */
async function modelClient(
  env: Env,
  role: Extract<AgentModelRole, "work_opportunity_admission" | "work_opportunity_ranking">,
  context: AgentModelFlagContext,
): Promise<{ client: OpenRouterClient; model: string }> {
  const routing = await resolveAgentModelRouting(env, role, context);
  return {
    client: new OpenRouterClient({
      apiKey: env.OPENROUTER_API_KEY,
      primaryModel: routing.model,
      fallbackModels: routing.fallbackModels,
    }),
    model: routing.model,
  };
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

async function loadSource(env: Env, workspaceId: string, event: BatchEventRow): Promise<ModelSource | null> {
  if (event.source_kind === "activity") {
    const row = await env.DB.prepare(
      `SELECT a.*, c.provider_account_id
       FROM activities a JOIN connector_connections c ON c.id = a.connection_id
       WHERE a.id = ? AND a.workspace_id = ? LIMIT 1`,
    ).bind(event.source_id, workspaceId).first<Record<string, unknown>>();
    if (!row) return null;
    const metadata = parseRecord(row.metadata_json);
    const actor = boundedRecord(row.actor_json);
    const subject = boundedRecord(row.subject_json);
    const explicitPeople = boundedArray(row.external_people_json);
    let hydratedText = "";
    let hydratedCanonicalUrl: string | null = null;
    let hydratedPeople: Array<Record<string, unknown>> = [];
    if (
      ["notion", "granola"].includes(String(row.provider))
      && typeof row.provider_resource_id === "string"
      && typeof row.resource_type === "string"
    ) {
      try {
        const hydrated = await hydrateConnectorActivitySource(env, {
          workspaceId,
          connectionId: String(row.connection_id),
          providerResourceId: row.provider_resource_id,
          resourceType: row.resource_type,
        });
        hydratedText = hydrated == null ? "" : JSON.stringify(hydrated).slice(0, 8_000);
        if (String(row.provider) === "granola") {
          const hydratedRecord = boundedRecord(hydrated);
          hydratedCanonicalUrl = [hydratedRecord.web_url, hydratedRecord.webUrl, hydratedRecord.url]
            .find((value): value is string => typeof value === "string")?.slice(0, 2_000) ?? null;
          hydratedPeople = granolaHydratedPeople(
            hydrated,
            row.provider_account_id == null ? null : String(row.provider_account_id),
          );
        }
      } catch (error) {
        if (isTransientSourceHydrationError(error)) throw error;
        console.warn("Opportunity source hydration failed", {
          activity_id: event.source_id,
          provider: row.provider,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return {
      id: event.source_id,
      kind: "activity",
      provider: String(row.provider),
      providerTenantId: row.provider_account_id == null ? null : String(row.provider_account_id),
      connectionId: String(row.connection_id),
      title: String(row.title).slice(0, 1_000),
      summary: String(row.summary ?? "").slice(0, 3_000),
      text: (hydratedText || String(row.text_snippet ?? "")).slice(0, 8_000),
      actor,
      subject,
      externalPeople: explicitPeople.length > 0 || hydratedPeople.length > 0
        ? [...explicitPeople, ...hydratedPeople].slice(0, 100)
        : deriveExternalPeople(String(row.provider), row.provider_account_id == null ? null : String(row.provider_account_id), actor, subject),
      entityKeys: parseArray(row.entity_keys_json)
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
        .map((item) => item.slice(0, 200)),
      canonicalUrl: [hydratedCanonicalUrl, metadata.canonicalUrl, metadata.canonical_url, metadata.url]
        .find((value): value is string => typeof value === "string")?.slice(0, 2_000) ?? null,
      workstreamId: null,
      occurredAt: String(row.occurred_at),
    };
  }
  const row = await env.DB.prepare(
    `SELECT m.id, m.text_content, m.created_at, m.workstream_id, w.title AS workstream_title,
            u.id AS author_id, u.name AS author_name, u.email AS author_email
     FROM messages m JOIN workstreams w ON w.id = m.workstream_id
     LEFT JOIN users u ON u.id = m.author_user_id
     WHERE m.id = ? AND m.workspace_id = ? LIMIT 1`,
  ).bind(event.source_id, workspaceId).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: event.source_id,
    kind: "message",
    provider: "avalon",
    providerTenantId: workspaceId,
    connectionId: null,
    title: String(row.workstream_title),
    summary: "A workspace member mentioned someone in an Avalon work stream.",
    text: String(row.text_content).slice(0, 8_000),
    actor: { id: row.author_id, name: row.author_name, email: row.author_email },
    subject: {},
    externalPeople: [],
    entityKeys: [String(row.workstream_id)],
    canonicalUrl: null,
    workstreamId: String(row.workstream_id),
    occurredAt: String(row.created_at),
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

async function syncVerifiedIdentityDirectory(env: Env, workspaceId: string): Promise<void> {
  const [connections, slackLinks] = await Promise.all([
    env.DB.prepare(
      `SELECT connector_type, owner_user_id, provider_account_id, config_json
       FROM connector_connections
       WHERE workspace_id = ? AND scope = 'personal' AND owner_user_id IS NOT NULL
         AND provider_account_id IS NOT NULL AND status = 'healthy'`,
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
  await syncVerifiedIdentityDirectory(env, window.workspace_id);
  const [memberRows, identityRows, workRows, opportunityRows] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.status = 'active' ORDER BY u.name LIMIT 250`,
    ).bind(window.workspace_id).all<{ id: string; name: string; email: string }>(),
    env.DB.prepare(
      `SELECT user_id, provider, provider_tenant_id, provider_user_id, handle, email, display_name
       FROM external_user_identities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1000`,
    ).bind(window.workspace_id).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT w.id, w.title, w.objective FROM workstreams w
       LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
       WHERE w.workspace_id = ? AND w.archived_at IS NULL
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
    ).all<{ id: string; title: string; objective: string }>(),
    env.DB.prepare(
      `SELECT id, display_prompt, admission_reasoning FROM work_opportunities
       WHERE workspace_id = ? AND status = 'active' AND expires_at > ?
         AND ((? = 'workspace' AND audience_scope = 'workspace')
           OR (? = 'personal' AND audience_scope = 'personal' AND audience_user_id = ?))
       ORDER BY updated_at DESC LIMIT 12`,
    ).bind(
      window.workspace_id, nowIso(), window.audience_scope, window.audience_scope, window.audience_user_id,
    ).all<{ id: string; display_prompt: string; admission_reasoning: string }>(),
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

async function bumpWorkspaceVersion(env: Env, workspaceId: string): Promise<void> {
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_opportunity_versions (workspace_id, version, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
    ).bind(workspaceId, at),
    env.DB.prepare("UPDATE suggested_work_sets SET status = 'stale', updated_at = ? WHERE workspace_id = ?")
      .bind(at, workspaceId),
  ]);
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
    workspaceId: window.workspace_id,
    activityId: source.id,
    activityTitle: source.title,
    activitySummary: source.summary,
    workstreamId: targetId,
    confidence: 1,
    reason,
    matchedEntities: source.entityKeys,
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
        ? await env.DB.prepare(
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
  await bumpWorkspaceVersion(env, window.workspace_id);
  return { opportunityId: id, eagerUserIds };
}

async function processModelBatch(
  env: Env,
  window: WindowRow,
  batch: Array<{ event: BatchEventRow; source: ModelSource }>,
  context: Awaited<ReturnType<typeof loadAdmissionContext>>,
): Promise<{ ok: boolean; eagerUserIds: string[] }> {
  const at = nowIso();
  await env.DB.batch(batch.map(({ event }) => env.DB.prepare(
    `UPDATE opportunity_batch_events SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
  ).bind(at, event.id)));
  try {
    const admission = await modelClient(env, "work_opportunity_admission", {
      workspaceId: window.workspace_id,
      userId: window.audience_user_id ?? undefined,
    });
    const result = await admission.client.structured({
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
    await env.DB.batch(batch.map(({ event }) => env.DB.prepare(
      `UPDATE opportunity_batch_events SET status = 'completed', error_text = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), event.id)));
    return { ok: true, eagerUserIds };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Opportunity batch failed").slice(0, 2_000);
    await env.DB.batch(batch.map(({ event }) => env.DB.prepare(
      `UPDATE opportunity_batch_events SET status = 'failed', error_text = ?, updated_at = ? WHERE id = ?`,
    ).bind(message, nowIso(), event.id)));
    return { ok: false, eagerUserIds: [] };
  }
}

async function requeueFailures(env: Env, window: WindowRow): Promise<void> {
  const failed = await env.DB.prepare(
    `SELECT id, occurred_at FROM opportunity_batch_events
     WHERE window_id = ? AND status = 'failed' AND attempt_count < 3 ORDER BY occurred_at`,
  ).bind(window.id).all<{ id: string; occurred_at: string }>();
  if (failed.results.length === 0) return;
  let next = await env.DB.prepare(
    `SELECT id FROM opportunity_batch_windows WHERE workspace_id = ? AND partition_key = ? AND status = 'queued' LIMIT 1`,
  ).bind(window.workspace_id, window.partition_key).first<{ id: string }>();
  const at = nowIso();
  if (!next) {
    next = { id: newId() };
    await env.DB.prepare(
      `INSERT INTO opportunity_batch_windows
       (id, workspace_id, partition_key, audience_scope, audience_user_id, first_event_at, last_event_at,
        process_after, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      next.id, window.workspace_id, window.partition_key, window.audience_scope, window.audience_user_id,
      failed.results[0]!.occurred_at, failed.results.at(-1)!.occurred_at,
      new Date(Date.now() + RETRY_DELAY_MS).toISOString(), at, at,
    ).run();
  }
  await env.DB.batch(failed.results.map((event) => env.DB.prepare(
    `UPDATE opportunity_batch_events SET window_id = ?, status = 'pending', updated_at = ? WHERE id = ?`,
  ).bind(next!.id, at, event.id)));
}

async function processWindow(env: Env, window: WindowRow): Promise<string[]> {
  const events = await env.DB.prepare(
    `SELECT id, source_kind, source_id, occurred_at, input_characters, attempt_count
     FROM opportunity_batch_events WHERE window_id = ? AND status IN ('pending', 'failed')
     ORDER BY occurred_at, id`,
  ).bind(window.id).all<BatchEventRow>();
  const loaded = await Promise.all(events.results.map(async (event) => ({ event, source: await loadSource(env, window.workspace_id, event) })));
  const valid = loaded.filter((item): item is { event: BatchEventRow; source: ModelSource } => item.source !== null);
  if (valid.length !== loaded.length) {
    const missing = loaded.filter((item) => item.source === null);
    await env.DB.batch(missing.map(({ event }) => env.DB.prepare(
      "UPDATE opportunity_batch_events SET status = 'completed', error_text = 'Source no longer exists', updated_at = ? WHERE id = ?",
    ).bind(nowIso(), event.id)));
  }
  const context = await loadAdmissionContext(env, window);
  const batches = packBatches(valid);
  const results = env.OPENROUTER_API_KEY
    ? await mapConcurrent(batches, MAX_MODEL_CONCURRENCY, (batch) => processModelBatch(env, window, batch, context))
    : [];
  if (!env.OPENROUTER_API_KEY && valid.length > 0) {
    await env.DB.batch(valid.map(({ event }) => env.DB.prepare(
      "UPDATE opportunity_batch_events SET status = 'failed', attempt_count = attempt_count + 1, error_text = 'Model unavailable', updated_at = ? WHERE id = ?",
    ).bind(nowIso(), event.id)));
  }
  await requeueFailures(env, window);
  await env.DB.prepare(
    `UPDATE opportunity_batch_windows SET status = 'completed', lease_id = NULL, lease_expires_at = NULL,
     completed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), nowIso(), window.id).run();
  return [...new Set(results.flatMap((result) => result.eagerUserIds))];
}

export async function processDueOpportunityWindows(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT id, workspace_id, partition_key, audience_scope, audience_user_id, first_event_at, last_event_at
     FROM opportunity_batch_windows
     WHERE (status = 'queued' AND process_after <= ?)
        OR (status = 'processing' AND lease_expires_at < ?)
     ORDER BY process_after LIMIT 12`,
  ).bind(nowIso(), nowIso()).all<WindowRow>();
  const eagerTargets = new Map<string, Set<string>>();
  for (const candidate of due.results) {
    const leaseId = newId();
    const claim = await env.DB.prepare(
      `UPDATE opportunity_batch_windows SET status = 'processing', lease_id = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND ((status = 'queued' AND process_after <= ?) OR (status = 'processing' AND lease_expires_at < ?))`,
    ).bind(leaseId, new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), candidate.id, nowIso(), nowIso()).run();
    if (Number(claim.meta.changes ?? 0) !== 1) continue;
    const targets = await processWindow(env, candidate);
    const set = eagerTargets.get(candidate.workspace_id) ?? new Set<string>();
    targets.forEach((target) => set.add(target));
    eagerTargets.set(candidate.workspace_id, set);
  }
  for (const [workspaceId, userIds] of eagerTargets) {
    await mapConcurrent([...userIds], MAX_MODEL_CONCURRENCY, async (userId) => {
      await rankWorkOpportunitiesForUser(env, workspaceId, userId, true);
    });
  }
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

async function rankingCandidates(env: Env, workspaceId: string, userId: string) {
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
  workspaceId: string,
  userId: string,
  userName: string,
  candidates: Awaited<ReturnType<typeof rankingCandidates>>,
  roundNumber: number,
) {
  const ranking = await modelClient(env, "work_opportunity_ranking", { workspaceId, userId });
  const result = await ranking.client.structured({
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
    reasoningEffort: "high",
  });
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const ids = [...new Set(result.orderedOpportunityIds)].filter((id) => allowed.has(id)).slice(0, 4);
  await env.DB.prepare(
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
  workspaceId: string,
  userId: string,
  force = false,
): Promise<WorkOpportunity[]> {
  const candidates = await rankingCandidates(env, workspaceId, userId);
  const version = await env.DB.prepare(
    "SELECT version FROM workspace_opportunity_versions WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ version: number }>();
  const fingerprint = await sha256(candidates.map((candidate) => `${candidate.id}:${candidate.version}`).sort().join("|"));
  const cached = await env.DB.prepare(
    `SELECT workspace_version, candidate_fingerprint, opportunity_ids_json, status
     FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ?`,
  ).bind(workspaceId, userId).first<Record<string, unknown>>();
  if (!force && cached?.status === "ready" && Number(cached.workspace_version) === Number(version?.version ?? 0)
      && cached.candidate_fingerprint === fingerprint) {
    const ids = parseArray(cached.opportunity_ids_json).filter((id): id is string => typeof id === "string");
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.public]));
    return ids.map((id) => byId.get(id)).filter((item): item is WorkOpportunity => Boolean(item)).slice(0, 4);
  }
  if (candidates.length === 0) {
    await storeRankingSet(env, workspaceId, userId, Number(version?.version ?? 0), fingerprint, [], "No eligible opportunities.", "ready");
    return [];
  }
  const user = await env.DB.prepare("SELECT name FROM users WHERE id = ? LIMIT 1").bind(userId).first<{ name: string }>();
  let selectedIds: string[];
  let reasoning: string;
  if (!env.OPENROUTER_API_KEY) {
    selectedIds = candidates.slice(0, 4).map((candidate) => candidate.id);
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
      const groups = rankingGroups(pool);
      const rounds = await mapConcurrent(groups, MAX_MODEL_CONCURRENCY, (group) => rankBatch(
        env, workspaceId, userId, user?.name ?? "Workspace member", group, roundNumber,
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
      selectedIds = [];
      reasoning = [...rationales, "Final ranking omitted every candidate."].join("\n\n").slice(0, 20_000);
    } else {
      const finalResult = await rankBatch(
        env, workspaceId, userId, user?.name ?? "Workspace member", pool, roundNumber,
      );
      selectedIds = finalResult.ids;
      reasoning = [...rationales, `Final ranking:\n${finalResult.reasoning}`].join("\n\n").slice(0, 20_000);
    }
  }
  await storeRankingSet(env, workspaceId, userId, Number(version?.version ?? 0), fingerprint, selectedIds, reasoning, "ready");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.public]));
  return selectedIds.map((id) => byId.get(id)).filter((item): item is WorkOpportunity => Boolean(item)).slice(0, 4);
}

async function storeRankingSet(
  env: Env,
  workspaceId: string,
  userId: string,
  version: number,
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
  await env.DB.prepare(
    `INSERT INTO suggested_work_sets
     (workspace_id, user_id, workspace_version, candidate_fingerprint, opportunity_ids_json,
      ranking_reasoning, model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      workspace_version = excluded.workspace_version, candidate_fingerprint = excluded.candidate_fingerprint,
      opportunity_ids_json = excluded.opportunity_ids_json, ranking_reasoning = excluded.ranking_reasoning,
      model = excluded.model, status = excluded.status, lease_id = NULL, lease_expires_at = NULL,
      updated_at = excluded.updated_at`,
  ).bind(
    workspaceId, userId, version, fingerprint, JSON.stringify(ids), reasoning.slice(0, 20_000),
    model.length > 0 ? model : null, status, at, at,
  ).run();
}

export class WorkOpportunityService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list(limit: number) {
    const items = await rankWorkOpportunitiesForUser(this.env, this.auth.workspaceId, this.auth.userId);
    return WorkOpportunityPageSchema.parse({ items: items.slice(0, Math.min(4, limit)) });
  }

  async recordImpressions(opportunityIds: string[]): Promise<void> {
    const ids = [...new Set(opportunityIds)].slice(0, 4);
    if (ids.length === 0) return;
    const at = nowIso();
    const rerankBefore = new Date(Date.now() - IMPRESSION_RERANK_INTERVAL_MS).toISOString();
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
      this.env.DB.prepare(
        `UPDATE suggested_work_sets SET status = 'stale', updated_at = ?
         WHERE workspace_id = ? AND user_id = ? AND status = 'ready' AND updated_at <= ?`,
      ).bind(at, this.auth.workspaceId, this.auth.userId, rerankBefore),
    ]);
  }

  async dismiss(id: string): Promise<void> {
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
      this.env.DB.prepare("UPDATE suggested_work_sets SET status = 'stale', updated_at = ? WHERE workspace_id = ? AND user_id = ?")
        .bind(at, this.auth.workspaceId, this.auth.userId),
    ]);
  }

  async start(id: string, version: number, idempotencyKey: string) {
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
      createdResult = await new WorkstreamService(this.env, this.auth).createFromOpportunity({
        opportunityId: id,
        version,
        displayPrompt: String(opportunity.display_prompt),
        executionPrompt: String(opportunity.execution_prompt),
        displayPromptHash: String(opportunity.display_prompt_hash),
        executionPromptHash: String(opportunity.execution_prompt_hash),
        idempotencyKey,
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
    const row = await this.env.DB.prepare(
      `SELECT w.id AS workstream_id, m.id AS message_id
       FROM workstreams w JOIN messages m ON m.workstream_id = w.id AND m.sequence_number = 1
       WHERE w.workspace_id = ? AND w.created_from_opportunity_id = ? LIMIT 1`,
    ).bind(this.auth.workspaceId, opportunityId).first<{ workstream_id: string; message_id: string }>();
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
}

export const __workOpportunityTesting = {
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
