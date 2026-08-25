import {
  TELEMETRY_CONNECTOR_TYPES,
  type TelemetryConnectorType,
} from "@rally/contracts/telemetry";

import { uuidV7 } from "../lib/uuid-v7";
import type {
  WorkspaceOpportunityBatchEventsRequest,
  WorkspaceOpportunityClaimStartRequest,
  WorkspaceOpportunityCompleteStartRequest,
  WorkspaceOpportunityDismissRequest,
  WorkspaceOpportunityEnqueueRequest,
  WorkspaceOpportunityExistingRequest,
  WorkspaceOpportunityGetRequest,
  WorkspaceOpportunityImpressionsRequest,
  WorkspaceOpportunityListRequest,
  WorkspaceOpportunityOriginEventsRequest,
  WorkspaceOpportunityPersistRequest,
  WorkspaceOpportunityRankingCandidatesRequest,
  WorkspaceOpportunityRankingRoundRequest,
  WorkspaceOpportunityRankingSettleRequest,
  WorkspaceOpportunityStoreRankingRequest,
  WorkspaceOpportunityTelemetryContext,
  WorkspaceOpportunityWindowRequest,
  WorkspaceOpportunityWindowSettleRequest,
} from "./workspace-opportunity-protocol";

const OPPORTUNITY_WINDOW_LEASE_MS = 10 * 60_000;
const OPPORTUNITY_RANKING_LEASE_MS = 10 * 60_000;
const OPPORTUNITY_DEBOUNCE_MS = 10 * 60_000;
const OPPORTUNITY_MAX_DELAY_MS = 60 * 60_000;
const MAX_PROVENANCE_DEPTH = 4;
const MAX_PROVENANCE_NODES = 32;
// Generous fences against the 10 GB object ceiling, not product semantics.
const RANKING_ROUND_RETENTION_MS = 180 * 24 * 60 * 60_000;
const EXPIRED_OPPORTUNITY_GRACE_MS = 180 * 24 * 60 * 60_000;
const TELEMETRY_CONNECTOR_TYPE_SET = new Set<string>(TELEMETRY_CONNECTOR_TYPES);

function epoch(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("workspace_product_timestamp_invalid");
  return parsed;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function processAfter(firstEventAt: number, lastEventAt: number): number {
  return Math.min(lastEventAt + OPPORTUNITY_DEBOUNCE_MS, firstEventAt + OPPORTUNITY_MAX_DELAY_MS);
}

interface WindowRow extends Record<string, SqlStorageValue> {
  window_id: string;
  partition_key: string;
  audience_scope: "personal" | "workspace";
  audience_user_id: string | null;
  first_event_at: number;
  last_event_at: number;
  process_after: number;
  attempt: number;
  lease_id: string | null;
  lease_expires_at: number | null;
}

interface OpportunityRow extends Record<string, SqlStorageValue> {
  opportunity_id: string;
  audience_scope: "personal" | "workspace";
  audience_user_id: string | null;
  display_prompt: string;
  execution_prompt: string;
  admission_reasoning: string;
  provider_icon: string;
  source_label: string;
  source_fingerprint: string;
  version: number;
  display_prompt_hash: string;
  execution_prompt_hash: string;
  status: "active" | "starting" | "started" | "superseded" | "expired";
  created_workstream_id: string | null;
  created_message_id: string | null;
  started_by_user_id: string | null;
  start_idempotency_key: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
}

/** Synchronous repository for product state whose transaction boundary is one WorkspaceDO. */
export class WorkspaceProductStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  enqueueOpportunitySource(input: WorkspaceOpportunityEnqueueRequest, now = Date.now()) {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      let window = sql.exec<WindowRow>(
        `SELECT * FROM opportunity_batch_windows
          WHERE partition_key = ? AND status = 'pending' LIMIT 1`,
        input.partitionKey,
      ).toArray()[0];
      if (!window) {
        const windowId = uuidV7(now);
        sql.exec(
          `INSERT INTO opportunity_batch_windows (
            window_id, partition_key, audience_scope, audience_user_id,
            first_event_at, last_event_at, process_after, status, attempt,
            lease_id, lease_expires_at, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL)`,
          windowId,
          input.partitionKey,
          input.audience.scope,
          input.audience.userId,
          now,
          now,
          processAfter(now, now),
          now,
          now,
        );
        window = sql.exec<WindowRow>(
          `SELECT * FROM opportunity_batch_windows WHERE window_id = ?`,
          windowId,
        ).one();
      }
      const due = processAfter(window.first_event_at, now);
      sql.exec(
        `UPDATE opportunity_batch_windows
            SET last_event_at = MAX(last_event_at, ?), process_after = ?, updated_at = ?
          WHERE window_id = ? AND status = 'pending'`,
        now,
        due,
        now,
        window.window_id,
      );
      const batchEventId = uuidV7(now);
      const inserted = sql.exec<{ batch_event_id: string }>(
        `INSERT OR IGNORE INTO opportunity_batch_events (
          batch_event_id, window_id, partition_key, source_kind, source_id,
          occurred_at, input_characters, status, attempt_count, error_text,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
        RETURNING batch_event_id`,
        batchEventId,
        window.window_id,
        input.partitionKey,
        input.sourceKind,
        input.sourceId,
        epoch(input.occurredAt),
        input.inputCharacters,
        now,
        now,
      ).toArray()[0];
      return {
        windowId: window.window_id,
        processAfter: new Date(due).toISOString(),
        inserted: Boolean(inserted),
      };
    });
  }

  dueOpportunityWindows(now: number, limit: number): WindowRow[] {
    return this.storage.sql.exec<WindowRow>(
      `SELECT * FROM opportunity_batch_windows
        WHERE (status = 'pending' AND process_after <= ?)
           OR (status = 'processing' AND lease_expires_at < ?)
        ORDER BY process_after, window_id LIMIT ?`,
      now,
      now,
      limit,
    ).toArray();
  }

  claimOpportunityWindow(windowId: string, now: number) {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<WindowRow>(
        `SELECT * FROM opportunity_batch_windows WHERE window_id = ?`,
        windowId,
      ).toArray()[0];
      if (!row) return null;
      if (row.attempt >= 5) {
        const eligible = (row.status === "pending" && row.process_after <= now)
          || (row.status === "processing" && (row.lease_expires_at ?? 0) < now);
        if (eligible) {
          this.storage.sql.exec(
            `UPDATE opportunity_batch_events
                SET status = 'failed', attempt_count = 3,
                    error_text = 'Admission retry limit exhausted', updated_at = ?
              WHERE window_id = ? AND status IN ('pending', 'processing', 'failed')`,
            now,
            windowId,
          );
          this.storage.sql.exec(
            `UPDATE opportunity_batch_windows
                SET status = 'completed', lease_id = NULL, lease_expires_at = NULL,
                    completed_at = ?, updated_at = ?
              WHERE window_id = ?`,
            now,
            now,
            windowId,
          );
        }
        return null;
      }
      const leaseId = uuidV7(now);
      const attempt = row.attempt + 1;
      const changed = this.storage.sql.exec<{ window_id: string }>(
        `UPDATE opportunity_batch_windows
            SET status = 'processing', attempt = ?, lease_id = ?, lease_expires_at = ?, updated_at = ?
          WHERE window_id = ? AND (
            (status = 'pending' AND process_after <= ?)
            OR (status = 'processing' AND lease_expires_at < ?)
          ) RETURNING window_id`,
        attempt,
        leaseId,
        now + OPPORTUNITY_WINDOW_LEASE_MS,
        now,
        windowId,
        now,
        now,
      ).toArray().length;
      return changed === 1 ? { windowId, leaseId, attempt } : null;
    });
  }

  opportunityWindow(input: WorkspaceOpportunityWindowRequest) {
    const window = this.storage.sql.exec<WindowRow>(
      `SELECT * FROM opportunity_batch_windows
        WHERE window_id = ? AND lease_id = ? AND status = 'processing'`,
      input.windowId,
      input.leaseId,
    ).toArray()[0];
    if (!window) throw new Error("opportunity_window_lease_fenced");
    const events = this.storage.sql.exec<{
      batch_event_id: string;
      source_kind: "activity" | "message";
      source_id: string;
      occurred_at: number;
      input_characters: number;
      attempt_count: number;
    }>(
      `SELECT batch_event_id, source_kind, source_id, occurred_at,
              input_characters, attempt_count
         FROM opportunity_batch_events
        WHERE window_id = ? AND status IN ('pending', 'failed')
        ORDER BY occurred_at, batch_event_id`,
      input.windowId,
    ).toArray();
    return {
      id: window.window_id,
      partitionKey: window.partition_key,
      audience: { scope: window.audience_scope, userId: window.audience_user_id },
      firstEventAt: new Date(window.first_event_at).toISOString(),
      lastEventAt: new Date(window.last_event_at).toISOString(),
      events: events.map((event) => ({
        id: event.batch_event_id,
        sourceKind: event.source_kind,
        sourceId: event.source_id,
        occurredAt: new Date(event.occurred_at).toISOString(),
        inputCharacters: Number(event.input_characters),
        attemptCount: Number(event.attempt_count),
      })),
    };
  }

  mutateOpportunityBatchEvents(input: WorkspaceOpportunityBatchEventsRequest, now = Date.now()): void {
    this.storage.transactionSync(() => {
      const lease = this.storage.sql.exec<{ window_id: string }>(
        `SELECT window_id FROM opportunity_batch_windows
          WHERE window_id = ? AND lease_id = ? AND status = 'processing'`,
        input.windowId,
        input.leaseId,
      ).toArray()[0];
      if (!lease) {
        const settled = this.storage.sql.exec<{ status: string }>(
          `SELECT status FROM opportunity_batch_windows WHERE window_id = ?`,
          input.windowId,
        ).toArray()[0];
        if (settled?.status === "completed") return;
        throw new Error("opportunity_window_lease_fenced");
      }
      const placeholders = input.eventIds.map(() => "?").join(",");
      const status = input.outcome === "missing" ? "completed" : input.outcome;
      this.storage.sql.exec(
        `UPDATE opportunity_batch_events
            SET status = ?,
                attempt_count = attempt_count + CASE WHEN ? = 'processing' THEN 1 ELSE 0 END,
                error_text = ?, updated_at = ?
          WHERE window_id = ? AND batch_event_id IN (${placeholders})`,
        status,
        input.outcome,
        input.error,
        now,
        input.windowId,
        ...input.eventIds,
      );
    });
  }

  settleOpportunityWindow(input: WorkspaceOpportunityWindowSettleRequest, now = Date.now()): void {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const window = sql.exec<WindowRow>(
        `SELECT * FROM opportunity_batch_windows WHERE window_id = ?`,
        input.windowId,
      ).toArray()[0];
      if (window?.status === "completed") return;
      if (!window || window.status !== "processing" || window.lease_id !== input.leaseId) {
        throw new Error("opportunity_window_lease_fenced");
      }
      const failed = sql.exec<{ batch_event_id: string; occurred_at: number }>(
        `SELECT batch_event_id, occurred_at FROM opportunity_batch_events
          WHERE window_id = ? AND status = 'failed' AND attempt_count < 3
          ORDER BY occurred_at, batch_event_id`,
        input.windowId,
      ).toArray();
      if (failed.length > 0) {
        let next = sql.exec<WindowRow>(
          `SELECT * FROM opportunity_batch_windows
            WHERE partition_key = ? AND status = 'pending' LIMIT 1`,
          window.partition_key,
        ).toArray()[0];
        if (!next) {
          const nextId = uuidV7(now);
          const first = failed[0]!.occurred_at;
          const last = failed.at(-1)!.occurred_at;
          sql.exec(
            `INSERT INTO opportunity_batch_windows (
              window_id, partition_key, audience_scope, audience_user_id,
              first_event_at, last_event_at, process_after, status, attempt,
              lease_id, lease_expires_at, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL)`,
            nextId,
            window.partition_key,
            window.audience_scope,
            window.audience_user_id,
            first,
            last,
            now + input.retryDelayMs,
            now,
            now,
          );
          next = sql.exec<WindowRow>(
            `SELECT * FROM opportunity_batch_windows WHERE window_id = ?`,
            nextId,
          ).one();
        }
        for (const event of failed) {
          sql.exec(
            `UPDATE opportunity_batch_events
                SET window_id = ?, status = 'pending', updated_at = ?
              WHERE batch_event_id = ?`,
            next.window_id,
            now,
            event.batch_event_id,
          );
        }
      }
      sql.exec(
        `UPDATE opportunity_batch_windows
            SET status = 'completed', lease_id = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE window_id = ? AND lease_id = ?`,
        now,
        now,
        input.windowId,
        input.leaseId,
      );
    });
  }

  existingOpportunities(input: WorkspaceOpportunityExistingRequest) {
    return this.storage.sql.exec<OpportunityRow>(
      `SELECT * FROM work_opportunities
        WHERE status = 'active' AND expires_at > ?
          AND ((? = 'workspace' AND audience_scope = 'workspace')
            OR (? = 'personal' AND audience_scope = 'personal' AND audience_user_id = ?))
        ORDER BY updated_at DESC, opportunity_id LIMIT ?`,
      epoch(input.now),
      input.audience.scope,
      input.audience.scope,
      input.audience.userId,
      input.limit,
    ).toArray().map((row) => ({
      id: row.opportunity_id,
      displayPrompt: row.display_prompt,
      admissionReasoning: row.admission_reasoning,
    }));
  }

  private provenanceNode(input: {
    nodeKind: string;
    sourceId: string | null;
    provider: string | null;
    providerTenantId: string | null;
    canonicalUrl: string | null;
    label: string;
    occurredAt: number | null;
    visibilityScope: "personal" | "workspace";
    visibilityUserId: string | null;
    locator: unknown;
    now: number;
  }): string {
    const sql = this.storage.sql;
    const existing = sql.exec<{ node_id: string }>(
      `SELECT node_id FROM opportunity_provenance_nodes
        WHERE node_kind = ? AND COALESCE(source_id, '') = COALESCE(?, '')
          AND COALESCE(provider, '') = COALESCE(?, '')
          AND COALESCE(provider_tenant_id, '') = COALESCE(?, '')
          AND visibility_scope = ?
          AND COALESCE(visibility_user_id, '') = COALESCE(?, '') LIMIT 1`,
      input.nodeKind,
      input.sourceId,
      input.provider,
      input.providerTenantId,
      input.visibilityScope,
      input.visibilityUserId,
    ).toArray()[0];
    if (existing) return existing.node_id;
    const nodeId = uuidV7(input.now);
    sql.exec(
      `INSERT INTO opportunity_provenance_nodes (
        node_id, node_kind, source_id, provider, provider_tenant_id,
        canonical_url, label, occurred_at, visibility_scope,
        visibility_user_id, locator_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nodeId,
      input.nodeKind,
      input.sourceId,
      input.provider,
      input.providerTenantId,
      input.canonicalUrl,
      input.label,
      input.occurredAt,
      input.visibilityScope,
      input.visibilityUserId,
      JSON.stringify(input.locator),
      input.now,
    );
    return nodeId;
  }

  private provenanceEdge(parent: string, child: string, relationship: string, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO opportunity_provenance_edges
         (parent_node_id, child_node_id, relationship, created_at) VALUES (?, ?, ?, ?)`,
      parent,
      child,
      relationship,
      now,
    );
  }

  persistOpportunity(input: WorkspaceOpportunityPersistRequest, now = Date.now()) {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const existing = input.existingTargetId
        ? sql.exec<OpportunityRow>(
          `SELECT * FROM work_opportunities
            WHERE opportunity_id = ? AND audience_scope = ? AND audience_user_id IS ? LIMIT 1`,
          input.existingTargetId,
          input.audience.scope,
          input.audience.userId,
        ).toArray()[0]
        : sql.exec<OpportunityRow>(
          `SELECT * FROM work_opportunities WHERE source_fingerprint = ? LIMIT 1`,
          input.sourceFingerprint,
        ).toArray()[0];
      const opportunityId = existing?.opportunity_id ?? input.proposedId;
      const exactReplay = existing !== undefined
        && existing.audience_scope === input.audience.scope
        && existing.audience_user_id === input.audience.userId
        && existing.display_prompt === input.displayPrompt
        && existing.execution_prompt === input.executionPrompt
        && existing.admission_reasoning === input.admissionReasoning
        && existing.provider_icon === input.providerIcon
        && existing.source_label === input.sourceLabel
        && existing.source_fingerprint === input.sourceFingerprint
        && existing.display_prompt_hash === input.displayPromptHash
        && existing.execution_prompt_hash === input.executionPromptHash;
      if (exactReplay || existing?.status === "starting" || existing?.status === "started") {
        return {
          opportunityId,
          version: Number(existing.version),
          eagerUserIds: [...new Set(input.eagerUserIds)],
        };
      }
      const version = Number(existing?.version ?? 0) + 1;
      if (existing) {
        sql.exec(
          `UPDATE work_opportunities SET audience_scope = ?, audience_user_id = ?,
              display_prompt = ?, execution_prompt = ?, admission_reasoning = ?,
              provider_icon = ?, source_label = ?, source_fingerprint = ?, version = ?,
              display_prompt_hash = ?, execution_prompt_hash = ?, status = 'active',
              expires_at = ?, updated_at = ? WHERE opportunity_id = ?`,
          input.audience.scope,
          input.audience.userId,
          input.displayPrompt,
          input.executionPrompt,
          input.admissionReasoning,
          input.providerIcon,
          input.sourceLabel,
          input.sourceFingerprint,
          version,
          input.displayPromptHash,
          input.executionPromptHash,
          epoch(input.expiresAt),
          now,
          opportunityId,
        );
      } else {
        sql.exec(
          `INSERT INTO work_opportunities (
            opportunity_id, audience_scope, audience_user_id, display_prompt,
            execution_prompt, admission_reasoning, provider_icon, source_label,
            source_fingerprint, version, display_prompt_hash, execution_prompt_hash,
            status, created_workstream_id, created_message_id, started_by_user_id,
            start_idempotency_key, expires_at, created_at, updated_at, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`,
          opportunityId,
          input.audience.scope,
          input.audience.userId,
          input.displayPrompt,
          input.executionPrompt,
          input.admissionReasoning,
          input.providerIcon,
          input.sourceLabel,
          input.sourceFingerprint,
          input.displayPromptHash,
          input.executionPromptHash,
          epoch(input.expiresAt),
          now,
          now,
        );
      }

      sql.exec(`DELETE FROM work_opportunity_provenance_roots WHERE opportunity_id = ?`, opportunityId);
      sql.exec(`DELETE FROM work_opportunity_user_links WHERE opportunity_id = ?`, opportunityId);
      const rootBySourceId = new Map<string, string>();
      for (const [position, source] of input.sources.entries()) {
        const occurredAt = epoch(source.occurredAt);
        const rootId = this.provenanceNode({
          nodeKind: source.kind,
          sourceId: source.id,
          provider: source.provider,
          providerTenantId: source.providerTenantId,
          canonicalUrl: source.canonicalUrl,
          label: source.title.slice(0, 1_000),
          occurredAt,
          visibilityScope: input.audience.scope,
          visibilityUserId: input.audience.userId,
          locator: {
            sourceId: source.id,
            connectionId: source.connectionId,
            workstreamId: source.workstreamId,
          },
          now,
        });
        rootBySourceId.set(source.id, rootId);
        sql.exec(
          `INSERT INTO work_opportunity_provenance_roots
             (opportunity_id, node_id, position) VALUES (?, ?, ?)`,
          opportunityId,
          rootId,
          position,
        );
        if (source.canonicalUrl) {
          const urlNode = this.provenanceNode({
            nodeKind: "provider_url",
            sourceId: `url:${source.canonicalUrl}`,
            provider: source.provider,
            providerTenantId: source.providerTenantId,
            canonicalUrl: source.canonicalUrl,
            label: source.title.slice(0, 1_000),
            occurredAt,
            visibilityScope: input.audience.scope,
            visibilityUserId: input.audience.userId,
            locator: {},
            now,
          });
          this.provenanceEdge(rootId, urlNode, "part_of", now);
        }
        for (const [index, value] of source.externalPeople.entries()) {
          const person = value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : { sourceText: String(value) };
          const label = String(
            person.sourceText ?? person.displayName ?? person.handle ?? person.email ?? "External person",
          ).slice(0, 1_000);
          const personNode = this.provenanceNode({
            nodeKind: "external_person",
            sourceId: `${source.id}:external-person:${index}`,
            provider: source.provider,
            providerTenantId: source.providerTenantId,
            canonicalUrl: null,
            label,
            occurredAt,
            visibilityScope: input.audience.scope,
            visibilityUserId: input.audience.userId,
            locator: person,
            now,
          });
          this.provenanceEdge(
            rootId,
            personNode,
            String(person.role ?? "mentions") === "assignee" ? "assigned_to" : "mentions",
            now,
          );
        }
        if (source.workstreamId) {
          const workstreamNode = this.provenanceNode({
            nodeKind: "workstream",
            sourceId: source.workstreamId,
            provider: null,
            providerTenantId: null,
            canonicalUrl: null,
            label: source.title.slice(0, 1_000),
            occurredAt,
            visibilityScope: input.audience.scope,
            visibilityUserId: input.audience.userId,
            locator: { workstreamId: source.workstreamId },
            now,
          });
          this.provenanceEdge(rootId, workstreamNode, "part_of", now);
        }
      }

      for (const link of input.links) {
        const source = input.sources.find((candidate) => candidate.id === link.sourceId);
        const rootId = rootBySourceId.get(link.sourceId);
        if (!source || !rootId) continue;
        let provenanceNodeId = rootId;
        if (link.sourceText.trim()) {
          const exactOffsets = link.startOffset !== null && link.endOffset !== null
            && link.endOffset > link.startOffset
            && source.text.slice(link.startOffset, link.endOffset) === link.sourceText;
          provenanceNodeId = this.provenanceNode({
            nodeKind: "external_person",
            sourceId: `${source.id}:model-person:${link.role}:${link.sourceText}`,
            provider: source.provider,
            providerTenantId: source.providerTenantId,
            canonicalUrl: null,
            label: link.sourceText.slice(0, 1_000),
            occurredAt: epoch(source.occurredAt),
            visibilityScope: input.audience.scope,
            visibilityUserId: input.audience.userId,
            locator: {
              role: link.role,
              sourceText: link.sourceText,
              startOffset: exactOffsets ? link.startOffset : null,
              endOffset: exactOffsets ? link.endOffset : null,
              suppliedAs: exactOffsets ? "exact_span" : "model_reference",
            },
            now,
          });
          this.provenanceEdge(
            rootId,
            provenanceNodeId,
            link.role.toLocaleLowerCase().includes("assign") ? "assigned_to" : "mentions",
            now,
          );
        }
        if (link.userId) {
          const identity = link.verifiedIdentity;
          const identityNode = this.provenanceNode({
            nodeKind: "identity",
            sourceId: identity ? `mapping:${identity.id}` : `member:${link.userId}`,
            provider: identity?.provider ?? "avalon",
            providerTenantId: identity?.providerTenantId ?? null,
            canonicalUrl: null,
            label: identity ? "Verified external identity mapping" : `Avalon member ${link.userId}`,
            occurredAt: null,
            visibilityScope: "workspace",
            visibilityUserId: null,
            locator: identity ? { externalIdentityId: identity.id } : { userId: link.userId },
            now,
          });
          this.provenanceEdge(provenanceNodeId, identityNode, "resolved_as", now);
        }
        sql.exec(
          `INSERT INTO work_opportunity_user_links (
            link_id, opportunity_id, user_id, role, resolution, reasoning,
            provenance_node_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          link.id,
          opportunityId,
          link.userId,
          link.role,
          link.resolution,
          link.reasoning,
          provenanceNodeId,
          now,
          now,
        );
      }

      const eager = new Set(input.eagerUserIds);
      for (const userId of new Set(input.rankUserIds)) {
        const dueAt = eager.has(userId) ? now : epoch(input.rankDueAt);
        this.markRankingDue(userId, dueAt, now);
      }
      return { opportunityId, version, eagerUserIds: [...eager] };
    });
  }

  markRankingDue(userId: string, dueAt: number, now = Date.now(), clearFingerprint = false): number {
    this.storage.sql.exec(
      `INSERT INTO suggested_work_sets (
        user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        model, status, due_at, request_seq, lease_id, lease_expires_at,
        last_ranked_at, created_at, updated_at
      ) VALUES (?, '', '[]', '', NULL, 'stale', ?, 1, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        due_at = MIN(COALESCE(suggested_work_sets.due_at, excluded.due_at), excluded.due_at),
        candidate_fingerprint = CASE WHEN ? = 1 THEN '' ELSE suggested_work_sets.candidate_fingerprint END,
        request_seq = suggested_work_sets.request_seq + 1,
        updated_at = excluded.updated_at`,
      userId,
      dueAt,
      now,
      now,
      clearFingerprint ? 1 : 0,
    );
    return Number(this.storage.sql.exec<{ request_seq: number }>(
      `SELECT request_seq FROM suggested_work_sets WHERE user_id = ?`,
      userId,
    ).one().request_seq);
  }

  dueRankingRows(now: number, limit: number) {
    return this.storage.sql.exec<{
      user_id: string;
      request_seq: number;
      due_at: number;
    }>(
      `SELECT user_id, request_seq, due_at FROM suggested_work_sets
        WHERE due_at IS NOT NULL AND due_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
        ORDER BY due_at, user_id LIMIT ?`,
      now,
      now,
      limit,
    ).toArray();
  }

  claimRanking(userId: string, requestSeq: number, now: number) {
    const leaseId = uuidV7(now);
    const changed = this.storage.sql.exec<{ user_id: string }>(
      `UPDATE suggested_work_sets
          SET lease_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE user_id = ? AND request_seq = ? AND due_at IS NOT NULL AND due_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
        RETURNING user_id`,
      leaseId,
      now + OPPORTUNITY_RANKING_LEASE_MS,
      now,
      userId,
      requestSeq,
      now,
      now,
    ).toArray().length;
    return changed === 1 ? { userId, requestSeq, leaseId } : null;
  }

  private boundedProvenance(opportunityId: string, userId: string): Array<Record<string, unknown>> {
    const roots = this.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT node.*, root.position FROM work_opportunity_provenance_roots root
        JOIN opportunity_provenance_nodes node ON node.node_id = root.node_id
       WHERE root.opportunity_id = ?
         AND (node.visibility_scope = 'workspace' OR node.visibility_user_id = ?)
       ORDER BY root.position LIMIT ?`,
      opportunityId,
      userId,
      MAX_PROVENANCE_NODES,
    ).toArray();
    const output: Array<Record<string, unknown>> = roots.map((node) => ({ ...node, depth: 0 }));
    const seen = new Set(output.map((node) => String(node.node_id)));
    let frontier = output.map((node) => String(node.node_id));
    for (
      let depth = 1;
      depth <= MAX_PROVENANCE_DEPTH && frontier.length > 0 && output.length < MAX_PROVENANCE_NODES;
      depth += 1
    ) {
      const placeholders = frontier.map(() => "?").join(",");
      const edges = this.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT edge.parent_node_id, edge.relationship, node.*
           FROM opportunity_provenance_edges edge
           JOIN opportunity_provenance_nodes node ON node.node_id = edge.child_node_id
          WHERE edge.parent_node_id IN (${placeholders})
            AND (node.visibility_scope = 'workspace' OR node.visibility_user_id = ?)
          LIMIT ?`,
        ...frontier,
        userId,
        MAX_PROVENANCE_NODES - output.length,
      ).toArray();
      frontier = [];
      for (const node of edges) {
        const id = String(node.node_id);
        if (seen.has(id)) continue;
        seen.add(id);
        frontier.push(id);
        output.push({ ...node, depth });
      }
    }
    return output.map((node) => ({
      id: node.node_id,
      kind: node.node_kind,
      label: String(node.label ?? "").slice(0, 500),
      provider: node.provider == null ? null : String(node.provider).slice(0, 80),
      occurredAt: node.occurred_at == null ? null : iso(Number(node.occurred_at)),
      canonicalUrl: node.canonical_url == null ? null : String(node.canonical_url).slice(0, 2_000),
      relationship: node.relationship,
      parentNodeId: node.parent_node_id,
      depth: node.depth,
      locator: String(node.locator_json ?? "{}").slice(0, 500),
    }));
  }

  rankingCandidates(input: WorkspaceOpportunityRankingCandidatesRequest) {
    const rows = this.storage.sql.exec<OpportunityRow & {
      impression_count: number | null;
      first_impressed_at: number | null;
      last_impressed_at: number | null;
    }>(
      `SELECT opportunity.*, state.impression_count, state.first_impressed_at,
              state.last_impressed_at
         FROM work_opportunities opportunity
         LEFT JOIN work_opportunity_user_states state
           ON state.opportunity_id = opportunity.opportunity_id AND state.user_id = ?
        WHERE opportunity.status = 'active' AND opportunity.expires_at > ?
          AND (opportunity.audience_scope = 'workspace' OR opportunity.audience_user_id = ?)
          AND COALESCE(state.status, '') != 'dismissed'
        ORDER BY opportunity.updated_at DESC, opportunity.opportunity_id LIMIT 60`,
      input.userId,
      epoch(input.now),
      input.userId,
    ).toArray();
    const current = this.storage.sql.exec<{ opportunity_ids_json: string }>(
      `SELECT opportunity_ids_json FROM suggested_work_sets WHERE user_id = ?`,
      input.userId,
    ).toArray()[0];
    const currentIds = new Set(parseArray(current?.opportunity_ids_json).map(String));
    return rows.map((row) => {
      const links = this.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT user_id, role, resolution, reasoning FROM work_opportunity_user_links
          WHERE opportunity_id = ? ORDER BY resolution, role LIMIT 30`,
        row.opportunity_id,
      ).toArray();
      return {
        id: row.opportunity_id,
        version: Number(row.version),
        displayPrompt: row.display_prompt,
        admissionReasoning: row.admission_reasoning,
        linkedUsers: links.map((link) => ({
          ...link,
          reasoning: String(link.reasoning ?? "").slice(0, 1_000),
        })),
        provenance: this.boundedProvenance(row.opportunity_id, input.userId),
        age: { createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) },
        impressions: {
          count: Number(row.impression_count ?? 0),
          firstAt: iso(row.first_impressed_at),
          lastAt: iso(row.last_impressed_at),
        },
        currentlySuggested: currentIds.has(row.opportunity_id),
        public: {
          id: row.opportunity_id,
          version: Number(row.version),
          displayPrompt: row.display_prompt,
          icon: row.provider_icon,
          sourceLabel: row.source_label,
        },
      };
    });
  }

  rankingState(userId: string) {
    const row = this.storage.sql.exec<{
      candidate_fingerprint: string;
      opportunity_ids_json: string;
      status: "stale" | "ready" | "failed";
    }>(
      `SELECT candidate_fingerprint, opportunity_ids_json, status
         FROM suggested_work_sets WHERE user_id = ?`,
      userId,
    ).toArray()[0];
    return row ? {
      candidateFingerprint: row.candidate_fingerprint,
      opportunityIds: parseArray(row.opportunity_ids_json).map(String),
      status: row.status,
    } : null;
  }

  recordRankingRound(input: WorkspaceOpportunityRankingRoundRequest, now = Date.now()): void {
    this.storage.sql.exec(
      `INSERT INTO suggested_work_ranking_rounds (
        round_id, user_id, candidate_ids_json, selected_ids_json, reasoning,
        model, round_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.roundId,
      input.userId,
      JSON.stringify(input.candidateIds),
      JSON.stringify(input.selectedIds),
      input.reasoning,
      input.model,
      input.roundNumber,
      now,
    );
  }

  /**
   * Age settled suggested-work state out on the product alarm. Retention is
   * deliberately generous — the 10 GB object ceiling is the only hard bound:
   * ranking rounds older than the audit window, opportunities that expired
   * half a year ago without ever being started (a started opportunity is kept
   * forever as the anchor its snapshot and work stream reference), and
   * evidence nodes no surviving root, user link, or edge-path can reach.
   */
  reapSettledSuggestedWork(now = Date.now()): void {
    this.storage.sql.exec(
      `DELETE FROM suggested_work_ranking_rounds
        WHERE round_id IN (
          SELECT round_id FROM suggested_work_ranking_rounds
           WHERE created_at < ? ORDER BY created_at LIMIT 200
        )`,
      now - RANKING_ROUND_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM work_opportunities
        WHERE opportunity_id IN (
          SELECT opportunity_id FROM work_opportunities
           WHERE started_at IS NULL AND created_workstream_id IS NULL
             AND expires_at < ?
           ORDER BY expires_at LIMIT 100
        )`,
      now - EXPIRED_OPPORTUNITY_GRACE_MS,
    );
    // Interior evidence nodes are reachable only through edges, so liveness
    // is a graph walk from the roots and user links, not a direct-reference
    // check; edges cascade with their nodes, letting later sweeps finish any
    // subgraph this bounded batch starts.
    this.storage.sql.exec(
      `DELETE FROM opportunity_provenance_nodes
        WHERE node_id IN (
          SELECT candidate.node_id FROM opportunity_provenance_nodes candidate
           WHERE candidate.created_at < ?
             AND candidate.node_id NOT IN (
               WITH RECURSIVE live(node_id) AS (
                 SELECT node_id FROM work_opportunity_provenance_roots
                 UNION
                 SELECT provenance_node_id FROM work_opportunity_user_links
                  WHERE provenance_node_id IS NOT NULL
                 UNION
                 SELECT edge.child_node_id FROM opportunity_provenance_edges edge
                   JOIN live ON live.node_id = edge.parent_node_id
                 UNION
                 SELECT edge.parent_node_id FROM opportunity_provenance_edges edge
                   JOIN live ON live.node_id = edge.child_node_id
               )
               SELECT node_id FROM live
             )
           ORDER BY candidate.created_at LIMIT 200
        )`,
      now - EXPIRED_OPPORTUNITY_GRACE_MS,
    );
  }

  storeRanking(input: WorkspaceOpportunityStoreRankingRequest, now = Date.now()): void {
    this.storage.sql.exec(
      `INSERT INTO suggested_work_sets (
        user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        model, status, due_at, request_seq, lease_id, lease_expires_at,
        last_ranked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        candidate_fingerprint = excluded.candidate_fingerprint,
        opportunity_ids_json = excluded.opportunity_ids_json,
        ranking_reasoning = excluded.ranking_reasoning,
        model = excluded.model, status = excluded.status, updated_at = excluded.updated_at`,
      input.userId,
      input.candidateFingerprint,
      JSON.stringify(input.opportunityIds),
      input.reasoning,
      input.model,
      input.status,
      now,
      now,
    );
  }

  settleRanking(input: WorkspaceOpportunityRankingSettleRequest, now = Date.now()): void {
    if (input.outcome === "completed") {
      this.storage.sql.exec(
        `UPDATE suggested_work_sets
            SET lease_id = NULL, lease_expires_at = NULL, last_ranked_at = ?,
                due_at = CASE WHEN request_seq = ? THEN NULL ELSE due_at END,
                updated_at = ?
          WHERE user_id = ? AND lease_id = ?`,
        now,
        input.requestSeq,
        now,
        input.userId,
        input.leaseId,
      );
      return;
    }
    this.storage.sql.exec(
      `UPDATE suggested_work_sets
          SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
              due_at = CASE WHEN request_seq = ? THEN ? ELSE due_at END,
              updated_at = ?
        WHERE user_id = ? AND lease_id = ?`,
      input.requestSeq,
      input.retryAt === null ? now : epoch(input.retryAt),
      now,
      input.userId,
      input.leaseId,
    );
  }

  listOpportunities(input: WorkspaceOpportunityListRequest, now = Date.now()) {
    return this.storage.transactionSync(() => {
      const stored = this.storage.sql.exec<{ opportunity_ids_json: string; due_at: number | null }>(
        `SELECT opportunity_ids_json, due_at FROM suggested_work_sets WHERE user_id = ?`,
        input.userId,
      ).toArray()[0];
      const rankedIds = parseArray(stored?.opportunity_ids_json).map(String);
      const showable = (ids?: string[]) => {
        if (ids?.length === 0) return [];
        const filter = ids ? `AND opportunity.opportunity_id IN (${ids.map(() => "?").join(",")})` : "";
        const rows = this.storage.sql.exec<OpportunityRow>(
          `SELECT opportunity.* FROM work_opportunities opportunity
            LEFT JOIN work_opportunity_user_states state
              ON state.opportunity_id = opportunity.opportunity_id AND state.user_id = ?
           WHERE opportunity.status = 'active' AND opportunity.expires_at > ?
             AND (opportunity.audience_scope = 'workspace' OR opportunity.audience_user_id = ?)
             AND COALESCE(state.status, '') != 'dismissed' ${filter}
           ORDER BY opportunity.updated_at DESC, opportunity.opportunity_id LIMIT ?`,
          input.userId,
          epoch(input.now),
          input.userId,
          ...(ids ?? []),
          input.limit,
        ).toArray();
        const byId = new Map(rows.map((row) => [row.opportunity_id, row]));
        return ids
          ? ids.map((id) => byId.get(id)).filter((row): row is OpportunityRow => Boolean(row))
          : rows;
      };
      const ranked = showable(rankedIds);
      const filler = ranked.length < input.limit ? showable() : [];
      const seen = new Set(ranked.map((row) => row.opportunity_id));
      const items = [...ranked, ...filler.filter((row) => !seen.has(row.opportunity_id))]
        .slice(0, input.limit);
      if (!stored || stored.due_at === null) {
        const hole = ranked.length < rankedIds.length;
        const unranked = ranked.length === 0 && items.length > 0;
        if (hole || unranked) this.markRankingDue(input.userId, epoch(input.scheduleAt), now);
      }
      return {
        items: items.map((row) => ({
          id: row.opportunity_id,
          version: Number(row.version),
          displayPrompt: row.display_prompt,
          icon: row.provider_icon,
          sourceLabel: row.source_label,
        })),
      };
    });
  }

  recordImpressions(input: WorkspaceOpportunityImpressionsRequest, now = Date.now()) {
    const visibleRows = this.storage.transactionSync(() => {
      const rows: OpportunityRow[] = [];
      for (const opportunityId of new Set(input.opportunityIds)) {
        const visible = this.visibleOpportunity(input.userId, opportunityId, epoch(input.now));
        if (!visible || visible.status !== "active") continue;
        rows.push(visible);
        this.storage.sql.exec(
          `INSERT INTO work_opportunity_user_states (
            opportunity_id, user_id, status, impression_count, first_impressed_at,
            last_impressed_at, resolved_at, created_workstream_id, updated_at
          ) VALUES (?, ?, 'impressed', 1, ?, ?, NULL, NULL, ?)
          ON CONFLICT(opportunity_id, user_id) DO UPDATE SET
            impression_count = work_opportunity_user_states.impression_count + 1,
            first_impressed_at = COALESCE(work_opportunity_user_states.first_impressed_at, excluded.first_impressed_at),
            last_impressed_at = excluded.last_impressed_at, updated_at = excluded.updated_at`,
          opportunityId,
          input.userId,
          now,
          now,
          now,
        );
      }
      const set = this.storage.sql.exec<{ last_ranked_at: number | null; created_at: number }>(
        `SELECT last_ranked_at, created_at FROM suggested_work_sets WHERE user_id = ?`,
        input.userId,
      ).toArray()[0];
      if (set && (set.last_ranked_at ?? set.created_at) <= epoch(input.rerankBefore)) {
        this.markRankingDue(input.userId, now, now, true);
      }
      return rows;
    });
    const reads = visibleRows.map((row) => this.opportunityTelemetryContext(row, input.userId));
    return {
      telemetryContexts: reads.flatMap((read) => read.telemetryContext ? [read.telemetryContext] : []),
      telemetryContextReadFailed: reads.some((read) => read.readFailed),
    };
  }

  dismissOpportunity(input: WorkspaceOpportunityDismissRequest, now = Date.now()) {
    const visible = this.visibleOpportunity(input.userId, input.opportunityId, epoch(input.now));
    if (!visible) {
      return { dismissed: false, telemetryContext: null, telemetryContextReadFailed: false };
    }
    const telemetry = this.opportunityTelemetryContext(visible, input.userId);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO work_opportunity_user_states (
          opportunity_id, user_id, status, impression_count, first_impressed_at,
          last_impressed_at, resolved_at, created_workstream_id, updated_at
        ) VALUES (?, ?, 'dismissed', 0, NULL, NULL, ?, NULL, ?)
        ON CONFLICT(opportunity_id, user_id) DO UPDATE SET
          status = 'dismissed', resolved_at = excluded.resolved_at, updated_at = excluded.updated_at`,
        input.opportunityId,
        input.userId,
        now,
        now,
      );
      this.markRankingDue(input.userId, now, now);
    });
    return {
      dismissed: true,
      telemetryContext: telemetry.telemetryContext,
      telemetryContextReadFailed: telemetry.readFailed,
    };
  }

  private visibleOpportunity(userId: string, opportunityId: string, now: number): OpportunityRow | null {
    return this.storage.sql.exec<OpportunityRow>(
      `SELECT opportunity.* FROM work_opportunities opportunity
        LEFT JOIN work_opportunity_user_states state
          ON state.opportunity_id = opportunity.opportunity_id AND state.user_id = ?
       WHERE opportunity.opportunity_id = ? AND opportunity.expires_at > ?
         AND opportunity.status IN ('active', 'starting', 'started')
         AND (opportunity.audience_scope = 'workspace' OR opportunity.audience_user_id = ?)
         AND COALESCE(state.status, '') != 'dismissed' LIMIT 1`,
      userId,
      opportunityId,
      now,
      userId,
    ).toArray()[0] ?? null;
  }

  getOpportunity(input: WorkspaceOpportunityGetRequest) {
    const row = this.visibleOpportunity(input.userId, input.opportunityId, epoch(input.now));
    return row ? this.publicOpportunityRecord(row) : null;
  }

  private opportunityTelemetryContext(
    row: OpportunityRow,
    userId: string,
  ): { telemetryContext: WorkspaceOpportunityTelemetryContext | null; readFailed: boolean } {
    try {
      const state = this.storage.sql.exec<{
        impression_count: number;
        first_impressed_at: number | null;
      }>(
        `SELECT impression_count, first_impressed_at
           FROM work_opportunity_user_states
          WHERE opportunity_id = ? AND user_id = ? LIMIT 1`,
        row.opportunity_id,
        userId,
      ).toArray()[0];
      const connectorTypes = [...new Set(this.boundedProvenance(row.opportunity_id, userId)
        .flatMap((node) => typeof node.provider === "string"
          && TELEMETRY_CONNECTOR_TYPE_SET.has(node.provider)
          ? [node.provider as TelemetryConnectorType]
          : []))].sort();
      return {
        telemetryContext: {
          opportunityId: row.opportunity_id,
          version: Number(row.version),
          audienceScope: row.audience_scope,
          createdAt: new Date(row.created_at).toISOString(),
          impressionCount: Number(state?.impression_count ?? 0),
          firstImpressedAt: state?.first_impressed_at == null
            ? null
            : new Date(state.first_impressed_at).toISOString(),
          connectorTypes,
        },
        readFailed: false,
      };
    } catch {
      // Measurement is optional. A bad enrichment query must not repeat the
      // production failure where an observation prevented the product action.
      return { telemetryContext: null, readFailed: true };
    }
  }

  opportunityActivitySourceIds(input: WorkspaceOpportunityOriginEventsRequest): string[] {
    if (!this.visibleOpportunity(input.userId, input.opportunityId, epoch(input.now))) return [];
    return this.storage.sql.exec<{ source_id: string }>(
      `SELECT node.source_id FROM work_opportunity_provenance_roots root
        JOIN opportunity_provenance_nodes node ON node.node_id = root.node_id
       WHERE root.opportunity_id = ? AND node.node_kind = 'activity'
         AND node.source_id IS NOT NULL
         AND (node.visibility_scope = 'workspace' OR node.visibility_user_id = ?)
       ORDER BY root.position, node.node_id LIMIT ?`,
      input.opportunityId,
      input.userId,
      input.limit,
    ).toArray().map((row) => row.source_id);
  }

  claimOpportunityStart(input: WorkspaceOpportunityClaimStartRequest, now = Date.now()) {
    const claimed = this.storage.transactionSync(() => {
      const row = this.visibleOpportunity(input.userId, input.opportunityId, epoch(input.now));
      if (!row) return { outcome: "not_found" as const, opportunity: null, row: null };
      if (row.version !== input.version) {
        return { outcome: "stale" as const, opportunity: this.publicOpportunityRecord(row), row };
      }
      if (row.start_idempotency_key === input.idempotencyKey) {
        return { outcome: "replay" as const, opportunity: this.publicOpportunityRecord(row), row };
      }
      const changed = this.storage.sql.exec<{ opportunity_id: string }>(
        `UPDATE work_opportunities SET status = 'starting', started_by_user_id = ?,
            start_idempotency_key = ?, updated_at = ?
          WHERE opportunity_id = ? AND version = ? AND status = 'active'
          RETURNING opportunity_id`,
        input.userId,
        input.idempotencyKey,
        now,
        input.opportunityId,
        input.version,
      ).toArray().length;
      const current = this.storage.sql.exec<OpportunityRow>(
        `SELECT * FROM work_opportunities WHERE opportunity_id = ?`,
        input.opportunityId,
      ).one();
      return {
        outcome: changed === 1 ? "claimed" as const : "busy" as const,
        opportunity: this.publicOpportunityRecord(current),
        row: current,
      };
    });
    const telemetry = claimed.row
      ? this.opportunityTelemetryContext(claimed.row, input.userId)
      : { telemetryContext: null, readFailed: false };
    return {
      outcome: claimed.outcome,
      opportunity: claimed.opportunity,
      telemetryContext: telemetry.telemetryContext,
      telemetryContextReadFailed: telemetry.readFailed,
    };
  }

  releaseOpportunityStart(input: WorkspaceOpportunityClaimStartRequest, now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE work_opportunities SET status = 'active', started_by_user_id = NULL,
          start_idempotency_key = NULL, updated_at = ?
        WHERE opportunity_id = ? AND version = ? AND status = 'starting'
          AND start_idempotency_key = ?`,
      now,
      input.opportunityId,
      input.version,
      input.idempotencyKey,
    );
  }

  completeOpportunityStart(input: WorkspaceOpportunityCompleteStartRequest, now = Date.now()): void {
    this.storage.transactionSync(() => {
      const opportunity = this.storage.sql.exec<OpportunityRow>(
        `SELECT * FROM work_opportunities WHERE opportunity_id = ?`,
        input.opportunityId,
      ).one();
      if (opportunity.version !== input.version || opportunity.start_idempotency_key !== input.idempotencyKey) {
        throw new Error("work_opportunity_start_fenced");
      }
      const links = this.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT user_id, role, resolution, reasoning FROM work_opportunity_user_links
          WHERE opportunity_id = ? LIMIT 100`,
        input.opportunityId,
      ).toArray();
      const provenance = this.boundedProvenance(input.opportunityId, input.userId);
      this.storage.sql.exec(
        `UPDATE work_opportunities SET status = 'started', created_workstream_id = ?,
            created_message_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE opportunity_id = ? AND version = ? AND start_idempotency_key = ?`,
        input.workstreamId,
        input.messageId,
        now,
        now,
        input.opportunityId,
        input.version,
        input.idempotencyKey,
      );
      this.storage.sql.exec(
        `INSERT INTO work_opportunity_snapshots (
          snapshot_id, opportunity_id, opportunity_version, selected_by_user_id,
          display_prompt_hash, execution_prompt_hash, identity_links_json,
          provenance_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(opportunity_id, opportunity_version, selected_by_user_id) DO UPDATE SET
          display_prompt_hash = excluded.display_prompt_hash,
          execution_prompt_hash = excluded.execution_prompt_hash,
          identity_links_json = excluded.identity_links_json,
          provenance_json = excluded.provenance_json`,
        input.snapshotId,
        input.opportunityId,
        input.version,
        input.userId,
        opportunity.display_prompt_hash,
        opportunity.execution_prompt_hash,
        JSON.stringify(links),
        JSON.stringify(provenance),
        now,
      );
      this.storage.sql.exec(
        `INSERT INTO work_opportunity_user_states (
          opportunity_id, user_id, status, impression_count, first_impressed_at,
          last_impressed_at, resolved_at, created_workstream_id, updated_at
        ) VALUES (?, ?, 'started', 0, NULL, NULL, ?, ?, ?)
        ON CONFLICT(opportunity_id, user_id) DO UPDATE SET
          status = 'started', resolved_at = excluded.resolved_at,
          created_workstream_id = excluded.created_workstream_id, updated_at = excluded.updated_at`,
        input.opportunityId,
        input.userId,
        now,
        input.workstreamId,
        now,
      );
      this.markRankingDue(input.userId, now, now);
    });
  }

  private publicOpportunityRecord(row: OpportunityRow): Record<string, unknown> {
    return {
      id: row.opportunity_id,
      version: Number(row.version),
      audience_scope: row.audience_scope,
      audience_user_id: row.audience_user_id,
      display_prompt: row.display_prompt,
      execution_prompt: row.execution_prompt,
      admission_reasoning: row.admission_reasoning,
      provider_icon: row.provider_icon,
      source_label: row.source_label,
      display_prompt_hash: row.display_prompt_hash,
      execution_prompt_hash: row.execution_prompt_hash,
      status: row.status,
      created_workstream_id: row.created_workstream_id,
      created_message_id: row.created_message_id,
      started_by_user_id: row.started_by_user_id,
      start_idempotency_key: row.start_idempotency_key,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      started_at: iso(row.started_at),
    };
  }

  nextProductAlarmAt(now: number, futureOnly = false): number | null {
    const row = this.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at FROM (
        SELECT process_after AS due_at
          FROM opportunity_batch_windows WHERE status = 'pending'
        UNION ALL
        SELECT lease_expires_at AS due_at
          FROM opportunity_batch_windows WHERE status = 'processing'
        UNION ALL
        SELECT CASE
          WHEN due_at IS NULL THEN NULL
          WHEN lease_expires_at IS NULL OR lease_expires_at < ? THEN due_at
          ELSE lease_expires_at END AS due_at
          FROM suggested_work_sets
      ) WHERE due_at IS NOT NULL AND (? = 0 OR due_at > ?)`,
      now,
      futureOnly ? 1 : 0,
      now,
    ).one();
    return row.due_at === null ? null : Number(row.due_at);
  }

  reapCompletedOpportunityWindows(cutoff: number, limit = 500): number {
    const doomed = this.storage.sql.exec<{ window_id: string }>(
      `SELECT window_id FROM opportunity_batch_windows
        WHERE status = 'completed' AND completed_at < ?
        ORDER BY completed_at, window_id LIMIT ?`,
      cutoff,
      limit,
    ).toArray();
    if (doomed.length === 0) return 0;
    const placeholders = doomed.map(() => "?").join(",");
    return Number(this.storage.sql.exec(
      `DELETE FROM opportunity_batch_windows WHERE window_id IN (${placeholders})`,
      ...doomed.map((row) => row.window_id),
    ).rowsWritten);
  }
}
