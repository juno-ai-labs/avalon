/**
 * One alarm per Durable Object, many things waiting on it.
 *
 * Cloudflare gives an object a single alarm: `setAlarm` overwrites whatever was
 * armed before. Every object here already had more than one reason to wake —
 * an outbox retry, a keep-alive, a due schedule, a wake-up a run asked for — and
 * each object had grown its own copy of the same three moves: derive the
 * earliest reason from a table, compare it against `getAlarm()`, and hope
 * nothing else needed the slot. The copies disagreed. Some lowered the alarm
 * but never raised it, so a cancelled row left the object waking for nothing;
 * one fired only the first due item per alarm, so ten wake-ups due at the same
 * instant took ten alarms to drain.
 *
 * This module holds that logic once. A subclass declares what it wants woken
 * for — rows in `_internal_durable_alarms`, or a timestamp derived from its own tables —
 * and the base owns the arithmetic: the single alarm is always the earliest
 * effective instant across both, every entry due at that instant is drained in
 * that one wake, and an entry whose handler throws is held behind its own
 * exponential gate instead of taking the object's whole schedule down with it.
 *
 * `docs/durable-object-alarms.md` is the module document.
 */
import { WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE } from "@rally/contracts";

import type { Env } from "../env";
import { InternallyInspectableDurableObject } from "./internally-inspectable-durable-object";
import {
  countRetainedOutbox,
  markInstanceRetired,
  objectRetirementState,
  writeObjectRetirement,
  type ObjectRetirementState,
  type ObjectRetirementTombstone,
} from "./object-retirement";

/**
 * Added to an object's own migration history, not applied here.
 *
 * Each object keeps an append-only ledger keyed by a hash of its statements, so
 * a shared table has to arrive as a new version *inside* each ledger. Sharing
 * the statements — rather than each object writing its own `CREATE TABLE` — is
 * what keeps the store's SQL valid against all three.
 */
export const SCHEDULED_ALARM_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE _internal_durable_alarms (
    kind TEXT NOT NULL,
    alarm_key TEXT NOT NULL,
    due_at INTEGER NOT NULL CHECK (due_at >= 0),
    repeat_every_ms INTEGER CHECK (repeat_every_ms IS NULL OR repeat_every_ms > 0),
    retry_at INTEGER NOT NULL DEFAULT 0 CHECK (retry_at >= 0),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, alarm_key)
  ) STRICT`,
  // The scheduler orders by the *effective* instant — the later of the entry's
  // due time and its retry gate — so that is what the index has to carry. An
  // index on `due_at` alone would be read for a query that never uses it.
  `CREATE INDEX _internal_durable_alarms_effective_idx
    ON _internal_durable_alarms(MAX(due_at, retry_at), kind, alarm_key)`,
];

/** First backoff step for an entry whose handler threw. */
export const SCHEDULED_ALARM_RETRY_BASE_MS = 60_000;
/** Ceiling for that backoff: past this a target is broken, not busy. */
export const SCHEDULED_ALARM_RETRY_MAX_MS = 30 * 60_000;
/**
 * Recovery horizon for an alarm continuation the runtime cancels without a throw.
 *
 * Cloudflare retries a thrown Durable Object alarm after two seconds. A
 * cancelled continuation is invisible to that retry mechanism, so the
 * durability arm mirrors its first retry rather than choosing an Avalon-owned
 * timeout. Source: https://developers.cloudflare.com/durable-objects/api/alarms/
 * (retrieved 2026-08-24).
 */
export const SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS = 2_000;

/**
 * Bring a Durable Object's alarm forward without erasing a sooner one.
 *
 * The body of {@link ScheduledDurableObject.ensureAlarmNoLaterThan}, lifted out
 * so a collaborator that holds the storage but not the object can arm its own
 * durability wake-up. Without it such a caller has only bare `setAlarm`, which
 * pushes an earlier wake-up out and loses whatever that one was for.
 */
export async function ensureStorageAlarmNoLaterThan(
  storage: DurableObjectStorage,
  dueAt: number,
): Promise<void> {
  const floored = Math.max(Date.now() + 1, dueAt);
  const existing = await storage.getAlarm();
  if (existing === null || existing > floored) await storage.setAlarm(floored);
}

/**
 * Entries drained in one wake.
 *
 * A Durable Object alarm is a single-threaded invocation with a wall-clock
 * budget, and anything past this bound is re-armed for the next instant rather
 * than dropped, so the only cost of the limit is one extra wake.
 */
export const SCHEDULED_ALARM_DRAIN_LIMIT = 100;

/**
 * Equal-jitter exponential backoff.
 *
 * The jitter is not decoration. Every workspace in a region shares whatever
 * dependency just failed, so a deterministic delay retries them all in the same
 * millisecond and reproduces the overload that caused the failure. Half the
 * ceiling is fixed so the delay still grows; the other half is spread.
 */
export function scheduledAlarmRetryDelay(attempt: number, random = Math.random): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  const ceiling = Math.min(
    SCHEDULED_ALARM_RETRY_MAX_MS,
    SCHEDULED_ALARM_RETRY_BASE_MS * 2 ** exponent,
  );
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
}

export interface ScheduledAlarm {
  kind: string;
  key: string;
  /** When the entry is *meant* to run, owned by whoever scheduled it. */
  dueAt: number;
  repeatEveryMs: number | null;
  /** Backoff gate owned by the drain; `0` when the entry has never failed. */
  retryAt: number;
  attempt: number;
  payload: string | null;
}

export interface ScheduledAlarmInput {
  kind: string;
  key: string;
  dueAt: number;
  /** Non-null makes the entry recurring: it re-arms instead of being deleted. */
  repeatEveryMs?: number | null;
  payload?: string | null;
}

/**
 * What a handler may say about the entry it just ran, beyond returning.
 *
 * Returning nothing is the common answer and leaves the decision to the base:
 * an entry that is due again at the identical instant after the re-derive is
 * a stall. `progressed` says the pass moved its source and the identical
 * instant is transient — a bounded reap that cleared a hundred rows of the
 * same second and has more behind them — so the entry keeps its immediate
 * re-wake. `waitMs` says the work is legitimately not possible yet — a sandbox
 * a live run holds, a directory row the Queue has not caught up to — and asks
 * for the entry to be held that long without it counting as an attempt.
 */
export type ScheduledAlarmOutcome = { progressed: true } | { waitMs: number } | void;

/** One drained entry and what its handler said about it. */
export interface ScheduledAlarmRun {
  alarm: ScheduledAlarm;
  outcome: ScheduledAlarmOutcome;
}

interface ScheduledAlarmRow {
  [column: string]: SqlStorageValue;
  kind: string;
  alarm_key: string;
  due_at: number;
  repeat_every_ms: number | null;
  retry_at: number;
  attempt: number;
  payload_json: string | null;
}

function alarmFromRow(row: ScheduledAlarmRow): ScheduledAlarm {
  return {
    kind: row.kind,
    key: row.alarm_key,
    dueAt: row.due_at,
    repeatEveryMs: row.repeat_every_ms,
    retryAt: row.retry_at,
    attempt: row.attempt,
    payload: row.payload_json,
  };
}

function validate(input: ScheduledAlarmInput): void {
  if (input.kind.length === 0 || input.key.length === 0) {
    throw new Error("scheduled_alarm_identity_required");
  }
  if (!Number.isSafeInteger(input.dueAt) || input.dueAt < 0) {
    throw new Error(`scheduled_alarm_due_at_invalid:${input.kind}`);
  }
  const repeat = input.repeatEveryMs ?? null;
  if (repeat !== null && (!Number.isSafeInteger(repeat) || repeat <= 0)) {
    throw new Error(`scheduled_alarm_repeat_invalid:${input.kind}`);
  }
}

/**
 * Every read and write of `_internal_durable_alarms`, in one place.
 *
 * Deliberately synchronous: object-local SQLite is, and an async surface here
 * would invite callers to await between a schedule and the arming that has to
 * follow it in the same invocation.
 */
export class ScheduledAlarmStore {
  constructor(private readonly sql: SqlStorage) {}

  /**
   * Insert or move one entry.
   *
   * Moving the due time clears the retry gate and the attempt count: a caller
   * that rescheduled has said something changed, and holding a fresh instant
   * behind the backoff earned by the old one hides the very retry the caller
   * asked for. A rewrite to the same instant is left alone, so a reconcile pass
   * over unchanged rows neither resets a gate nor writes.
   */
  schedule(input: ScheduledAlarmInput, now: number = Date.now()): void {
    validate(input);
    this.sql.exec(
      `INSERT INTO _internal_durable_alarms
         (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(kind, alarm_key) DO UPDATE SET
         due_at = excluded.due_at,
         repeat_every_ms = excluded.repeat_every_ms,
         retry_at = 0,
         attempt = 0,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at
       WHERE _internal_durable_alarms.due_at != excluded.due_at
          OR _internal_durable_alarms.repeat_every_ms IS NOT excluded.repeat_every_ms
          OR _internal_durable_alarms.payload_json IS NOT excluded.payload_json`,
      input.kind,
      input.key,
      input.dueAt,
      input.repeatEveryMs ?? null,
      input.payload ?? null,
      now,
      now,
    );
  }

  cancel(kind: string, key: string): boolean {
    return this.sql.exec(
      `DELETE FROM _internal_durable_alarms WHERE kind = ? AND alarm_key = ? RETURNING alarm_key`,
      kind,
      key,
    ).toArray().length > 0;
  }

  /**
   * Cancel every entry of these kinds whose key starts with `prefix`, in one
   * statement. For an owner whose entries share a key prefix, such as a hosted
   * Sidekick's `<sidekickId>:`. The prefix is compared as text, not as a
   * `LIKE` pattern, so an id holding `%` or `_` matches only itself.
   */
  cancelByKeyPrefix(kinds: readonly string[], prefix: string): number {
    if (prefix.length === 0) throw new Error("scheduled_alarm_prefix_empty");
    return this.sql.exec(
      `DELETE FROM _internal_durable_alarms
        WHERE kind IN (SELECT value FROM json_each(?1))
          AND substr(alarm_key, 1, length(?2)) = ?2
        RETURNING alarm_key`,
      JSON.stringify(kinds),
      prefix,
    ).toArray().length;
  }

  cancelKind(kind: string): number {
    return this.sql.exec(
      `DELETE FROM _internal_durable_alarms WHERE kind = ? RETURNING alarm_key`,
      kind,
    ).toArray().length;
  }

  /**
   * Make one kind's entries exactly the given set.
   *
   * This is how an object whose canonical due times live in *another* table —
   * `schedules`, `resource_watches`, `workstream_wakeups` — keeps the alarm
   * index true without that table's writers having to know the index exists.
   * Survivors keep their retry gate, so a target that has been failing does not
   * get a free immediate attempt every time an unrelated sibling is written.
   */
  reconcile(
    kind: string,
    targets: readonly Omit<ScheduledAlarmInput, "kind">[],
    now: number = Date.now(),
  ): void {
    const keys = targets.map((target) => target.key);
    if (keys.length === 0) {
      this.cancelKind(kind);
      return;
    }
    // The surviving keys travel as one JSON value, not one bound parameter
    // each. workerd caps bound SQL variables well below the number of targets a
    // real workspace has — a person's digest is one `schedules` row per
    // delivery time, so a mid-sized workspace clears 100 on its own — and past
    // that cap this threw `too many SQL variables`, which rolled back the
    // enclosing transaction and left the whole index stale.
    this.sql.exec(
      `DELETE FROM _internal_durable_alarms
        WHERE kind = ? AND alarm_key NOT IN (SELECT value FROM json_each(?))`,
      kind,
      JSON.stringify(keys),
    );
    for (const target of targets) this.schedule({ ...target, kind }, now);
  }

  get(kind: string, key: string): ScheduledAlarm | null {
    const row = this.sql.exec<ScheduledAlarmRow>(
      `SELECT kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json
         FROM _internal_durable_alarms WHERE kind = ? AND alarm_key = ?`,
      kind,
      key,
    ).toArray()[0];
    return row ? alarmFromRow(row) : null;
  }

  list(kind?: string): ScheduledAlarm[] {
    const rows = kind === undefined
      ? this.sql.exec<ScheduledAlarmRow>(
        `SELECT kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json
           FROM _internal_durable_alarms ORDER BY MAX(due_at, retry_at), kind, alarm_key`,
      )
      : this.sql.exec<ScheduledAlarmRow>(
        `SELECT kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json
           FROM _internal_durable_alarms WHERE kind = ? ORDER BY MAX(due_at, retry_at), alarm_key`,
        kind,
      );
    return rows.toArray().map(alarmFromRow);
  }

  due(now: number, limit: number = SCHEDULED_ALARM_DRAIN_LIMIT): ScheduledAlarm[] {
    return this.sql.exec<ScheduledAlarmRow>(
      `SELECT kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json
         FROM _internal_durable_alarms
        WHERE MAX(due_at, retry_at) <= ?
        ORDER BY MAX(due_at, retry_at), kind, alarm_key
        LIMIT ?`,
      now,
      limit,
    ).toArray().map(alarmFromRow);
  }

  /** The earliest instant any stored entry wants the object awake. */
  nextDueAt(): number | null {
    const row = this.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(MAX(due_at, retry_at)) AS due_at FROM _internal_durable_alarms`,
    ).toArray()[0];
    return row?.due_at ?? null;
  }

  /** The earliest effective `MAX(due_at, retry_at)` strictly after `after`. */
  nextDueAtAfter(after: number): number | null {
    const row = this.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(MAX(due_at, retry_at)) AS due_at
         FROM _internal_durable_alarms
        WHERE MAX(due_at, retry_at) > ?`,
      after,
    ).toArray()[0];
    return row?.due_at ?? null;
  }

  /**
   * Retire an entry whose handler returned.
   *
   * A recurring entry advances to the first occurrence strictly after `now`
   * rather than to `dueAt + repeat`: an object that hibernated through six
   * hours of a five-minute repeat would otherwise spend the next six hours
   * firing catch-up occurrences nobody is waiting for.
   */
  settle(alarm: Pick<ScheduledAlarm, "kind" | "key" | "dueAt" | "repeatEveryMs">, now: number): void {
    if (alarm.repeatEveryMs === null) {
      // Guarded on the instant that ran. A handler is allowed to reschedule
      // its own entry — the workspace product pass does exactly that — and an
      // unguarded delete here would throw away the wake-up it just asked for.
      this.sql.exec(
        `DELETE FROM _internal_durable_alarms WHERE kind = ? AND alarm_key = ? AND due_at = ?`,
        alarm.kind,
        alarm.key,
        alarm.dueAt,
      );
      return;
    }
    const elapsed = Math.max(0, now - alarm.dueAt);
    const skipped = Math.floor(elapsed / alarm.repeatEveryMs) + 1;
    this.sql.exec(
      `UPDATE _internal_durable_alarms
          SET due_at = ?, retry_at = 0, attempt = 0, updated_at = ?
        WHERE kind = ? AND alarm_key = ? AND due_at = ?`,
      alarm.dueAt + skipped * alarm.repeatEveryMs,
      now,
      alarm.kind,
      alarm.key,
      alarm.dueAt,
    );
  }

  /** Hold a failed entry behind its own gate and report the attempt it is on. */
  defer(alarm: Pick<ScheduledAlarm, "kind" | "key" | "dueAt" | "attempt">, now: number): number {
    const attempt = alarm.attempt + 1;
    this.sql.exec(
      `UPDATE _internal_durable_alarms
          SET attempt = ?, retry_at = ?, updated_at = ?
        WHERE kind = ? AND alarm_key = ? AND due_at = ?`,
      attempt,
      now + scheduledAlarmRetryDelay(attempt),
      now,
      alarm.kind,
      alarm.key,
      alarm.dueAt,
    );
    return attempt;
  }

  /** Hold an entry until `until` without counting an attempt: a wait, not a failure. */
  hold(alarm: Pick<ScheduledAlarm, "kind" | "key" | "dueAt">, until: number, now: number): void {
    this.sql.exec(
      `UPDATE _internal_durable_alarms SET retry_at = ?, updated_at = ?
        WHERE kind = ? AND alarm_key = ? AND due_at = ?`,
      until,
      now,
      alarm.kind,
      alarm.key,
      alarm.dueAt,
    );
  }
}

/**
 * The base every scheduling object in this Worker extends.
 *
 * A subclass supplies three things on top of what `InternallyInspectableDurableObject`
 * already asks of it: what its own tables want it woken for, how to run one
 * stored entry, and whatever derived work its alarm did before this existed. It
 * never calls `setAlarm` itself.
 *
 * The schema half sits in the base below rather than here because it is not the
 * scheduler's: `_internal_durable_alarms` is created by the same migration list
 * as everything else the object stores, and `migrationsReady` — which every
 * method here awaits before touching that table — is the promise the object's
 * constructor already holds. A Durable Object that migrates but does not
 * schedule extends `MigratableDurableObject` directly and is not exposed to
 * engineering SQL inspection.
 */
export abstract class ScheduledDurableObject<TEnv extends Env = Env>
  extends InternallyInspectableDurableObject<TEnv> {
  private scheduledAlarmStore: ScheduledAlarmStore | null = null;

  /**
   * Every instant this object's *own* tables want it awake.
   *
   * For wake reasons whose canonical due time already lives in a table with its
   * own writers — an outbox's `not_before`, a keep-alive lease — deriving is
   * cheaper and cannot drift. Reasons with no such table belong in
   * `_internal_durable_alarms` instead.
   */
  protected abstract nextDerivedAlarmCandidates(now: number): readonly number[];

  /**
   * Run one due stored entry. Throwing puts it behind its retry gate; what it
   * returns is read by the stall check after the re-derive.
   */
  protected abstract runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome>;

  /** Whatever this object's alarm does that is not a stored entry. */
  protected abstract runDueAlarmWork(now: number): Promise<void>;

  protected get scheduledAlarms(): ScheduledAlarmStore {
    this.scheduledAlarmStore ??= new ScheduledAlarmStore(this.ctx.storage.sql);
    return this.scheduledAlarmStore;
  }

  /**
   * Defer this whole alarm to a later instant, or `null` to proceed.
   *
   * The one case this exists for is regional authority: while a workspace is
   * being migrated, running due work would mutate rows the importer is
   * replaying. Deferring is not dropping — every entry keeps its due time and
   * fires once the region reopens. An object with no such gate answers `null`.
   */
  protected abstract scheduledAlarmDeferral(now: number): Promise<number | null>;

  /**
   * Report an entry that threw. The base has already gated it, so this is
   * observability only — each object logs with its own identity fields, which
   * is the whole reason it is not implemented here.
   */
  protected abstract onScheduledAlarmFailure(
    alarm: ScheduledAlarm,
    error: unknown,
    attempt: number,
  ): void;

  /**
   * Report an entry that ran, returned, and came back due at the same instant.
   * The base has already gated it exactly as it would a throw, so like the
   * failure hook this is observability only, implemented per object for its
   * own identity fields.
   */
  protected abstract onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void;

  /**
   * Report an alarm pass that changed nothing and asked to run again at once.
   * The base has already held the alarm, so like the hooks above this is
   * observability only, implemented per object for its own identity fields.
   */
  protected abstract onIdleAlarmHeld(attempt: number, heldUntil: number): void;

  /**
   * Consecutive idle passes, counted in memory. See {@link holdIdleAlarm}.
   *
   * Not persisted, because writing it would make the pass that counts it look
   * like progress. An object in the loop this catches never sleeps, so its
   * instance is never evicted; one that is evicted starts again at the first
   * step, which costs one short wake.
   */
  private idleAlarmAttempt = 0;

  /**
   * Add or move one entry, then point the alarm at whatever is now earliest.
   *
   * Every mutation of the list re-arms, in both directions. An entry scheduled
   * *before* the armed instant has to pull the alarm in or it fires late; the
   * last entry cancelled has to take the alarm with it or the object wakes for
   * nothing. Doing this at the mutation — rather than trusting the next alarm
   * to notice — is what lets a caller schedule and return.
   */
  protected async scheduleAlarm(input: ScheduledAlarmInput): Promise<void> {
    await this.migrationsReady();
    this.scheduledAlarms.schedule(input);
    await this.armNextAlarm();
  }

  protected async cancelScheduledAlarm(kind: string, key: string): Promise<boolean> {
    await this.migrationsReady();
    const cancelled = this.scheduledAlarms.cancel(kind, key);
    await this.armNextAlarm();
    return cancelled;
  }

  protected async cancelScheduledAlarmKind(kind: string): Promise<number> {
    await this.migrationsReady();
    const cancelled = this.scheduledAlarms.cancelKind(kind);
    await this.armNextAlarm();
    return cancelled;
  }

  protected async reconcileScheduledAlarms(
    kind: string,
    targets: readonly Omit<ScheduledAlarmInput, "kind">[],
  ): Promise<void> {
    await this.migrationsReady();
    this.ctx.storage.transactionSync(() => this.scheduledAlarms.reconcile(kind, targets));
    await this.armNextAlarm();
  }

  /**
   * Point the object's one alarm at the earliest thing waiting on it.
   *
   * Exact rather than lowering-only, and called from every path that changes
   * the list. A helper that only ever lowers cannot take an alarm back when the
   * row that justified it is cancelled, and cannot push one out when a target
   * is deferred — both of which leave the object waking on a schedule nothing
   * is behind. When nothing is left the armed alarm is deleted outright rather
   * than left to fire on an empty list. Writing only on an actual change keeps
   * the common re-arm free.
   */
  protected async armNextAlarm(
    options: {
      /** One shared time snapshot for classifying every candidate. */
      now?: number;
      /** Where already-due candidates are parked; omitted means `now + 1`. */
      overdueAt?: number;
      /** Override derived lanes when the current invocation owns one of them. */
      derivedCandidates?: readonly (number | null)[];
    } = {},
  ): Promise<number | null> {
    const now = options.now ?? Date.now();
    const storedDueAt = this.scheduledAlarms.nextDueAt();
    const candidates = [
      storedDueAt,
      options.overdueAt !== undefined && storedDueAt !== null && storedDueAt <= now
        ? this.scheduledAlarms.nextDueAtAfter(now)
        : null,
      ...(options.derivedCandidates ?? this.nextDerivedAlarmCandidates(now)),
    ]
      .filter((value): value is number => value !== null);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const overdueAt = Math.max(now + 1, options.overdueAt ?? now + 1);
    const next = Math.min(
      ...candidates.map((candidate) => candidate <= now ? overdueAt : candidate),
    );
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== next) await this.ctx.storage.setAlarm(next);
    return next;
  }

  /**
   * Bring the alarm forward without asking what else is waiting.
   *
   * For a caller that has just committed work and must not lose it if this
   * invocation dies before a full re-arm: it reads the current alarm and only
   * ever moves it earlier, so it can never erase a sooner one.
   */
  protected async ensureAlarmNoLaterThan(dueAt: number): Promise<void> {
    await ensureStorageAlarmNoLaterThan(this.ctx.storage, dueAt);
  }

  /**
   * Run every entry due at this instant, each behind its own gate.
   *
   * One failing entry must not cost its siblings their slot, and it must not
   * turn the object into a hot loop either — so the gate is persisted before
   * the failure hook runs, where an exception would otherwise leave the entry
   * due again a millisecond later.
   *
   * Returns the entries whose handler returned, as they were when they ran
   * and with what the handler said: the stall check after the re-derive needs
   * the instant and the attempt the settle is about to erase.
   */
  protected async drainDueScheduledAlarms(now: number): Promise<ScheduledAlarmRun[]> {
    const ran: ScheduledAlarmRun[] = [];
    for (const alarm of this.scheduledAlarms.due(now)) {
      try {
        const outcome = await this.runScheduledAlarm(alarm);
        this.scheduledAlarms.settle(alarm, Date.now());
        ran.push({ alarm, outcome });
      } catch (error) {
        const attempt = this.scheduledAlarms.defer(alarm, Date.now());
        this.onScheduledAlarmFailure(alarm, error, attempt);
      }
    }
    return ran;
  }

  /**
   * Hold back every entry that ran, returned, and is due again at the very
   * instant it just ran at.
   *
   * The retry gate has always caught a handler that throws. It never caught one
   * that returns without moving its source: the settle retires the entry, the
   * re-derive in `runDueAlarmWork` puts the same past instant straight back,
   * and `armNextAlarm` floors it at `now + 1` — one wake per handler duration,
   * for as long as the source stays put, with nothing logged. That is the
   * shape every hot-alarm loop here has had. On 2026-08-22 a Slack link
   * challenge that expires after 15 minutes but was reaped only after 30 days
   * ran one workspace's alarm about 1.5 times a second for hours.
   *
   * The test is deliberately narrow: the entry is back under the same key with
   * the identical `dueAt`, and that instant has already passed. A handler that
   * advanced its row re-derives a later instant; one that rescheduled itself
   * wrote a different one; an entry the drain never reached, or that came due
   * during it, is not in `ran` and still gets its immediate wake. A handler
   * that reported progress keeps its immediate wake too, and one that asked to
   * wait is held without an attempt counted. Only an entry that made no
   * progress at all is held behind the gate a throw earns, with the attempt it
   * arrived with carried forward — the settle deleted the row and the reconcile
   * re-inserted it at zero, and without the carry the delay restarts at its
   * first step on every wake and never reaches the ceiling.
   */
  protected gateStalledScheduledAlarms(ran: readonly ScheduledAlarmRun[], now: number): void {
    for (const { alarm, outcome } of ran) {
      if (outcome && "progressed" in outcome) continue;
      const current = this.scheduledAlarms.get(alarm.kind, alarm.key);
      if (current === null || current.dueAt !== alarm.dueAt) continue;
      if (Math.max(current.dueAt, current.retryAt) > now) continue;
      // A wait that is not a positive finite number is not a wait: the entry
      // takes the stall rule rather than a hold at an instant nobody chose.
      if (outcome && "waitMs" in outcome && Number.isFinite(outcome.waitMs) && outcome.waitMs > 0) {
        this.scheduledAlarms.hold(current, now + Math.ceil(outcome.waitMs), now);
        continue;
      }
      const attempt = this.scheduledAlarms.defer({ ...current, attempt: alarm.attempt }, now);
      this.onScheduledAlarmStalled(current, attempt);
    }
  }

  /**
   * The durability re-arm made before this alarm awaits anything.
   *
   * A cancelled invocation does not throw and does not run a `finally`, so an
   * object that re-arms only at the end of its handler can be left with no
   * wake-up at all — and nothing but an unrelated request would ever discover
   * the work it still owes. Already-due reasons are re-armed at the first retry
   * horizon rather than the next millisecond. Their source rows remain durable
   * until this invocation settles them, so that wake recovers a cancelled
   * continuation without creating a second invocation that the normal
   * end-of-handler re-arm must immediately replace. A genuinely future reason
   * keeps its exact earlier deadline. An object whose alarm *is* the worker for
   * a derived reason may still override this to use that lane's recovery
   * horizon.
   */
  protected armAlarmBeforeDueWork(now: number): Promise<unknown> {
    return this.armNextAlarm({
      now,
      overdueAt: now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
    });
  }

  /** The re-arm made once this alarm's work has run. Same override rule. */
  protected armAlarmAfterDueWork(): Promise<unknown> {
    return this.armNextAlarm();
  }

  /**
   * Hold back an alarm whose pass wrote nothing and that re-armed for the next
   * millisecond anyway.
   *
   * `gateStalledScheduledAlarms` catches this shape for stored entries. Derived
   * lanes had no such gate: a lane that reports work at `now` which its pass
   * then declines leaves the same answer in place, and `armNextAlarm` floors it
   * at `now + 1`. From at least 2026-10-27 to 2026-11-03 one stopped background
   * agent with a message queued did this about five times a second, about 1.7M
   * of the account's 1.9M log and trace events an hour, with nothing logged.
   *
   * "Wrote nothing" is SQLite's `total_changes()`, sampled around the drain and
   * the due work, which is the whole of what a pass can durably move. A pass
   * that drained a stored entry wrote its settle, a bounded drain wrote the rows
   * it took, and a request that wrote while the pass awaited counts too. So the
   * test errs toward not holding. The re-arms on either side are outside the
   * sample: `setAlarm` is itself a change.
   *
   * The hold is the backoff a thrown entry earns, never later than the next
   * future candidate, and anything that schedules or admits work re-arms past
   * it through the ordinary paths. A pass that writes, or arms anywhere but the
   * next millisecond, ends the episode.
   */
  private async holdIdleAlarm(changesBefore: number, changesAfter: number): Promise<void> {
    const now = Date.now();
    const armed = await this.ctx.storage.getAlarm();
    if (changesAfter !== changesBefore || armed === null || armed > now + 1) {
      this.idleAlarmAttempt = 0;
      return;
    }
    this.idleAlarmAttempt += 1;
    const future = [
      this.scheduledAlarms.nextDueAtAfter(now),
      ...this.nextDerivedAlarmCandidates(now),
    ].filter((candidate): candidate is number => candidate !== null && candidate > now);
    const heldUntil = Math.min(now + scheduledAlarmRetryDelay(this.idleAlarmAttempt), ...future);
    await this.ctx.storage.setAlarm(heldUntil);
    this.onIdleAlarmHeld(this.idleAlarmAttempt, heldUntil);
  }

  private sqlTotalChanges(): number {
    return this.ctx.storage.sql.exec<{ changes: number }>(
      "SELECT total_changes() AS changes",
    ).one().changes;
  }

  /**
   * Close this object permanently.
   *
   * Every class that can belong to a workspace extends this base, which is
   * why the two retirement entry points live here rather than being restated
   * three times. Both are `permit`ed by each class's gate: retirement that
   * refused its own second pass could never resume after an interruption, and
   * an operator who could not read the tombstone could not tell a retired
   * object from an unreachable one.
   *
   * First write wins. A resumed pass converges on the original instant rather
   * than recording when the retry happened.
   */
  async retireObject(input: ObjectRetirementTombstone): Promise<ObjectRetirementState> {
    await this.migrationsReady();
    const stored = this.ctx.storage.transactionSync(() => {
      const tombstone = writeObjectRetirement(this.ctx.storage.sql, input);
      // Cleared in the same transaction that closes the object. A wake reason
      // that survived the tombstone would be an object with a live reason to
      // run and no permission to do anything when it did.
      this.ctx.storage.sql.exec("DELETE FROM _internal_durable_alarms");
      return tombstone;
    });
    // The gate reads a cache, and this instance is the only writer of the fact
    // it caches. Without this the object stays open until it is next evicted.
    markInstanceRetired(this);
    // The platform's own alarm, deleted rather than left to fire into a handler
    // that would do nothing. `armNextAlarm` is inert from here, so nothing
    // re-derives it: this is the last time this object's alarm slot is written.
    await this.ctx.storage.deleteAlarm();
    // Every socket this object holds, closed with the code the desktop treats
    // as permanent. The hibernated callbacks are dropped from here, so a socket
    // left open would stay "connected" — the runtime answers its keepalive
    // without waking the object — while every frame it sent was discarded, and
    // the client would never learn the room was gone. `1008` is the close a
    // client does not reconnect from; an ordinary close would reconnect into a
    // 409 and keep trying.
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "This workspace has been closed");
      } catch {
        // A socket already closing has nothing left to close.
      }
    }
    return {
      retired: true,
      retiredAt: stored.retiredAt,
      operationId: stored.operationId,
      actorUserId: stored.actorUserId,
      reason: stored.reason,
      retainedOutbox: countRetainedOutbox(this.ctx.storage.sql),
    };
  }

  /** Read-only inspection, permitted after retirement so an operator can see it. */
  async objectRetirementState(): Promise<ObjectRetirementState> {
    await this.migrationsReady();
    return objectRetirementState(this.ctx.storage.sql);
  }

  override async alarm(): Promise<void> {
    await this.migrationsReady();
    const now = Date.now();
    await this.armAlarmBeforeDueWork(now);
    const deferral = await this.scheduledAlarmDeferral(now);
    if (deferral !== null) {
      // Set outright rather than lowered: the recovery arm above can be
      // earlier than the region's recheck instant. Only an alarm that moves
      // *out* stops this from re-entering while the region stays closed.
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deferral));
      return;
    }
    const changesBefore = this.sqlTotalChanges();
    const ran = await this.drainDueScheduledAlarms(now);
    await this.runDueAlarmWork(now);
    this.gateStalledScheduledAlarms(ran, Date.now());
    const changesAfter = this.sqlTotalChanges();
    await this.armAlarmAfterDueWork();
    await this.holdIdleAlarm(changesBefore, changesAfter);
  }
}
