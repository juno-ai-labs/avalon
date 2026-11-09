/**
 * One work stream's resource attachments, in the object's own vocabulary.
 *
 * `workstream_resource_links` is the object's table and `_runtime_resources`
 * was a *projection of it*: the retired view read the frozen `resource_json`
 * this table already carries and answered as though it were the workspace's
 * `resources` row. So the resources slice is narrower than its statement count
 * suggests — almost every statement naming `resources` names only `resources`
 * and routes to WorkspaceDO, which the notes-and-resources slice owns. What is
 * here is the *link*: which resources this work stream has attached, why, and
 * whether it is watching them.
 *
 * `resource_inventory_revision` is a single row that every path changing the
 * authorized inventory advances. It is not bookkeeping: the compaction
 * checkpoint's visibility fingerprint starts `inventory:<revision>` (a
 * Breakout's adds its Channel's after a slash), so a change that failed to bump
 * it would let a stale checkpoint keep matching.
 */

import { boundParameterChunks } from "./bound-parameters";
import type { ResourceRelationshipType } from "@rally/contracts";

/** One attachment, as a reader of the work stream's rail sees it. */
export interface ResourceLinkRow extends Record<string, SqlStorageValue> {
  resource_id: string;
  relationship_type: ResourceRelationshipType;
  attached_at: number;
  watch_enabled: number;
}

/** What a watch toggle found, and what it replaced. */
export type WatchToggleOutcome =
  | { outcome: "not_attached" }
  | { outcome: "set"; previousWatchEnabled: number };

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

export class WorkstreamResourceStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** One canonical observation for reverse-index discovery and attachment authorization. */
  readAuthorizationFacts() {
    return { resourceIds: this.attachedResourceIds(), revision: this.inventoryRevision(), validatedAt: Date.now() };
  }

  /** Every resource this work stream has attached, newest first. */
  attachedLinks(input: { resourceIds?: readonly string[] } = {}): ResourceLinkRow[] {
    const ids = input.resourceIds ? [...new Set(input.resourceIds)] : null;
    if (ids && ids.length === 0) return [];
    // Chunked when the caller names ids, because the engine binds 100
    // parameters per statement and a work stream's attachment list is not
    // bounded by anything smaller. Each chunk is ordered by the same key, so
    // the concatenation is re-sorted rather than assumed.
    if (!ids) {
      return this.sql.exec<ResourceLinkRow>(
        `SELECT resource_id, relationship_type, attached_at, watch_enabled
           FROM workstream_resource_links
          ORDER BY attached_at DESC, resource_id ASC`,
      ).toArray();
    }
    return boundParameterChunks(ids).flatMap((chunk) =>
      this.sql.exec<ResourceLinkRow>(
        `SELECT resource_id, relationship_type, attached_at, watch_enabled
           FROM workstream_resource_links
          WHERE resource_id IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      ).toArray(),
    ).sort((left, right) =>
      right.attached_at - left.attached_at || left.resource_id.localeCompare(right.resource_id));
  }

  /** The ids alone, for a caller that only needs to know what is attached. */
  attachedResourceIds(): string[] {
    return this.sql.exec<{ resource_id: string } & Record<string, SqlStorageValue>>(
      `SELECT resource_id FROM workstream_resource_links ORDER BY resource_id ASC`,
    ).toArray().map((row) => row.resource_id);
  }

  /** Whether one resource is attached here. */
  isAttached(input: { resourceId: string }): boolean {
    return first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM workstream_resource_links WHERE resource_id = ?`,
      input.resourceId,
    )) !== undefined;
  }

  /**
   * Which of a page of resources are carried by a transcript message.
   *
   * The rail marks an attachment differently when a member sent it in a
   * message rather than attaching it to the work stream. The retired reader
   * asked that as a correlated `EXISTS` per row, across `message_attachments`
   * joined to `messages` — two compatibility views over two tables in this same
   * object, which is why it can be one read of the object's own rows.
   *
   * The `substream_id = '0'` predicate is this class's convention rather than a
   * live branch — canonical conversation turns currently project only the main
   * child. It is uncovered by a spec for that reason: a fixture that
   * exercised it would be asserting on a substream nothing creates.
   */
  resourceIdsOnMessages(input: { resourceIds: readonly string[] }): string[] {
    if (input.resourceIds.length === 0) return [];
    return boundParameterChunks(input.resourceIds).flatMap((chunk) =>
      this.sql.exec<{ resource_id: string } & Record<string, SqlStorageValue>>(
        `SELECT DISTINCT attachment.resource_id
           FROM participant_transcript_attachments attachment
           JOIN canonical_conversation_turn_details part ON part.id = attachment.turn_id
          WHERE part.substream_id = '0'
            AND attachment.resource_id IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      ).toArray().map((row) => row.resource_id));
  }

  /**
   * Turn a watch on or off, answering with what was there before.
   *
   * One operation because the caller's next move depends on the answer twice
   * over. The watch row is *regional* and this link is the object's, so no
   * transaction spans them: the routed version read `watch_enabled`, wrote the
   * new one, ran the regional write, and on failure wrote the old value back —
   * three round trips to this authority, with the read and the write far enough
   * apart that a concurrent toggle could be compensated away. Here the read and
   * the write are one, and the compensation is this same operation given the
   * value it just replaced.
   *
   * `not_attached` is an ordinary answer rather than a throw: a member can
   * detach a resource between opening the rail and pressing the toggle, and the
   * caller turns it into the 404 the routed version raised from a missing row.
   */
  setWatchEnabled(input: { resourceId: string; watchEnabled: number }): WatchToggleOutcome {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<{ watch_enabled: number } & Record<string, SqlStorageValue>>(
        `SELECT watch_enabled FROM workstream_resource_links WHERE resource_id = ?`,
        input.resourceId,
      ));
      if (!existing) return { outcome: "not_attached" as const };
      this.sql.exec(
        `UPDATE workstream_resource_links SET watch_enabled = ? WHERE resource_id = ?`,
        input.watchEnabled,
        input.resourceId,
      );
      return { outcome: "set" as const, previousWatchEnabled: existing.watch_enabled };
    });
  }

  /**
   * The inventory revision a compaction checkpoint fences itself on.
   *
   * Zero when the row has never been written, which is what the retired view's
   * `COALESCE(revision.revision, 0)` answered for a work stream that has never
   * attached anything.
   */
  inventoryRevision(): number {
    return Number(first(this.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
      `SELECT revision FROM resource_inventory_revision WHERE id = 1`,
    ))?.revision ?? 0);
  }

  /** Host identity for resource inheritance; never supplied by the model. */
  inheritanceContext(): { kind: "sidekick"; sidekickId: string; substreamId: string } | { kind: "none" } {
    const row = first(this.sql.exec<{
      parent_kind: string; workstream_key: string; substream_id: string;
    }>(
      `SELECT workstream.parent_kind, workstream.workstream_key,
              COALESCE(identity.external_substream_id, '0') AS substream_id
         FROM workstream LEFT JOIN substream_agent_identity AS identity ON identity.id = 1
        WHERE workstream.id = 1`,
    ));
    if (row?.parent_kind === "automation") {
      return { kind: "sidekick", sidekickId: row.workstream_key, substreamId: row.substream_id };
    }
    // A Thread's Breakout inherited its Thread's links; Threads are retired,
    // and a Canvas's conversations inherit nothing.
    return { kind: "none" };
  }
}
