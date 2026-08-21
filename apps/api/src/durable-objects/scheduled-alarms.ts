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
import { DurableObject } from "cloudflare:workers";

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
    const placeholders = keys.map(() => "?").join(", ");
    this.sql.exec(
      `DELETE FROM _internal_durable_alarms WHERE kind = ? AND alarm_key NOT IN (${placeholders})`,
      kind,
      ...keys,
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
}

/**
 * The base every scheduling object in this Worker extends.
 *
 * A subclass supplies four things: when its schema is ready, what its own
 * tables want it woken for, how to run one stored entry, and whatever derived
 * work its alarm did before this existed. It never calls `setAlarm` itself.
 */
export abstract class ScheduledDurableObject<TEnv> extends DurableObject<TEnv> {
  private scheduledAlarmStore: ScheduledAlarmStore | null = null;

  /** Resolves once this object's migrations — including `_internal_durable_alarms` — have run. */
  protected abstract scheduleReady(): Promise<void>;

  /**
   * The earliest instant this object's *own* tables want it awake, or `null`.
   *
   * For wake reasons whose canonical due time already lives in a table with its
   * own writers — an outbox's `not_before`, a keep-alive lease — deriving is
   * cheaper and cannot drift. Reasons with no such table belong in
   * `_internal_durable_alarms` instead.
   */
  protected abstract nextDerivedAlarmAt(now: number): number | null;

  /** Run one due stored entry. Throwing puts it behind its retry gate. */
  protected abstract runScheduledAlarm(alarm: ScheduledAlarm): Promise<void>;

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
   * Add or move one entry, then point the alarm at whatever is now earliest.
   *
   * Every mutation of the list re-arms, in both directions. An entry scheduled
   * *before* the armed instant has to pull the alarm in or it fires late; the
   * last entry cancelled has to take the alarm with it or the object wakes for
   * nothing. Doing this at the mutation — rather than trusting the next alarm
   * to notice — is what lets a caller schedule and return.
   */
  protected async scheduleAlarm(input: ScheduledAlarmInput): Promise<void> {
    await this.scheduleReady();
    this.scheduledAlarms.schedule(input);
    await this.armNextAlarm();
  }

  protected async cancelScheduledAlarm(kind: string, key: string): Promise<boolean> {
    await this.scheduleReady();
    const cancelled = this.scheduledAlarms.cancel(kind, key);
    await this.armNextAlarm();
    return cancelled;
  }

  protected async cancelScheduledAlarmKind(kind: string): Promise<number> {
    await this.scheduleReady();
    const cancelled = this.scheduledAlarms.cancelKind(kind);
    await this.armNextAlarm();
    return cancelled;
  }

  protected async reconcileScheduledAlarms(
    kind: string,
    targets: readonly Omit<ScheduledAlarmInput, "kind">[],
  ): Promise<void> {
    await this.scheduleReady();
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
  protected async armNextAlarm(): Promise<number | null> {
    const now = Date.now();
    const candidates = [this.scheduledAlarms.nextDueAt(), this.nextDerivedAlarmAt(now)]
      .filter((value): value is number => value !== null);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const next = Math.max(now + 1, Math.min(...candidates));
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
    const floored = Math.max(Date.now() + 1, dueAt);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > floored) await this.ctx.storage.setAlarm(floored);
  }

  /**
   * Run every entry due at this instant, each behind its own gate.
   *
   * One failing entry must not cost its siblings their slot, and it must not
   * turn the object into a hot loop either — so the gate is persisted before
   * the failure hook runs, where an exception would otherwise leave the entry
   * due again a millisecond later.
   */
  protected async drainDueScheduledAlarms(now: number): Promise<number> {
    let ran = 0;
    for (const alarm of this.scheduledAlarms.due(now)) {
      try {
        await this.runScheduledAlarm(alarm);
        this.scheduledAlarms.settle(alarm, Date.now());
        ran += 1;
      } catch (error) {
        const attempt = this.scheduledAlarms.defer(alarm, Date.now());
        this.onScheduledAlarmFailure(alarm, error, attempt);
      }
    }
    return ran;
  }

  /**
   * The durability re-arm made before this alarm awaits anything.
   *
   * A cancelled invocation does not throw and does not run a `finally`, so an
   * object that re-arms only at the end of its handler can be left with no
   * wake-up at all — and nothing but an unrelated request would ever discover
   * the work it still owes. The exact re-derivation is the right answer for
   * almost every object; one whose alarm *is* the worker for a derived reason
   * overrides this, because re-deriving off the row it is about to service arms
   * for an instant already past and hands the same work straight back.
   */
  protected armAlarmBeforeDueWork(): Promise<unknown> {
    return this.armNextAlarm();
  }

  /** The re-arm made once this alarm's work has run. Same override rule. */
  protected armAlarmAfterDueWork(): Promise<unknown> {
    return this.armNextAlarm();
  }

  override async alarm(): Promise<void> {
    await this.scheduleReady();
    await this.armAlarmBeforeDueWork();
    const now = Date.now();
    const deferral = await this.scheduledAlarmDeferral(now);
    if (deferral !== null) {
      // Set outright rather than lowered: the re-arm above points at the
      // earliest due entry, which during a deferral is usually already past.
      // Only an alarm that moves *out* stops this from becoming a hot loop for
      // as long as the region stays closed.
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deferral));
      return;
    }
    await this.drainDueScheduledAlarms(now);
    await this.runDueAlarmWork(now);
    await this.armAlarmAfterDueWork();
  }
}
