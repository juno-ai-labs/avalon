import type { SqlStorageValue } from "@cloudflare/workers-types";

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
export class WorkstreamIdentityStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
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
  provision(input: {
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
  }): { outcome: "provisioned" | "already_provisioned" } {
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
