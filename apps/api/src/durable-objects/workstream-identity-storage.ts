import type { SqlStorageCursor, SqlStorageValue } from "@cloudflare/workers-types";

/**
 * What a system-provisioned work stream is, on the object that owns it.
 *
 * The product half of a system producer's bootstrap:
 * `bootstrapRuntimeAuthority` opens an empty authoritative object, and this
 * says what the work stream is and who can see it. Four producers create a work
 * stream nobody typed into — an automation, a schedule, an activity, a digest —
 * and each used to write these rows as a routed batch against
 * `_runtime_workstreams` and `_runtime_workstream_participants`.
 *
 * A class rather than two statements inside the product service because the
 * Node suite's agent double has to perform the same write. A double that models
 * it instead is a second implementation of the thing under test, and the one
 * that drifts is always the model.
 */
export interface IdentityRow extends Record<string, SqlStorageValue> {
  workstream_key: string;
  parent_workspace_key: string;
  title: string;
  description: string;
  description_source: string;
  title_status: string;
  scope: string;
  exact_state: string;
  state_reason_code: string;
  origin_type: string;
  system_kind: string | null;
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  created_from_opportunity_id: string | null;
  planned_for: number | null;
  email_address: string | null;
  email_route_status: string;
  model_override: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow extends Record<string, SqlStorageValue> {
  user_id: string;
  participation_reason: string;
  added_by_user_id: string | null;
  added_at: number;
  removed_at: number | null;
}

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

/** What a system producer says a work stream is, at the moment it creates one. */
export interface WorkstreamProvisionInput {
  title: string;
  objective: string;
  scope: string;
  originType: string;
  createdByUserId: string;
  participantUserIds: readonly string[];
  harnessStatus: string;
  emailAddress: string | null;
  emailRouteStatus: string | null;
  systemKind: string | null;
  automationSubscriptionId: string | null;
  automationRunId: string | null;
  plannedFor: number | null;
  modelOverride: string | null;
  now: number;
}

export class WorkstreamIdentityStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * What this work stream is.
   *
   * One operation for eighteen routed reads. Every one of them was
   * `SELECT <a few columns> FROM workstreams WHERE id = ? AND workspace_id = ?`
   * against a single-row view over a single-row table, and they differed only
   * in which columns they named — the archive gate wanted `archived_at`, the
   * naming service wanted the title and its status, the model flags wanted
   * `model_override`. The row is small and the object is already open by the
   * time any of them asks, so narrowing the projection bought nothing and cost
   * a per-caller statement to keep correct. A caller takes what it needs.
   *
   * The object's own column names and units, not the retired view's: `title`
   * and `description` rather than `title`/`objective`, `exact_state` rather
   * than the `harness_status` bucket, unix milliseconds rather than ISO-8601.
   * Callers that need the published shape cross at their own boundary, which
   * is where the two vocabularies already meet everywhere else.
   */
  identity(): IdentityRow | undefined {
    return first(this.sql.exec<IdentityRow>(
      `SELECT workstream_key, parent_workspace_key, title, description, description_source,
              title_status, scope, exact_state, state_reason_code, origin_type, system_kind,
              created_by_user_id, automation_subscription_id, automation_run_id,
              created_from_opportunity_id, planned_for, email_address, email_route_status,
              model_override, archived_at, created_at, updated_at
         FROM workstream WHERE id = 1`,
    ));
  }

  /**
   * Who is on this work stream.
   *
   * Active members only, because every routed reader asked for
   * `removed_at IS NULL` — a removed participant is a row kept for history
   * rather than an audience. Ordered by `added_at` then `user_id`: two readers
   * pick "the first participant" out of this list, and two members added in the
   * same millisecond would otherwise lead it differently on each read.
   */
  participants(): ParticipantRow[] {
    return this.sql.exec<ParticipantRow>(
      `SELECT user_id, participation_reason, added_by_user_id, added_at, removed_at
         FROM participants
        WHERE removed_at IS NULL
        ORDER BY added_at, user_id`,
    ).toArray();
  }

  /**
   * Write the provisioned work stream's product state and its members.
   *
   * Idempotent on replay. A producer that died between the runtime bootstrap
   * and this call retries the pair, and by then the row is already
   * authoritative; re-running the write would reset counters a first run may
   * have advanced, so a root that has left `runtime_bootstrap` answers
   * `already_provisioned` without touching anything.
   */
  provision(input: WorkstreamProvisionInput): { outcome: "provisioned" | "already_provisioned" } {
    return this.storage.transactionSync(() => {
      const root = this.sql.exec<{
        authority_mode: string; state_reason_code: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT authority_mode, state_reason_code FROM workstream WHERE id = 1`,
      ).toArray()[0];
      if (!root) throw new Error("workstream_provision_missing_root");
      if (root.authority_mode !== "authoritative") {
        throw new Error("workstream_provision_not_bootstrapped");
      }
      // Anything past the bootstrap's own reason code has been written by a
      // run, so this is a replay rather than a first provision.
      if (root.state_reason_code !== "runtime_bootstrap") {
        return { outcome: "already_provisioned" as const };
      }
      const scheduled = input.harnessStatus === "scheduled";
      this.sql.exec(
        `UPDATE workstream
            SET title = ?, description = ?, scope = ?, origin_type = ?,
                created_by_user_id = ?, system_kind = ?,
                -- Preserved when the producer has no route to write. The
                -- digest and activity batches never named these columns, so
                -- they kept the table's defaults, and email_route_status is
                -- NOT NULL: writing the absent value would fail the insert
                -- rather than leave the column alone.
                email_address = COALESCE(?, email_address),
                email_route_status = COALESCE(?, email_route_status),
                automation_subscription_id = ?,
                automation_run_id = ?, planned_for = ?, model_override = ?,
                exact_state = ?, state_reason_code = ?, title_status = 'settled',
                description_source = 'derived', listing_epoch = listing_epoch + 1,
                created_at = ?, last_people_activity_at = ?, state_changed_at = ?,
                updated_at = ?
          WHERE id = 1`,
        input.title,
        input.objective,
        input.scope,
        input.originType,
        input.createdByUserId,
        input.systemKind,
        input.emailAddress,
        input.emailRouteStatus,
        input.automationSubscriptionId,
        input.automationRunId,
        input.plannedFor,
        input.modelOverride,
        scheduled ? "scheduled" : "idle",
        scheduled ? "run_scheduled" : "provisioned",
        input.now,
        input.now,
        input.now,
        input.now,
      );
      for (const userId of input.participantUserIds) {
        // `OR IGNORE`, as the routed batches had it: a producer retrying after
        // a partial failure must not fail on a participant it already added,
        // and the row carries no state a second write would correct.
        this.sql.exec(
          `INSERT OR IGNORE INTO participants
             (user_id, participation_reason, added_by_user_id, status, participant_epoch,
              added_at, removed_at, first_opened_at, updated_at)
           VALUES (?, ?, ?, 'active', 0, ?, NULL, NULL, ?)`,
          userId,
          userId === input.createdByUserId ? "creator" : "explicit",
          input.createdByUserId,
          input.now,
          input.now,
        );
      }
      return { outcome: "provisioned" as const };
    });
  }
}
