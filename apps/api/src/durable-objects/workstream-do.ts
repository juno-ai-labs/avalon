import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  WorkstreamRegionalEffectAckSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectSchema,
  workstreamRegionalEffectHash,
  workstreamRegionalEffectWakeMessage,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";

const ForwardedEffectsSchema = z.object({
  substreamId: z.string().min(1).max(180),
  envelopes: z.array(WorkstreamRegionalEffectEnvelopeSchema).min(1).max(25),
}).strict();

interface ProjectionKeyRow extends Record<string, SqlStorageValue> {
  next_version: number;
  last_payload_hash: string;
}

interface StoredEnvelopeRow extends Record<string, SqlStorageValue> {
  payload_json: string;
  payload_hash: string;
  attempts: number;
}

interface StoredProjectionRow extends Record<string, SqlStorageValue> {
  effect_json: string;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export const WORKSTREAM_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workstream parent metadata, child projections, and regional outbox",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      preview TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL,
      system_kind TEXT,
      last_activity_at TEXT NOT NULL,
      completed_at TEXT,
      archived_at TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_directory (
      substream_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_user_directory (
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX substream_user_directory_user_idx
      ON substream_user_directory(user_id, substream_id)`,
    `CREATE TABLE child_effect_receipts (
      substream_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, message_id)
    ) STRICT`,
    `CREATE TABLE projection_keys (
      projection_key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL CHECK (next_version > 0),
      last_payload_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE durable_outbox (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}];

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function canonicalState(effects: WorkstreamRegionalEffect[]): string {
  const states = new Set(effects.flatMap((effect) => effect.kind === "directory_common" ? [effect.state] : []));
  for (const state of [
    "running", "interrupting", "preparing_context", "waiting_capacity", "scheduled",
    "needs_input", "failed", "budget_exhausted", "idle", "completed", "cancelled",
  ]) {
    if (states.has(state)) return state;
  }
  return "idle";
}

function newestCommon(effects: WorkstreamRegionalEffect[]): Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> {
  const common = effects.filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> => (
    effect.kind === "directory_common"
  ));
  if (common.length === 0) throw new Error("workstream_common_projection_missing");
  return [...common].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0]!;
}

export { workstreamDOName } from "./names";

/**
 * WorkstreamDO is the non-agent parent/control object.
 *
 * It owns no transcript and runs no model loop. SubstreamAgent children send
 * versioned projection RPCs here. This object aggregates those projections and
 * is the sole object allowed to wake the regional D1/sidebar/notification
 * bridge, which prevents one work stream with many substreams from exposing
 * conflicting sidebar versions.
 */
export class WorkstreamDO extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.initialized = state.blockConcurrencyWhile(async () => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
        component: "workstream_do",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
      const next = first(state.storage.sql.exec<{ due_at: number | null }>(
        `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
      ))?.due_at ?? null;
      if (next !== null) await state.storage.setAlarm(next);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/substream-effects") {
      return this.acceptSubstreamEffects(request);
    }
    if (request.method === "POST" && path === "/internal/regional-effect-delivery") {
      const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_regional_effect_request" }, 400);
      const envelope = this.regionalEffect(parsed.data.messageId, parsed.data.payloadHash);
      return envelope ? json(envelope) : json({ error: "regional_effect_not_found" }, 404);
    }
    if (request.method === "POST" && path === "/internal/regional-effect-ack") {
      const parsed = WorkstreamRegionalEffectAckSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_regional_effect_ack" }, 400);
      return json({ ok: true, removed: this.ack(parsed.data.messageId, parsed.data.payloadHash) });
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "workstream-control",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const due = this.dueEffects();
    if (due.length === 0) return;
    try {
      await this.env.ACTIVITY_QUEUE.sendBatch(due.map((effect) => ({
        body: workstreamRegionalEffectWakeMessage(effect),
      })));
      const now = Date.now();
      this.state.storage.transactionSync(() => {
        for (const effect of due) {
          const row = first(this.state.storage.sql.exec<{ attempts: number }>(
            `SELECT attempts FROM durable_outbox WHERE message_id = ? AND payload_hash = ?`,
            effect.messageId,
            effect.payloadHash,
          ));
          if (!row) continue;
          const attempts = row.attempts + 1;
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
          this.state.storage.sql.exec(
            `UPDATE durable_outbox SET state = 'inflight', attempts = ?, not_before = ?
              WHERE message_id = ? AND payload_hash = ?`,
            attempts,
            now + delay,
            effect.messageId,
            effect.payloadHash,
          );
        }
      });
    } catch {
      this.state.storage.sql.exec(
        `UPDATE durable_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?
          WHERE state IN ('pending', 'inflight') AND not_before <= ?`,
        Date.now() + RETRY_BASE_MS,
        Date.now(),
      );
    }
    await this.armAlarm();
  }

  private async acceptSubstreamEffects(request: Request): Promise<Response> {
    const parsed = ForwardedEffectsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_substream_effects" }, 400);
    try {
      let accepted = 0;
      for (const envelope of parsed.data.envelopes) {
        if (envelope.region !== this.env.AVALON_REGION) throw new Error("workstream_effect_region_mismatch");
        this.applyChildEnvelope(parsed.data.substreamId, envelope);
        accepted += 1;
      }
      await this.armAlarm();
      return json({ ok: true, accepted });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "substream_effect_failed" }, 409);
    }
  }

  private applyChildEnvelope(substreamId: string, envelope: WorkstreamRegionalEffectEnvelope): void {
    this.state.storage.transactionSync(() => {
      const metadata = first(this.state.storage.sql.exec<{
        workspace_id: string;
        workstream_id: string;
        authority_generation: number;
      }>(`SELECT workspace_id, workstream_id, authority_generation FROM workstream_metadata WHERE id = 1`));
      if (metadata && (
        metadata.workspace_id !== envelope.workspaceId
        || metadata.workstream_id !== envelope.workstreamId
        || metadata.authority_generation !== envelope.generation
      )) throw new Error("workstream_effect_identity_mismatch");

      const receipt = first(this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM child_effect_receipts WHERE substream_id = ? AND message_id = ?`,
        substreamId,
        envelope.messageId,
      ));
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return;
      }

      const now = Date.now();
      if (envelope.effect.kind === "directory_common") {
        this.upsertChildProjection("common", substreamId, null, envelope, now);
        const effect = this.aggregateCommon();
        this.upsertMetadata(envelope, effect, now);
        this.enqueueProjection(envelope, "common", effect, now);
      } else if (envelope.effect.kind === "directory_user") {
        this.upsertChildProjection("user", substreamId, envelope.effect.userId, envelope, now);
        const effect = this.aggregateUser(envelope.effect.userId);
        this.enqueueProjection(envelope, `user:${envelope.effect.userId}`, effect, now);
      } else {
        this.ensureMetadata(envelope, now);
        this.enqueueImmutable(substreamId, envelope, now);
      }
      this.state.storage.sql.exec(
        `INSERT INTO child_effect_receipts(substream_id, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        substreamId,
        envelope.messageId,
        envelope.payloadHash,
        now,
      );
    });
  }

  private upsertChildProjection(
    kind: "common" | "user",
    substreamId: string,
    userId: string | null,
    envelope: WorkstreamRegionalEffectEnvelope,
    now: number,
  ): void {
    const table = kind === "common" ? "substream_directory" : "substream_user_directory";
    const where = kind === "common" ? "substream_id = ?" : "substream_id = ? AND user_id = ?";
    const params = kind === "common" ? [substreamId] : [substreamId, userId!];
    const existing = first(this.state.storage.sql.exec<{ source_version: number; payload_hash: string }>(
      `SELECT source_version, payload_hash FROM ${table} WHERE ${where}`,
      ...params,
    ));
    if (existing && existing.source_version > envelope.sourceVersion) return;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash !== envelope.payloadHash) throw new Error("substream_projection_version_conflict");
      return;
    }
    if (kind === "common") {
      this.state.storage.sql.exec(
        `INSERT INTO substream_directory(substream_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(substream_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    } else {
      this.state.storage.sql.exec(
        `INSERT INTO substream_user_directory
           (substream_id, user_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(substream_id, user_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        userId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    }
  }

  private aggregateCommon(): Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> {
    const effects = this.state.storage.sql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_directory ORDER BY substream_id`,
    ).toArray().map((row) => WorkstreamRegionalEffectSchema.parse(JSON.parse(row.effect_json)));
    const base = newestCommon(effects);
    const common = effects.filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_common" }> => (
      effect.kind === "directory_common"
    ));
    const lastActivityAt = common.reduce(
      (latest, effect) => effect.lastActivityAt > latest ? effect.lastActivityAt : latest,
      base.lastActivityAt,
    );
    return {
      ...base,
      state: canonicalState(effects),
      lastActivityAt,
      completedAt: common.every((effect) => effect.completedAt !== null) ? lastActivityAt : null,
    };
  }

  private aggregateUser(userId: string): Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> {
    const effects = this.state.storage.sql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`,
      userId,
    ).toArray().map((row) => WorkstreamRegionalEffectSchema.parse(JSON.parse(row.effect_json)))
      .filter((effect): effect is Extract<WorkstreamRegionalEffect, { kind: "directory_user" }> => (
        effect.kind === "directory_user"
      ));
    if (effects.length === 0) throw new Error("workstream_user_projection_missing");
    return {
      kind: "directory_user",
      userId,
      isParticipant: effects.some((effect) => effect.isParticipant),
      unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
      youAreMentioned: effects.some((effect) => effect.youAreMentioned),
      listable: effects.some((effect) => effect.listable),
      seenAttentionOrdinal: Math.max(...effects.map((effect) => effect.seenAttentionOrdinal ?? 0)),
      manualUnreadFromOrdinal: effects.reduce<number | null>((earliest, effect) => {
        const value = effect.manualUnreadFromOrdinal ?? null;
        return value === null ? earliest : earliest === null ? value : Math.min(earliest, value);
      }, null),
      manualUnreadGeneration: Math.max(...effects.map((effect) => effect.manualUnreadGeneration ?? 0)),
      latestMentionAttentionOrdinal: Math.max(...effects.map((effect) => effect.latestMentionAttentionOrdinal ?? 0)),
    };
  }

  private ensureMetadata(envelope: WorkstreamRegionalEffectEnvelope, now: number): void {
    const existing = first(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workstream_metadata WHERE id = 1`,
    ));
    if (existing) return;
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, '', '', '', 'workspace', 'idle', NULL, ?, NULL, NULL, ?, ?)`,
      envelope.workspaceId,
      envelope.workstreamId,
      envelope.region,
      envelope.generation,
      new Date(now).toISOString(),
      now,
      now,
    );
  }

  private upsertMetadata(
    envelope: WorkstreamRegionalEffectEnvelope,
    effect: Extract<WorkstreamRegionalEffect, { kind: "directory_common" }>,
    now: number,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         preview = excluded.preview, scope = excluded.scope, exact_state = excluded.exact_state,
         system_kind = excluded.system_kind, last_activity_at = excluded.last_activity_at,
         completed_at = excluded.completed_at, archived_at = excluded.archived_at,
         updated_at = excluded.updated_at`,
      envelope.workspaceId,
      envelope.workstreamId,
      envelope.region,
      envelope.generation,
      effect.title,
      effect.description,
      effect.preview,
      effect.scope,
      effect.state,
      effect.systemKind,
      effect.lastActivityAt,
      effect.completedAt,
      effect.archivedAt,
      now,
      now,
    );
  }

  private enqueueProjection(
    source: WorkstreamRegionalEffectEnvelope,
    projectionKey: string,
    effect: WorkstreamRegionalEffect,
    now: number,
  ): void {
    const payloadHash = workstreamRegionalEffectHash(effect);
    const previous = first(this.state.storage.sql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
      projectionKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return;
    const sourceVersion = previous?.next_version ?? 1;
    const messageId = crypto.randomUUID();
    this.state.storage.sql.exec(
      `DELETE FROM durable_outbox WHERE partition_key = ? AND state IN ('pending', 'inflight')`,
      projectionKey,
    );
    this.state.storage.sql.exec(
      `INSERT INTO projection_keys(projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      projectionKey,
      sourceVersion + 1,
      payloadHash,
      now,
    );
    this.insertOutbox({
      ...source,
      messageId,
      partitionKey: projectionKey,
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash,
      effect,
    }, now);
  }

  private enqueueImmutable(substreamId: string, source: WorkstreamRegionalEffectEnvelope, now: number): void {
    let requiredProjectionVersion: number | null = null;
    if (source.effect.kind === "mention_notification") {
      const key = `user:${source.effect.recipientUserId}`;
      const projection = first(this.state.storage.sql.exec<ProjectionKeyRow>(
        `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
        key,
      ));
      requiredProjectionVersion = (projection?.next_version ?? 1) - 1;
      if (requiredProjectionVersion <= 0) throw new Error("workstream_notification_projection_dependency_uncommitted");
    }
    const messageId = `substream:${substreamId}:${source.messageId}`;
    const payloadHash = workstreamRegionalEffectHash(source.effect, requiredProjectionVersion);
    this.insertOutbox({
      ...source,
      messageId,
      requiredProjectionVersion,
      payloadHash,
    }, now);
  }

  private insertOutbox(envelope: WorkstreamRegionalEffectEnvelope, now: number): void {
    const inserted = this.state.storage.sql.exec<{ message_id: string }>(
      `INSERT OR IGNORE INTO durable_outbox
         (message_id, partition_key, source_version, source_epoch, payload_json, payload_hash,
          state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       RETURNING message_id`,
      envelope.messageId,
      envelope.partitionKey,
      envelope.sourceVersion,
      envelope.generation,
      JSON.stringify(WorkstreamRegionalEffectEnvelopeSchema.parse(envelope)),
      envelope.payloadHash,
      now,
      now,
    );
    if (inserted.toArray().length === 0) {
      const existing = first(this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM durable_outbox WHERE message_id = ?`,
        envelope.messageId,
      ));
      if (existing?.payload_hash !== envelope.payloadHash) throw new Error("workstream_parent_outbox_conflict");
    }
  }

  private dueEffects(limit = 25): WorkstreamRegionalEffectEnvelope[] {
    return this.state.storage.sql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE state IN ('pending', 'inflight') AND not_before <= ?
        ORDER BY created_at, message_id LIMIT ?`,
      Date.now(),
      limit,
    ).toArray().map((row) => WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  }

  private regionalEffect(messageId: string, payloadHash: string): WorkstreamRegionalEffectEnvelope | null {
    const row = first(this.state.storage.sql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE message_id = ? AND payload_hash = ? AND state IN ('pending', 'inflight')`,
      messageId,
      payloadHash,
    ));
    return row ? WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  private ack(messageId: string, payloadHash: string): boolean {
    return this.state.storage.sql.exec<{ message_id: string }>(
      `DELETE FROM durable_outbox WHERE message_id = ? AND payload_hash = ?
       RETURNING message_id`,
      messageId,
      payloadHash,
    ).toArray().length === 1;
  }

  private async armAlarm(): Promise<void> {
    const next = first(this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
    ))?.due_at ?? null;
    if (next === null) return;
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > next) await this.state.storage.setAlarm(next);
  }
}
