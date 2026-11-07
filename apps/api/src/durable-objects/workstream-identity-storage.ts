import type { SqlStorageCursor, SqlStorageValue } from "@cloudflare/workers-types";
import {
  type SpaceColorKey,
  WorkstreamAppearanceSchema,
  WorkstreamIconKeySchema,
  type WorkstreamIconKey,
} from "@rally/contracts";
import { startReadCursorAtLatest } from "./member-attention";

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
  parent_kind: string;
  system_kind: string | null;
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  created_from_opportunity_id: string | null;
  planned_for: number | null;
  email_address: string | null;
  email_route_status: string;
  model_override: string | null;
  /** The agent profile this conversation's runs use; null for an ordinary conversation. */
  agent_profile: string | null;
  appearance_json: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What a seating did: a first admission, a return, or nothing at all. */
export type ParticipantAdmission = "admitted" | "readmitted" | "unchanged";

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
  createdByUserId: string | null;
  participantUserIds: readonly string[];
  harnessStatus: string;
  titleStatus?: "naming" | "automatic" | "settled";
  emailAddress: string | null;
  emailRouteStatus: string | null;
  systemKind: string | null;
  modelOverride: string | null;
  /**
   * The agent profile every run of this conversation uses: its system prompt,
   * model role and exact tool surface. Fixed at provision, like the model pin;
   * omitted for an ordinary conversation.
   */
  agentProfile?: string | null;
  /**
   * A conversation's birth colour. No producer still sends one: it was a
   * Thread's Channel colour.
   */
  color?: SpaceColorKey | null;
  now: number;
}

export class WorkstreamIdentityStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Canonical membership and scope in one synchronous observation, without admission side effects. */
  readAuthorizationFacts(input: { userId: string }) {
    const identity = this.identity();
    const participant = this.participants().find((row) => row.user_id === input.userId);
    return {
      exists: Boolean(identity),
      archived: identity?.archived_at != null,
      scope: identity?.scope === 'workspace' ? 'workspace' as const : 'personal' as const,
      participant: Boolean(participant && participant.removed_at === null),
      validatedAt: Date.now(),
      revision: JSON.stringify([identity?.updated_at ?? null, identity?.archived_at ?? null, participant?.added_at ?? null, participant?.removed_at ?? null]),
    };
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
              title_status, scope, exact_state, state_reason_code, origin_type, parent_kind, system_kind,
              created_by_user_id, automation_subscription_id, automation_run_id,
              created_from_opportunity_id, planned_for, email_address, email_route_status,
              model_override, agent_profile, appearance_json, archived_at, created_at, updated_at
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
   * Give the work stream the name and icon a pass settled on, if that pass
   * still holds.
   *
   * `from` is the naming pass's own fence: two passes can be in flight — the
   * first runs on the opening message and the second when a run ends — and the
   * later one must not overwrite a title the earlier one already settled. A
   * `null` title advances the status without touching the name, which is how a
   * pass records that the model was unreachable.
   *
   * The icon is written under a second condition, and a stricter one: **only
   * where no icon is stored at all.** The fence above cannot protect it,
   * because a person who picks an icon from the header changes no title and so
   * settles nothing — the row a second pass is still eligible to rename is
   * exactly the row whose icon they may have just chosen. Refusing to write
   * over a stored icon is what makes the two safe together, and its cost is
   * that a second pass improves the name without improving the icon the first
   * pass chose from less. That is the trade recorded in
   * `docs/workstream-naming.md`; telling a generated icon from a chosen one
   * would take provenance this column does not carry.
   *
   * `settled` on both sides with no title offers the icon alone; see
   * `docs/workstream-naming.md#prepared-history`.
   *
   * The written icon comes back so the caller can publish exactly what landed,
   * rather than re-deriving it from a row that could move again.
   */
  rename(input: {
    title: string | null;
    /** Absent and `null` mean the same thing: this pass chose no icon. */
    icon?: WorkstreamIconKey | null;
    from: string;
    to: string;
    now: number;
  }): { outcome: "renamed" | "superseded"; icon: WorkstreamIconKey | null } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root || root.title_status !== input.from) {
        return { outcome: "superseded" as const, icon: null };
      }
      // Nothing about the icon may throw between here and the `UPDATE`. The
      // title write and the `title_status` advance are in this transaction, and
      // a throw rolls both back — leaving the row in `naming` with a skeleton on
      // screen that only the second pass can clear, and only once the work
      // stream has five said messages. The icon is the soft half; it degrades to
      // "no icon" the way the model's own answer does at
      // `WorkstreamNameResultSchema`, and for the same reason.
      //
      // Both parses are reachable rather than theoretical. The args cross a
      // Durable Object RPC boundary as JSON, and during a rollout a Worker
      // whose catalog has a key the resident object's enum does not know sends
      // exactly that value. `appearance_json` is only guaranteed to be valid
      // JSON by the column's `json_valid` CHECK — `'null'` satisfies it and is
      // not an appearance.
      const stored = root.appearance_json
        ? WorkstreamAppearanceSchema.safeParse(JSON.parse(root.appearance_json)).data
        : { icon: null, color: null };
      const chosen = input.icon == null
        ? null
        : WorkstreamIconKeySchema.safeParse(input.icon).data ?? null;
      // An appearance this object cannot read is left exactly as it is, rather
      // than replaced with a generated icon: `docs/workstream-appearance.md`
      // has malformed durable state fail visibly rather than silently become a
      // new shared identity, and a naming pass is the last writer that should
      // overrule that. `stored` is `undefined` only in that case.
      const icon = chosen !== null && stored?.icon === null ? chosen : null;
      this.sql.exec(
        `UPDATE workstream
            SET title = COALESCE(?, title), title_status = ?,
                appearance_json = COALESCE(?, appearance_json), updated_at = ?
          WHERE id = 1`,
        input.title,
        input.to,
        icon === null ? null : JSON.stringify({ ...stored, icon }),
        input.now,
      );
      return { outcome: "renamed" as const, icon };
    });
  }

  /**
   * Put the thread's Channel colour on this conversation, keeping its icon.
   *
   * For now this is the only writer of a thread's or a Breakout's colour: the
   * client's appearance command drops `color`, and WorkspaceDO decides the
   * colour from the thread's Channel (`channel-color-sync.ts`). `revision` is
   * that mark's number, unique and increasing; one at or below the newest this
   * conversation applied is `superseded` and writes nothing, so a job that
   * stalled behind a newer one cannot put the old colour back. `unchanged`
   * records the revision without touching the appearance. An appearance this
   * object cannot read is replaced rather than kept, unlike `rename`: the
   * colour is the server's to set, and the icon falls back to the id-derived
   * default the way a stored `null` does.
   */
  recolor(input: { color: SpaceColorKey; revision: number; now: number }): {
    outcome: "recolored" | "unchanged" | "superseded";
  } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      const applied = first(this.sql.exec<{ channel_color_revision: number }>(
        "SELECT channel_color_revision FROM workstream WHERE id = 1",
      ))?.channel_color_revision ?? 0;
      if (!root || input.revision <= applied) return { outcome: "superseded" as const };
      const stored = root.appearance_json
        ? WorkstreamAppearanceSchema.safeParse(JSON.parse(root.appearance_json)).data
        : undefined;
      const changed = stored?.color !== input.color;
      this.sql.exec(
        `UPDATE workstream
            SET appearance_json = COALESCE(?, appearance_json), channel_color_revision = ?, updated_at = ?
          WHERE id = 1`,
        changed ? JSON.stringify(WorkstreamAppearanceSchema.parse({ icon: stored?.icon ?? null, color: input.color })) : null,
        input.revision,
        changed ? input.now : root.updated_at,
      );
      return { outcome: changed ? "recolored" as const : "unchanged" as const };
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
   *
   * It also bumps `participant_epoch` and clears `first_opened_at`, which the
   * retired view's triggers did and which is easy to lose in a conversion:
   * being put back into a room you were taken out of is being added to it, so
   * the person is notified again and the work stream is unseen for them again.
   * The three facts a re-add produces — a new epoch, a fresh notification, an
   * unseen marker — have to agree, and they only do if one write makes them.
   * The reset belongs to this direction of the transition and not the other:
   * being removed is not being shown it again.
   */
  admitParticipant(input: {
    userId: string;
    addedByUserId: string;
    reason: string;
    now: number;
  }): { outcome: ParticipantAdmission } {
    // The hosted parent (a Sidekick or a Canvas) admits by its own audience
    // and seats the reader here.
    return this.storage.transactionSync(() => ({ outcome: this.seat(input).outcome }));
  }

  /**
   * One seating, without a transaction of its own.
   *
   * Used only for parent-authorized Sidekick and Canvas seating.
   */
  private seat(input: {
    userId: string;
    addedByUserId: string;
    reason: string;
    now: number;
  }): { outcome: ParticipantAdmission; participationReason: string; addedAt: number } {
    const existing = first(this.sql.exec<ParticipantRow & { status: string }>(
      `SELECT user_id, participation_reason, added_by_user_id, status, added_at, removed_at
         FROM participants WHERE user_id = ?`,
      input.userId,
    ));
    if (existing && existing.removed_at === null) {
      return {
        outcome: "unchanged",
        participationReason: existing.participation_reason,
        addedAt: existing.added_at,
      };
    }
    if (existing) {
      this.sql.exec(
        `UPDATE participants
            SET status = 'active', removed_at = NULL, participation_reason = ?,
                added_by_user_id = ?, added_at = ?,
                participant_epoch = participant_epoch + 1, first_opened_at = NULL,
                updated_at = ?
          WHERE user_id = ?`,
        input.reason,
        input.addedByUserId,
        input.now,
        input.now,
        input.userId,
      );
      startReadCursorAtLatest(this.sql, input.userId, input.now, input.addedByUserId !== input.userId);
      return { outcome: "readmitted", participationReason: input.reason, addedAt: input.now };
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
    startReadCursorAtLatest(this.sql, input.userId, input.now, input.addedByUserId !== input.userId);
    return { outcome: "admitted", participationReason: input.reason, addedAt: input.now };
  }

  /**
   * Correct connector creator attribution without independently granting access.
   * A verified account link may replace an earlier email-identity guess; the
   * caller admits that person separately through the parent grant ledger.
   */
  adoptCreator(input: {
    userId: string;
    previousAssignedUserId: string | null;
    mayCorrectVerifiedCreator: boolean;
    now: number;
  }): { outcome: "adopted" | "unchanged" } {
    return this.storage.transactionSync(() => {
      const root = this.identity();
      if (!root) throw new Error("workstream_identity_target_missing");
      const makeCreator = root.created_by_user_id === null || (
        input.mayCorrectVerifiedCreator && input.previousAssignedUserId !== null
        && root.created_by_user_id === input.previousAssignedUserId
      );
      if (!makeCreator) return { outcome: "unchanged" as const };
      this.sql.exec("UPDATE workstream SET created_by_user_id = ?, updated_at = ? WHERE id = 1", input.userId, input.now);
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
      // The retired insert trigger's mapping, kept because a producer states
      // what the work stream is doing rather than which of the object's
      // fourteen exact states it is in.
      const exactState = ["scheduled", "running", "needs_input", "completed", "failed"]
        .includes(input.harnessStatus)
        ? input.harnessStatus
        : "idle";
      this.sql.exec(
        `UPDATE workstream
            SET title = ?, description = ?, scope = ?,
                created_by_user_id = ?, system_kind = ?,
                -- Preserved when the producer has no route to write. The
                -- digest and activity batches never named these columns, so
                -- they kept the table's defaults, and email_route_status is
                -- NOT NULL: writing the absent value would fail the insert
                -- rather than leave the column alone.
                email_address = COALESCE(?, email_address),
                email_route_status = COALESCE(?, email_route_status),
                model_override = ?, agent_profile = ?,
                appearance_json = COALESCE(appearance_json, ?),
                exact_state = ?, state_reason_code = ?, title_status = ?,
                description_source = 'derived', listing_epoch = listing_epoch + 1,
                created_at = ?, last_people_activity_at = ?, state_changed_at = ?,
                updated_at = ?
          WHERE id = 1`,
        input.title,
        input.objective,
        input.scope,
        input.createdByUserId,
        input.systemKind,
        input.emailAddress,
        input.emailRouteStatus,
        input.modelOverride,
        input.agentProfile ?? null,
        input.color ? JSON.stringify({ icon: null, color: input.color }) : null,
        exactState,
        exactState === "idle" ? "provisioned" : `run_${exactState}`,
        input.titleStatus ?? "settled",
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
