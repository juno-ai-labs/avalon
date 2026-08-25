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
   * Take a work stream out of every listing, if it is the system stream this
   * producer thinks it is.
   *
   * The digest's tombstone. A Durable Object identity cannot be deleted
   * transactionally with the parent delivery claim it was created for, so a
   * digest run that fails between the two leaves an object nobody will ever
   * open; archiving it is what keeps it unlistable, and is safer than a
   * cross-object purge that could race a late Workflow creation.
   *
   * `system_kind` is the fence rather than a caller's promise, because this
   * runs on a failure path where the only thing known for certain is the id.
   */
  archiveSystemWorkstream(input: { systemKind: string; now: number }): {
    outcome: "archived" | "not_applicable";
  } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root || root.system_kind !== input.systemKind) {
        return { outcome: "not_applicable" as const };
      }
      this.sql.exec(
        `UPDATE workstream SET archived_at = ?1, updated_at = ?1 WHERE id = 1`,
        input.now,
      );
      return { outcome: "archived" as const };
    });
  }

  /**
   * Take a work stream out of every listing, if its run never started.
   *
   * Deleting an automation archives the work streams its future runs were
   * already holding. A run that has begun is left alone: it is doing work
   * somebody asked for, and the transcript it produces still belongs to them.
   */
  archiveScheduledWorkstream(input: { now: number }): {
    outcome: "archived" | "not_applicable";
  } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root || root.exact_state !== "scheduled" || root.archived_at !== null) {
        return { outcome: "not_applicable" as const };
      }
      this.sql.exec(
        `UPDATE workstream SET archived_at = ?1, updated_at = ?1 WHERE id = 1`,
        input.now,
      );
      return { outcome: "archived" as const };
    });
  }

  /**
   * Take the address the Global registry just reserved, if none is held.
   *
   * `WHERE email_address IS NULL` was the routed statement's guard against two
   * reservations racing for one work stream; here the read and the write are
   * one transaction, so the guard is the read. The caller compares what came
   * back against what it reserved either way — an address it did not reserve is
   * a conflict, not a success.
   */
  adoptEmailAddress(input: { emailAddress: string; now: number }): {
    outcome: "adopted" | "already_addressed";
  } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root || root.email_address !== null) {
        return { outcome: "already_addressed" as const };
      }
      this.sql.exec(
        `UPDATE workstream
            SET email_address = ?, email_route_status = 'reserved', updated_at = ?
          WHERE id = 1`,
        input.emailAddress,
        input.now,
      );
      return { outcome: "adopted" as const };
    });
  }

  /**
   * Note which automation run this work stream is carrying, and that it began.
   *
   * The schedule executor's write, after the run it just launched. `running`
   * is stamped the way the retired `_runtime_workstreams` update trigger did
   * it — only on a move, leaving `state_reason_code` and `state_changed_at`
   * alone when the work stream is already there.
   */
  bindAutomationRun(input: { automationRunId: string; now: number }): void {
    this.sql.exec(
      `UPDATE workstream
          SET automation_run_id = ?1,
              state_reason_code = CASE WHEN exact_state = 'running'
                THEN state_reason_code ELSE 'runtime_running' END,
              state_changed_at = CASE WHEN exact_state = 'running'
                THEN state_changed_at ELSE ?2 END,
              exact_state = 'running',
              updated_at = ?2
        WHERE id = 1`,
      input.automationRunId,
      input.now,
    );
  }

  /**
   * Give the work stream the name a pass settled on, if that pass still holds.
   *
   * `from` is the naming pass's own fence: two passes can be in flight — the
   * first runs on the opening message and the second when a run ends — and the
   * later one must not overwrite a title the earlier one already settled. A
   * `null` title advances the status without touching the name, which is how a
   * pass records that the model was unreachable.
   */
  rename(input: {
    title: string | null;
    from: string;
    to: string;
    now: number;
  }): { outcome: "renamed" | "superseded" } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root || root.title_status !== input.from) {
        return { outcome: "superseded" as const };
      }
      this.sql.exec(
        `UPDATE workstream
            SET title = COALESCE(?, title), title_status = ?, updated_at = ?
          WHERE id = 1`,
        input.title,
        input.to,
        input.now,
      );
      return { outcome: "renamed" as const };
    });
  }

  /**
   * Replace the description an evaluation read, if nobody else has.
   *
   * `expectedDescription` is the compare-and-swap the routed statement wrote as
   * `WHERE objective = ?`: a person who retitled the work stream while the
   * model was thinking wins, because theirs is the more recent statement of
   * intent and silently overwriting it is the one outcome that would make the
   * description loop untrustworthy.
   */
  redescribe(input: {
    description: string;
    expectedDescription: string;
    now: number;
  }): { outcome: "applied" | "superseded"; description: string } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root) return { outcome: "superseded" as const, description: "" };
      if (root.description !== input.expectedDescription) {
        // What is in force after a refusal is whatever the other writer put
        // there, not the text this evaluation read. The caller records the
        // outcome, and it needs the value rather than a second read of a row
        // that could move again between the two.
        return { outcome: "superseded" as const, description: root.description };
      }
      this.sql.exec(
        `UPDATE workstream
            SET description = ?, description_source = 'derived', updated_at = ?
          WHERE id = 1`,
        input.description,
        input.now,
      );
      return { outcome: "applied" as const, description: input.description };
    });
  }

  /**
   * Seat somebody on this work stream.
   *
   * Re-admission is the case worth naming: a participant who was removed comes
   * back with the reason, the adder and the moment of *this* admission, and one
   * who is already active keeps all three. The routed upsert expressed that as
   * three `CASE WHEN … removed_at IS NOT NULL` arms on one `DO UPDATE`, which
   * is a conditional write standing in for a branch it could not take.
   */
  admitParticipant(input: {
    userId: string;
    addedByUserId: string;
    reason: string;
    now: number;
  }): { outcome: "admitted" | "readmitted" | "unchanged" } {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<ParticipantRow & { status: string }>(
        `SELECT user_id, participation_reason, added_by_user_id, status, added_at, removed_at
           FROM participants WHERE user_id = ?`,
        input.userId,
      ));
      if (existing && existing.removed_at === null) return { outcome: "unchanged" as const };
      if (existing) {
        this.sql.exec(
          `UPDATE participants
              SET status = 'active', removed_at = NULL, participation_reason = ?,
                  added_by_user_id = ?, added_at = ?, updated_at = ?
            WHERE user_id = ?`,
          input.reason,
          input.addedByUserId,
          input.now,
          input.now,
          input.userId,
        );
        return { outcome: "readmitted" as const };
      }
      this.sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, NULL, NULL, ?)`,
        input.userId,
        input.reason,
        input.addedByUserId,
        input.now,
        input.now,
      );
      return { outcome: "admitted" as const };
    });
  }

  /**
   * Seat somebody, and make them the creator if the seat is open.
   *
   * A work stream started from a connector conversation has no Avalon creator
   * until somebody in that conversation is identified. The seat is open when
   * nobody holds it, or when the holder is the guess this caller is now
   * correcting — a verified account link beats an inference from an email
   * address, and only then.
   *
   * The demotion of the previous holder is the fourth statement of the routed
   * batch, and the reason it was a batch: the promotion and the demotion are
   * one fact about who this work stream belongs to, and a work stream with two
   * creators or none is what a partial application leaves behind.
   */
  adoptCreator(input: {
    userId: string;
    previousAssignedUserId: string | null;
    mayCorrectVerifiedCreator: boolean;
    now: number;
  }): { outcome: "adopted" | "seated" } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root) throw new Error("workstream_identity_target_missing");
      const previousCreator = root.created_by_user_id;
      const makeCreator = previousCreator === null || (
        input.mayCorrectVerifiedCreator
        && input.previousAssignedUserId !== null
        && previousCreator === input.previousAssignedUserId
      );
      this.admitParticipant({
        userId: input.userId,
        addedByUserId: input.userId,
        reason: "explicit",
        now: input.now,
      });
      if (!makeCreator) return { outcome: "seated" as const };
      this.sql.exec(
        `UPDATE workstream SET created_by_user_id = ?, updated_at = ? WHERE id = 1`,
        input.userId,
        input.now,
      );
      this.sql.exec(
        `UPDATE participants SET participation_reason = 'creator', updated_at = ?
          WHERE user_id = ?`,
        input.now,
        input.userId,
      );
      if (previousCreator !== null && previousCreator !== input.userId) {
        this.sql.exec(
          `UPDATE participants SET participation_reason = 'explicit', updated_at = ?
            WHERE user_id = ? AND participation_reason = 'creator'`,
          input.now,
          previousCreator,
        );
      }
      return { outcome: "adopted" as const };
    });
  }

  /**
   * Overwrite a development fixture's work stream with the state it seeds.
   *
   * The `/dev` seed route only, which imports a captured workspace into a local
   * object. It is the one caller that sets a sequence number from outside,
   * because it is restoring a transcript it is about to insert rather than
   * appending to one.
   */
  seedFromFixture(input: {
    title: string;
    exactState: string;
    nextSequenceNumber: number;
    now: number;
  }): void {
    this.sql.exec(
      `UPDATE workstream
          SET title = ?, exact_state = ?, next_sequence_number = ?,
              last_people_activity_at = ?, updated_at = ?
        WHERE id = 1`,
      input.title,
      input.exactState,
      input.nextSequenceNumber,
      input.now,
      input.now,
    );
  }

  /**
   * Write the provisioned work stream's product state and its members.
   *
   * Idempotent on replay. A producer that died between the runtime bootstrap
   * and this call retries the pair, and by then the row is already
   * authoritative; re-running the write would reset counters a first run may
   * have advanced, so a root that has left `runtime_bootstrap` answers
   * `already_provisioned` without touching anything.
   *
   * The two throws are the other half of that pairing, and they are the reason
   * this reads the root before it writes rather than trusting its caller.
   * Every producer calls `bootstrapRuntimeAuthority` first, so a missing row
   * means the bootstrap never ran and `preparing` means it ran and did not
   * take — its update is fenced on `authority_mode = 'preparing'`. Both are
   * sequencing failures rather than states to handle, and provisioning over
   * either would write product state into an object that is not yet the
   * authority for it.
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
