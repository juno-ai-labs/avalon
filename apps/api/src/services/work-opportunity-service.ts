import {
  renderWorkOpportunityAdmissionMessages,
  renderWorkOpportunityRankingMessages,
} from "@rally/agent-harness";
import {
  ConnectorError,
} from "@rally/connectors";
import {
  AutomationPluginIconSchema,
  WorkOpportunityPageSchema,
  asWorkspaceId,
  type Scope,
  type UserId,
  type WorkOpportunity,
  type WorkspaceId,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { activityContentAudience } from "../lib/activity-visibility";
import {
  contentAudienceAllowsUser,
  type ContentAudience,
} from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceOpportunityClaimStartResultSchema,
  WorkspaceOpportunityRankingCandidatesResultSchema,
  WorkspaceOpportunityTelemetryContextSchema,
  WorkspaceOpportunityTelemetryContextsSchema,
  type WorkspaceOpportunityWorkflowInput,
} from "../durable-objects/workspace-opportunity-protocol";
import { WorkspaceConnectorEventSchema } from "../durable-objects/workspace-connector-event-protocol";
import { resolveAgentModelRouting } from "./agent-model-flags";
import { hydrateConnectorActivitySource } from "./integrations";
import { logWarn } from "../observability/logger";
import { runStructuredInference } from "./structured-inference";
import { WorkstreamService } from "./workstream-service";
import { readWorkstreamRuntimeAudience } from "./workstream-object-client";
import { withWorkspaceRuntimeDatabase, workspaceRuntimeDatabase } from "./workspace-runtime-database";

const MAX_BATCH_EVENTS = 16;
const MAX_BATCH_CHARACTERS = 24_000;
const MAX_MODEL_CONCURRENCY = 3;
const MAX_RANK_CANDIDATES = 12;
const MAX_RANK_CHARACTERS = 80_000;
const MAX_RANK_CANDIDATE_CHARACTERS = 12_000;
const MAX_RANK_ROUNDS = 10;
const OPPORTUNITY_TTL_MS = 14 * 24 * 60 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const IMPRESSION_RERANK_INTERVAL_MS = 60 * 60_000;
// How long a stream of admissions may go on before the sets behind it are
// reordered: the delay `persistDecision` writes for the members an admission
// makes due, and the default for `markSuggestedWorkDue`. This was two minutes,
// which read as "a member who is watching does not notice the wait" — but with
// activity flowing continuously it meant a member was re-ranked every two
// minutes all day (1,970 tournaments for three people on 2026-09-02), and
// nobody watches the home screen at that cadence. It governs nothing else: the
// immediate triggers — a suggestion naming the member, a dismissal, a start —
// write their own due time, and the read path's repair has its own delay
// below. The number is a product setting, not a derived one.
const DUE_DEBOUNCE_MS = 30 * 60_000;
// How long after a member *opens the home screen* and finds their set unranked
// or holed the ranking that repairs it may wait. This is a member standing in
// front of the surface, not a stream of admissions, so it does not share the
// debounce above: a new member sees the recency fallback until this fires,
// and that is their first impression of the product. It fires only on a hole
// or an unranked set, never on an ordinary read, so its cost is bounded by how
// often those arise rather than by how often people look.
const READ_REPAIR_DELAY_MS = 2 * 60_000;
// How much of an existing opportunity's admission reasoning the next admission
// call gets to see, per opportunity. Up to twelve of them ride along on every
// call, and at the previous 4,000-character cap they were roughly half of an
// 18,000-token prompt whose actual evidence was four activities. The model
// needs enough of the rationale to recognise a duplicate, not the whole memo.
// The number is a starting point, not a measurement.
const ADMISSION_CONTEXT_REASONING_CHARACTERS = 600;
// Seen this recently and the member is presumed to be looking at Avalon now, so
// their set is ranked ahead of everyone else's.
// Not seen for this long and no amount of incoming activity earns them a model
// tournament. Their set is left due and is picked up on the first scheduler pass
// after they next authenticate.
// Wall-clock a single member's tournament may spend before it settles for the
// finalists it already has. The point is that it always writes something.
const RANK_BUDGET_MS = 2 * 60_000;
const UserLinkDecisionSchema = z.strictObject({
  userId: z.string().uuid().nullable(),
  role: z.string().min(1).max(80),
  resolution: z.enum(["verified", "inferred", "ambiguous", "unresolved"]),
  reasoning: z.string().max(4_000),
  sourceId: z.string().min(1).max(200),
  sourceText: z.string().max(1_000),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().positive().nullable(),
});

const AdmissionDecisionSchema = z.strictObject({
  action: z.enum(["add", "ignore", "update_existing"]),
  existingTargetId: z.string().uuid().nullable(),
  displayPrompt: z.string().max(180),
  executionPrompt: z.string().max(20_000),
  admissionReasoning: z.string().max(20_000),
  linkedUsers: z.array(UserLinkDecisionSchema).max(30),
  sourceIds: z.array(z.string().min(1).max(200)).min(1).max(16),
});
const AdmissionResultSchema = z.strictObject({ decisions: z.array(AdmissionDecisionSchema).max(4) });

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
          action: { type: "string", enum: ["add", "ignore", "update_existing"] },
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

const RankingResultSchema = z.strictObject({
  orderedOpportunityIds: z.array(z.string().uuid()).max(4),
  rankingReasoning: z.string().min(1).max(20_000),
});
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
  sourceAudience: ContentAudience;
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
  if (providers.length === 1) return providers[0] === "avalon" ? "Rally activity" : `From ${providers[0]}`;
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

function sourceVisibleToWindow(sourceAudience: ContentAudience, window: WindowRow): boolean {
  if (window.audience_scope === "workspace") return sourceAudience.scope === "workspace";
  return Boolean(
    window.audience_user_id && contentAudienceAllowsUser(sourceAudience, window.audience_user_id),
  );
}

function directoryAudienceForWindow(window: WindowRow):
  { scope: "workspace" } | { scope: "user"; userId: string } {
  if (window.audience_scope === "workspace") return { scope: "workspace" };
  if (!window.audience_user_id) throw new Error("personal_opportunity_window_missing_user");
  return { scope: "user", userId: window.audience_user_id };
}

function persistedSource(source: ModelSource) {
  const { sourceAudience, ...persisted } = source;
  void sourceAudience;
  return persisted;
}

async function loadSource(
  env: Env,
  workspaceId: WorkspaceId,
  event: BatchEventRow,
  window: WindowRow,
): Promise<ModelSource | null> {
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
    const sourceAudience = activityContentAudience({
      connection_scope: activity.connectionScope,
      connection_owner_user_id: activity.connectionOwnerUserId,
      target_user_ids_json: JSON.stringify(activity.targetUserIds),
      visibility_json: JSON.stringify(activity.visibility),
    });
    if (!sourceAudience || !sourceVisibleToWindow(sourceAudience, window)) return null;
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
      sourceAudience,
    };
  }
  const activity = await workspace.activityEventSource({
    workspaceId,
    sourceKind: "workstream_message",
    sourceId: event.source_id,
  });
  if (!activity?.audienceWorkstreamId) return null;
  const readerAudience = await readWorkstreamRuntimeAudience(
    env,
    workspaceId,
    activity.audienceWorkstreamId,
  );
  const sourceAudience: ContentAudience | null = readerAudience?.scope === "workspace"
    ? { scope: "workspace" }
    : readerAudience?.userIds.length
      ? { scope: "users", userIds: readerAudience.userIds }
      : null;
  if (!sourceAudience || !sourceVisibleToWindow(sourceAudience, window)) return null;
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
    summary: "A workspace member mentioned someone in a Rally work stream.",
    text: activity.body.slice(0, 8_000),
    actor: author ?? { id: activity.actorUserId, name: activity.actorLabel },
    subject: {},
    externalPeople: [],
    entityKeys: [activity.audienceWorkstreamId],
    canonicalUrl: null,
    workstreamId: activity.audienceWorkstreamId,
    occurredAt: activity.occurredAt,
    sourceAudience,
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
    if (config.providerUserId === null) continue;
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
  const directoryAudience = directoryAudienceForWindow(window);
  const workspacePromise = durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    window.workspace_id,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(window.workspace_id)),
  );
  const workRowsPromise = workspacePromise
    .then((workspace) => workspace.recentWorkstreamDirectory({
      workspaceId: window.workspace_id,
      audience: directoryAudience,
      includeSystem: false,
      participantsOnly: false,
      limit: 20,
    })).then((page) => ({ results: page.items.map((item) => ({
      id: item.workstreamId,
      title: item.title,
      objective: item.description,
    })) }));
  const opportunityRowsPromise = workspacePromise
    .then((workspace) => workspace.existingOpportunities({
      workspaceId: window.workspace_id,
      audience: { scope: window.audience_scope, userId: window.audience_user_id },
      now: nowIso(),
      limit: 12,
    })).then((results) => ({ results: results.map((row) => ({
      id: row.id,
      display_prompt: row.displayPrompt,
      admission_reasoning: row.admissionReasoning,
    })) }));
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
      admissionReasoning: row.admission_reasoning.slice(0, ADMISSION_CONTEXT_REASONING_CHARACTERS),
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
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  );
  await workspace.markOpportunityRankingDue(workspaceId, targets, delayMs);
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
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  );
  await workspace.markWorkspaceOpportunityRankingDue(workspaceId, delayMs);
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

async function persistDecision(
  env: Env,
  window: WindowRow,
  decision: z.infer<typeof AdmissionDecisionSchema>,
  sources: ModelSource[],
  members: Array<{ id: string; name: string; email: string; verifiedAliases: string[] }>,
): Promise<{ opportunityId: string | null; eagerUserIds: string[] }> {
  if (decision.action === "ignore") return { opportunityId: null, eagerUserIds: [] };
  if (!decision.displayPrompt.trim() || !decision.executionPrompt.trim() || !decision.admissionReasoning.trim()) {
    return { opportunityId: null, eagerUserIds: [] };
  }
  const referenced = sources.filter((source) => decision.sourceIds.includes(source.id));
  if (referenced.length === 0) return { opportunityId: null, eagerUserIds: [] };
  const fingerprint = await opportunityFingerprint(window, referenced);
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
    sources: referenced.map(persistedSource),
    links: normalizedLinks,
    rankUserIds,
    eagerUserIds,
    rankDueAt: new Date(Date.now() + DUE_DEBOUNCE_MS).toISOString(),
  });
  return { opportunityId: persisted.opportunityId, eagerUserIds: persisted.eagerUserIds };
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
      activity: "work_opportunity",
      context: {
        workspaceId: window.workspace_id,
        userId: window.audience_user_id ?? undefined,
      },
      messages: renderWorkOpportunityAdmissionMessages({
        audience: { scope: window.audience_scope, userId: window.audience_user_id },
        members: context.members,
        existingWork: context.existingWork,
        existingOpportunities: context.existingOpportunities,
        sources: batch.map(({ source }) => ({
          ...persistedSource(source),
          visibility: source.sourceAudience.scope === "workspace" ? "workspace" : "restricted",
        })),
      }),
      schemaName: "work_opportunity_admission",
      jsonSchema: admissionJsonSchema,
      parse: (value) => AdmissionResultSchema.parse(value),
      // Admission is a coarse gate biased toward `ignore`, asked tens of
      // thousands of times a day; the ranking's elimination rounds already run
      // low for the same reason. At `high`, reasoning was a quarter of every
      // admission call's output tokens.
      reasoningEffort: "low",
    });
    const sourceIds = new Set(batch.map(({ source }) => source.id));
    const eagerUserIds: string[] = [];
    for (const decision of result.decisions) {
      if (!decision.sourceIds.every((sourceId) => sourceIds.has(sourceId))) continue;
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
    source: await loadSource(env, input.workspaceId, event, window),
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

async function rankingCandidates(env: Env, workspaceId: WorkspaceId, userId: UserId) {
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
    activity: "work_opportunity",
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
  const cached = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  ).then((workspace) => workspace.opportunityRankingState(workspaceId, userId));
  const cachedFingerprint = cached?.candidateFingerprint;
  const cachedIds = cached?.opportunityIds ?? [];
  const cachedStatus = cached?.status;
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
  // The ranking agent's flagged model, so this column names the model the set
  // would be produced with rather than a variable the agent may not be using.
  // Still nullable: a deployment with no structured model configured resolves an
  // empty default, and the column has always recorded that as NULL.
  const { model } = await resolveAgentModelRouting(env, "work_opportunity_ranking", { workspaceId, userId });
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
    const workspace = await this.workspaceProduct();
    const result = await workspace.listOpportunities({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      now: nowIso(),
      limit: size,
      scheduleAt: new Date(Date.now() + READ_REPAIR_DELAY_MS).toISOString(),
    });
    return WorkOpportunityPageSchema.parse(result);
  }

  async recordImpressions(opportunityIds: string[]) {
    const ids = [...new Set(opportunityIds)].slice(0, 4);
    if (ids.length === 0) return [];
    const at = nowIso();
    const rerankBefore = new Date(Date.now() - IMPRESSION_RERANK_INTERVAL_MS).toISOString();
    const workspace = await this.workspaceProduct();
    const result = await workspace.recordOpportunityImpressions({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      opportunityIds: ids,
      now: at,
      rerankBefore,
    });
    const parsed = WorkspaceOpportunityTelemetryContextsSchema.safeParse(result);
    return parsed.success ? parsed.data : [];
  }

  async dismiss(id: string) {
    const workspace = await this.workspaceProduct();
    const result = await workspace.dismissOpportunity({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      opportunityId: id,
      now: nowIso(),
    });
    if (!result.dismissed) throw new ApiError(404, "work_opportunity_not_found", "Suggested work was not found");
    const context = WorkspaceOpportunityTelemetryContextSchema.nullable().safeParse(result.telemetryContext);
    return context.success ? context.data : null;
  }

  async start(id: string, version: number, idempotencyKey: string) {
    return this.startDurable(id, version, idempotencyKey);
  }

  private async findDurableStart(opportunityId: string): Promise<{ workstreamId: string; turnId: string } | null> {
    const row = await this.env.DB.prepare(
      `SELECT workstream_id, message_id
         FROM workstream_create_receipts
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id LIKE ?
          AND state = 'completed' AND message_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    ).bind(
      this.auth.workspaceId,
      this.auth.userId,
      `opportunity:${opportunityId}:v%`,
    ).first<{ workstream_id: string; message_id: string }>();
    return row ? { workstreamId: row.workstream_id, turnId: row.message_id } : null;
  }

  private async startedResponse(durable: { workstreamId: string; turnId: string }) {
    const existing = await new WorkstreamService(this.env, this.auth).get(durable.workstreamId);
    return { workstream: existing, turnId: durable.turnId, harnessRunId: existing.latestHarnessRunId };
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
    const claim = WorkspaceOpportunityClaimStartResultSchema.parse(
      await workspace.claimOpportunityStart(request),
    );
    const parsedTelemetryContext = WorkspaceOpportunityTelemetryContextSchema.nullable()
      .safeParse(claim.telemetryContext);
    const telemetryContext = parsedTelemetryContext.success ? parsedTelemetryContext.data : null;
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
          turnId: String(opportunity.created_message_id),
        }
        : await this.findDurableStart(id);
      if (durable) {
        await workspace.completeOpportunityStart({
          ...request,
          workstreamId: durable.workstreamId,
          messageId: durable.turnId,
          snapshotId: newId(),
        });
        return { ...await this.startedResponse(durable), telemetryContext };
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
          messageId: durable.turnId,
          snapshotId: newId(),
        });
      } else {
        await workspace.releaseOpportunityStart(request);
      }
      throw error;
    }
    const durable = { workstreamId: createdResult.workstream.id, turnId: createdResult.turnId };
    await workspace.completeOpportunityStart({
      ...request,
      workstreamId: durable.workstreamId,
      messageId: durable.turnId,
      snapshotId: newId(),
    });
    return { ...createdResult, telemetryContext };
  }
}

export const __workOpportunityTesting = {
  syncVerifiedIdentityDirectory,
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
  limits: {
    batchEvents: MAX_BATCH_EVENTS,
    batchCharacters: MAX_BATCH_CHARACTERS,
    modelConcurrency: MAX_MODEL_CONCURRENCY,
    dueDebounceMs: DUE_DEBOUNCE_MS,
    readRepairDelayMs: READ_REPAIR_DELAY_MS,
    admissionContextReasoningCharacters: ADMISSION_CONTEXT_REASONING_CHARACTERS,
    rankCandidates: MAX_RANK_CANDIDATES,
    rankCharacters: MAX_RANK_CHARACTERS,
    rankCandidateCharacters: MAX_RANK_CANDIDATE_CHARACTERS,
  },
};
