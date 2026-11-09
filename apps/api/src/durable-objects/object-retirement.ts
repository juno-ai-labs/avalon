import { DurableObject } from "cloudflare:workers";

/**
 * One permanent fence, applied to every callable method of an object that has
 * been retired.
 *
 * Retirement ends a workspace. What makes that hard is not the decision —
 * it is that a Durable Object has many doors. A native RPC, an HTTP `fetch`, a
 * hibernated socket callback, an `alarm` the platform recovers after eviction,
 * and a continuation admitted a moment before the tombstone landed all reach
 * the object without passing anything that could have said no. WorkspaceDO
 * alone has roughly 229 methods and no shared dispatch boundary, and the
 * conversation objects hold the writes that actually matter: the refusal the
 * spike observed came from `AgentLoopDO`, and the outbox it stranded was a
 * `WorkstreamDO`'s (a class since deleted; its state is now in WorkspaceDO).
 *
 * So the check is not a helper each method is expected to call. Every method on
 * the prototype chain is replaced, once, at module load, with a wrapper that
 * consults the tombstone before delegating. A method nobody classified is
 * refused, which is the safe direction: a new RPC is fenced the day it is
 * written rather than the day somebody remembers it.
 *
 * Three dispositions, and the difference between them is the whole design:
 *
 * - **refuse** — the default. Product reads and writes throw
 *   {@link RetirementRefusedError}. Nothing new is written to a dead workspace.
 * - **permit** — retirement's own machinery, access revocation, and read-only
 *   operator inspection. Without this retirement could not finish, and nobody
 *   could see what it did.
 * - **drop** — an effect already handed to the Queue. It returns the terminal
 *   acknowledgement its consumer expects, because throwing would leave the
 *   Queue redelivering dead work until it gave up, which is the opposite of
 *   quiet. A dropped effect changes nothing and is counted, not applied.
 *
 * A permit names an *entry point* and carries the whole call beneath it. It has
 * to: `revokeSocketAccess` reads the object's own identity through a private
 * helper before it can close anything, and `startRuntimeRecovery` reaches a
 * dozen more. Listing those helpers by name is what this file asked of itself
 * first, and it does not work — five were found one at a time, each of them a
 * silently broken entry point in production. So the escape travels with the
 * receiver instead of with a flag: see {@link unfencedView} for why that is not
 * the hole a re-entrancy flag would be.
 */

/** The code a product operation against a retired object refuses with. */
export const RETIREMENT_REFUSAL_CODE = "workspace_retired";

/**
 * What a caller reads when a retired object refuses it.
 *
 * A sentence with the next action, not the bare code: the same text reaches a
 * model when a tool call meets a closed workspace, and a model given only
 * `workspace_retired` retries. The code stays in the message in parentheses,
 * which is the form `diagnosticErrorCode` extracts, so a consumer's log line
 * still says `workspace_retired` and the sentence says why.
 */
export const RETIREMENT_REFUSAL_MESSAGE =
  `This workspace has been closed permanently (${RETIREMENT_REFUSAL_CODE}); nothing in it accepts reads or writes any more, so do not retry.`;

export class RetirementRefusedError extends Error {
  readonly code = RETIREMENT_REFUSAL_CODE;

  constructor(readonly method: string) {
    super(RETIREMENT_REFUSAL_MESSAGE);
    this.name = "RetirementRefusedError";
  }
}

/**
 * Whether an error is a retired object's refusal, on either side of an RPC.
 *
 * `instanceof` does not survive the Durable Object boundary — the runtime
 * rebuilds the error on the caller's side — but the `code` property and the
 * name do, and either is enough. Every background caller that can meet a
 * retired object reads this before deciding whether its message is retried:
 * a refusal is terminal for a Queue message, a Workflow step, or a cron pass,
 * because the object will answer the same way on every redelivery, and a retry
 * loop that ends in the dead-letter queue spends the one signal this
 * repository treats as its monitoring on a state somebody designed.
 */
export function isRetirementRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  if (candidate.code === RETIREMENT_REFUSAL_CODE) return true;
  if (candidate.name === "RetirementRefusedError") return true;
  return typeof candidate.message === "string" && candidate.message.includes(`(${RETIREMENT_REFUSAL_CODE})`);
}

/**
 * The tombstone. One row, permanently, in the object's own database.
 *
 * It lives here rather than in D1 because the gate has to answer during
 * constructor recovery and after eviction, before anything else is admitted,
 * and a cross-authority read at that point would be a second failure mode in
 * the path whose whole job is to have none. `id = 1` is the object itself;
 * there is no second subject a single object could be retired on behalf of.
 */
export const OBJECT_RETIREMENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE object_retirement (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    retired_at INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    actor_user_id TEXT,
    reason TEXT NOT NULL
  ) STRICT`,
];

export interface ObjectRetirementTombstone {
  retiredAt: number;
  operationId: string;
  actorUserId: string | null;
  reason: string;
}

export interface ObjectRetirementState {
  retired: boolean;
  retiredAt: number | null;
  operationId: string | null;
  actorUserId: string | null;
  reason: string | null;
  /** Effects this object accepted and will now never publish. Residue, not pending work. */
  retainedOutbox: number;
}

interface RetirementRow extends Record<string, SqlStorageValue> {
  retired_at: number;
  operation_id: string;
  actor_user_id: string | null;
  reason: string;
}

/**
 * Read the tombstone, treating a missing table as "not retired".
 *
 * The table arrives with a migration, and the gate runs on every call including
 * those an object serves while its own schema is still the reason it woke. An
 * object too old to have the table cannot have been retired through a mechanism
 * that did not exist, so the absence is an answer rather than an error.
 */
export function readObjectRetirement(sql: SqlStorage): ObjectRetirementTombstone | null {
  let rows: RetirementRow[];
  try {
    rows = sql.exec<RetirementRow>(
      `SELECT retired_at, operation_id, actor_user_id, reason FROM object_retirement WHERE id = 1`,
    ).toArray();
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const row = rows[0];
  if (!row) return null;
  return {
    retiredAt: row.retired_at,
    operationId: row.operation_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
  };
}

/**
 * Write the tombstone, first write winning.
 *
 * Retirement is resumable, so this runs again on every resumed pass. The first
 * instant is the true one — a later pass moving it would make the record of
 * when a workspace closed depend on how many times the operation was
 * interrupted. `ON CONFLICT DO NOTHING` with a returned witness is what makes
 * the repeat converge rather than repeat.
 */
export function writeObjectRetirement(
  sql: SqlStorage,
  input: ObjectRetirementTombstone,
): ObjectRetirementTombstone {
  sql.exec(
    `INSERT INTO object_retirement (id, retired_at, operation_id, actor_user_id, reason)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    input.retiredAt,
    input.operationId,
    input.actorUserId,
    input.reason,
  );
  const stored = readObjectRetirement(sql);
  if (!stored) throw new Error("object_retirement_write_lost");
  return stored;
}

/**
 * How many effects this object accepted and never handed to the Queue.
 *
 * Counted, never drained. Draining would mean publishing out of a workspace
 * that is closed, and moving the rows somewhere else would mean deciding whose
 * they now are. The count is what lets an operator read a retired object and
 * tell retained residue from preparation still in flight — the distinction the
 * spike could not make when it found three of these stranded behind a cleared
 * alarm.
 *
 * `durable_outbox` is a conversation's or a Sidekick's; `parent_outbox` is the
 * one `WorkspaceDO` holds for the Channel and Space parents it hosts. A class
 * with neither answers zero rather than failing.
 */
export function countRetainedOutbox(sql: SqlStorage): number {
  const present = sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('durable_outbox', 'parent_outbox')",
  ).toArray().map((row) => row.name);
  let retained = 0;
  for (const table of present) {
    retained += sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]?.n ?? 0;
  }
  return retained;
}

export function objectRetirementState(sql: SqlStorage): ObjectRetirementState {
  const tombstone = readObjectRetirement(sql);
  return {
    retired: tombstone !== null,
    retiredAt: tombstone?.retiredAt ?? null,
    operationId: tombstone?.operationId ?? null,
    actorUserId: tombstone?.actorUserId ?? null,
    reason: tombstone?.reason ?? null,
    retainedOutbox: countRetainedOutbox(sql),
  };
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: object_retirement/u.test(error.message);
}

export type RetirementDisposition = "permit" | "refuse" | "drop";

/** Builds the terminal acknowledgement a dropped call answers with. */
export type DropResultFactory = (args: readonly unknown[]) => unknown;

/**
 * Permitted on every gated class, by construction rather than by each class
 * remembering to say so.
 *
 * These are the reason retirement can finish at all: the two entry points that
 * write and read the tombstone, the revocation that closes sockets against a
 * dead workspace, the Access-gated operator SQL surface, the promise the
 * constructor already holds, and the schema machinery — a migration is not a
 * product write, and refusing one would dead-letter the forced-migration queue
 * once per retired object, permanently.
 *
 * `runInspectionSql` is not read-only, and the permit is deliberate: it is the
 * repair door (`docs/engineering-mcp.md`), and the one way an operator can
 * inspect or correct what a retired object holds — including the tombstone
 * itself. It is the single path by which a retired object can be written, and
 * `docs/workspace-retirement.md` names it as such.
 *
 * A permit names an *entry point*, and it carries the whole call: see
 * {@link unfencedView}.
 */
export const ALWAYS_PERMITTED_METHODS: readonly string[] = [
  "retireObject",
  "objectRetirementState",
  "revokeSocketAccess",
  "runInspectionSql",
  "migrationsReady",
  "initializeDurableObject",
  "applyMigrations",
  "forceMigration",
];

/**
 * Silently does nothing on a retired object, rather than refusing.
 *
 * These are the alarm coordinator's mutators, and retirement's requirement for
 * them is "never fire again", not "throw". A refusal would be worse in both
 * directions: retirement's own passes call through here to clear what is
 * armed, and a late continuation admitted before the tombstone would turn its
 * re-arm into an error rather than into the nothing it should become. A no-op
 * is the requirement stated exactly — a retired object arms no alarm, and
 * saying so costs nobody a stack trace.
 *
 * Inert wins over permitted: these stay inert even inside retirement's own
 * frame, which is the caller that most needs them not to arm anything.
 */
export const ALWAYS_INERT_METHODS: readonly string[] = [
  "scheduleAlarm",
  "cancelScheduledAlarm",
  "cancelScheduledAlarmKind",
  "reconcileScheduledAlarms",
  "armNextAlarm",
  "ensureAlarmNoLaterThan",
  "armAlarmBeforeDueWork",
  "armAlarmAfterDueWork",
];

/** `null` rather than `undefined`: every inert mutator's answer reads as "nothing armed". */
const INERT: DropResultFactory = () => Promise.resolve(null);
/** `cancelScheduledAlarmKind` answers a count; on a retired object nothing was armed to cancel. */
const INERT_COUNT: DropResultFactory = () => Promise.resolve(0);

export interface RetirementPolicy {
  /** Runs normally on a retired object. Retirement's own machinery and read-only inspection. */
  permit?: readonly string[];
  /** Answers a terminal acknowledgement without applying anything. */
  drop?: Readonly<Record<string, DropResultFactory>>;
}

interface GateHost {
  ctx: { storage: { sql: SqlStorage } };
  migrationsReady?: () => Promise<void>;
}

interface DeclaredPolicy {
  dispositions: Map<string, RetirementDisposition>;
  drops: Record<string, DropResultFactory>;
}

interface ResolvedPolicy {
  disposition: RetirementDisposition | null;
  drop: DropResultFactory | null;
}

const GATED_CLASSES = new WeakMap<object, DeclaredPolicy>();
const RETIRED = new WeakSet<object>();
const NOT_RETIRED = new WeakSet<object>();

/** Wrapper function → what it replaced, so {@link unfencedView} can undo it. */
const WRAPPER_META = new WeakMap<object, { name: string; original: (...args: unknown[]) => unknown }>();

/**
 * The set of names a class exposes as callable, from its own prototype up to
 * but excluding `DurableObject`'s.
 *
 * The stopping point matters: the platform's own base carries the machinery a
 * stub is built from, not this object's surface, and wrapping it would gate
 * the runtime rather than the product.
 */
export function gatedSurface(target: abstract new (...args: never[]) => unknown): readonly string[] {
  const names = new Set<string>();
  let prototype: object | null = target.prototype as object;
  const stop = DurableObject.prototype as object;
  while (prototype && prototype !== stop && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      // A getter is state, not a door; invoking it to classify it would run it.
      if (!descriptor || typeof descriptor.value !== "function") continue;
      names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...names].sort();
}

/**
 * The nearest declaration for one method, walking up from a prototype.
 *
 * Resolved at call time from the *instance's* class rather than baked in when
 * the method was wrapped. A shared base owns most of these methods, so baking
 * the answer meant whichever gated class happened to load first decided it for
 * all its siblings — and a class that permitted a base-owned method left it
 * unwrapped for every sibling that did not. Resolving here makes the runtime
 * agree with {@link retirementDisposition}, which is what the coverage test
 * reads.
 */
function policyFor(startPrototype: object | null, method: string): ResolvedPolicy {
  const memo = POLICY_MEMO;
  if (startPrototype) {
    const cached = memo.get(startPrototype)?.get(method);
    if (cached) return cached;
  }
  let prototype: object | null = startPrototype;
  let gated = false;
  let resolved: ResolvedPolicy = { disposition: null, drop: null };
  const stop = DurableObject.prototype as object;
  while (prototype && prototype !== stop && prototype !== Object.prototype) {
    const declared = GATED_CLASSES.get(prototype);
    if (declared) {
      gated = true;
      const disposition = declared.dispositions.get(method);
      if (disposition) {
        resolved = { disposition, drop: declared.drops[method] ?? null };
        break;
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  if (resolved.disposition === null) resolved = { disposition: gated ? "refuse" : null, drop: null };
  if (startPrototype) {
    let byName = memo.get(startPrototype);
    if (!byName) {
      byName = new Map();
      memo.set(startPrototype, byName);
    }
    byName.set(method, resolved);
  }
  return resolved;
}

/**
 * Memoized {@link policyFor}, per concrete prototype.
 *
 * Discarded whenever a class is gated, because every gate call can change the
 * answer for a base-owned method. All of them run at module load, before any
 * instance exists, so this is thrown away only during startup.
 */
let POLICY_MEMO = new WeakMap<object, Map<string, ResolvedPolicy>>();

/**
 * What retirement does to one method, or `null` if the class is not gated.
 *
 * An unlisted method on a gated class answers `"refuse"` rather than `null`:
 * that is the default, and reporting it as unclassified would make the
 * coverage check demand an entry for every one of WorkspaceDO's methods to say
 * the thing the default already says.
 */
export function retirementDisposition(
  target: abstract new (...args: never[]) => unknown,
  method: string,
): RetirementDisposition | null {
  return policyFor(target.prototype as object, method).disposition;
}

/**
 * Whether the function actually installed for this method is the gate's.
 *
 * `retirementDisposition` reads the declared policy, which is populated before
 * any wrapping happens — so a test built on it alone passes even if the
 * wrapping loop is deleted. This reads the installed function instead, which is
 * the fact that matters.
 */
export function isRetirementGated(
  target: abstract new (...args: never[]) => unknown,
  method: string,
): boolean {
  const owner = findOwner(target.prototype as object, method);
  const installed = owner?.[method];
  return typeof installed === "function" && WRAPPER_META.has(installed);
}

/**
 * Replace every callable method on the class with one that consults the
 * tombstone first.
 *
 * Called once, beside the class definition, so the gate is part of what the
 * class *is* rather than something each entry point remembers. Wrapping the
 * prototype rather than proxying the instance is what makes this work on real
 * workerd: native RPC, `fetch`, `alarm`, and the hibernated socket callbacks
 * are all found as ordinary own properties of a prototype in this chain, and a
 * `Proxy` around the instance is not what the runtime dispatches through.
 *
 * Permitted methods are wrapped too. They have to be: the wrapper is what binds
 * the call to {@link unfencedView}, and leaving them alone would also leave a
 * base-owned method ungated for every sibling class that did not permit it.
 */
export function applyRetirementGate(
  target: abstract new (...args: never[]) => unknown,
  policy: RetirementPolicy = {},
): void {
  const prototype = target.prototype as object;
  const dispositions = new Map<string, RetirementDisposition>();
  const drops: Record<string, DropResultFactory> = {};
  for (const name of ALWAYS_PERMITTED_METHODS) dispositions.set(name, "permit");
  for (const name of ALWAYS_INERT_METHODS) {
    dispositions.set(name, "drop");
    drops[name] = name === "cancelScheduledAlarmKind" ? INERT_COUNT : INERT;
  }
  for (const name of policy.permit ?? []) dispositions.set(name, "permit");
  for (const [name, factory] of Object.entries(policy.drop ?? {})) {
    dispositions.set(name, "drop");
    drops[name] = factory;
  }
  GATED_CLASSES.set(prototype, { dispositions, drops });
  POLICY_MEMO = new WeakMap();

  // A class-specific entry for a method the class does not have is dead policy
  // — a rename, or a receiver that moved — and it reads as coverage that is not
  // there. The universal lists above are exempt: they name methods several of
  // these classes legitimately do not define.
  const missing = [...policy.permit ?? [], ...Object.keys(policy.drop ?? {})]
    .filter((name) => findOwner(prototype, name) === null);
  if (missing.length > 0) {
    throw new Error(`retirement_policy_names_absent_methods: ${missing.sort().join(", ")}`);
  }

  for (const name of gatedSurface(target)) {
    const owner = findOwner(prototype, name);
    if (!owner) continue;
    // Wrap where the method is defined, once. A subclass that inherits it
    // reaches the same wrapped function, and wrapping again would double the
    // check without changing its answer. What the wrapper *does* is resolved
    // per instance, so one wrapper serves classes that classify it differently.
    if (WRAPPER_META.has(owner[name] as object)) continue;
    const original = owner[name] as (...args: unknown[]) => unknown;

    const replacement = function gatedMethod(this: GateHost, ...args: unknown[]): unknown {
      const host = subject(this) as GateHost;
      const { disposition, drop } = policyFor(Object.getPrototypeOf(host) as object, name);
      // A class that never opted in inherited this wrapper from a shared base.
      // It answers before the tombstone read, so gating one class does not put
      // a query in front of every method of an object that is not gated.
      if (disposition === null) return original.apply(this, args);
      // Before the tombstone read, not after: `beginWorkspaceRetirement` writes
      // the tombstone partway through its own body and then goes on calling its
      // helpers. A view handed out only to a call that was already retired at
      // entry would drop that one off the escape halfway down.
      if (disposition === "permit") return original.apply(unfencedView(host), args);
      if (!isRetired(host)) return original.apply(this, args);
      if (disposition === "drop") return (drop ?? INERT)(args);
      throw new RetirementRefusedError(name);
    };
    Object.defineProperty(replacement, "name", { value: name });
    WRAPPER_META.set(replacement, { name, original });
    Object.defineProperty(owner, name, {
      value: replacement,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function findOwner(prototype: object, name: string): Record<string, unknown> | null {
  let current: object | null = prototype;
  const stop = DurableObject.prototype as object;
  while (current && current !== stop && current !== Object.prototype) {
    if (Object.getOwnPropertyDescriptor(current, name)) return current as Record<string, unknown>;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}

const UNFENCED_VIEWS = new WeakMap<object, object>();
const VIEW_TARGETS = new WeakMap<object, object>();

/** The object a call is really against, whether or not it arrived through a view. */
function subject(host: object): object {
  return VIEW_TARGETS.get(host) ?? host;
}

/**
 * The receiver a permitted method runs against: itself, with the gate lifted.
 *
 * A permit is a statement about a *call*, not about a name. `revokeSocketAccess`
 * is permitted on every gated class and its first act is to read the object's
 * own metadata through a private helper; `startRuntimeRecovery` is permitted
 * and reaches a dozen more. Naming each of those helpers in a permit list is
 * what the design originally asked of itself, and it does not work — five were
 * found one at a time, each in production terms a silently broken entry point,
 * and the list can only ever be as complete as the last person to trace a call
 * graph by hand.
 *
 * So the permit travels with the receiver instead. A permitted method is called
 * with a view of the instance whose method lookups return the *originals*, and
 * because `this` inside those originals is the same view, the whole call tree
 * below the entry point is unfenced. Nothing else can reach the view: it is
 * created by the wrapper, passed as `this`, and never stored anywhere a caller
 * could find it. That is the difference between this and the re-entrancy flag
 * the design rejected — a flag is visible to whatever else the runtime admits
 * while the permitted method is awaiting, and a receiver is not.
 *
 * Two things stay true through the view. Inert methods stay inert, so
 * retirement's own passes still arm no alarm. And the instance's identity is
 * preserved for the gate's own bookkeeping, through {@link subject}.
 */
function unfencedView(host: object): object {
  const existing = UNFENCED_VIEWS.get(host);
  if (existing) return existing;
  const view = new Proxy(host, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const meta = WRAPPER_META.get(value);
      if (!meta) return value;
      const { disposition } = policyFor(Object.getPrototypeOf(target as object) as object, meta.name);
      return disposition === "drop" ? value : meta.original;
    },
  });
  UNFENCED_VIEWS.set(host, view);
  VIEW_TARGETS.set(view, host);
  return view;
}

/**
 * Objects still running their constructor's `blockConcurrencyWhile`.
 *
 * Construction is not admission. A retired object still has to be able to
 * build itself — apply migrations, recover its runtime, read the tombstone the
 * gate is about to consult — and gating that path fences the object out of
 * existence rather than out of use.
 *
 * This is safe in a way a general re-entrancy escape would not be, and the
 * reason is the platform's, not ours: `blockConcurrencyWhile` admits no other
 * event, so nothing external can arrive while the flag is set. There is no
 * window for a product call to slip through beside a constructor.
 *
 * What construction must still not do — re-arm an alarm, publish product work —
 * is prevented by those methods being inert rather than by this flag.
 */
const CONSTRUCTING = new WeakMap<object, number>();

/**
 * Depth rather than a flag, because a class may open this window more than
 * once. `AgentLoopDO` applies its schema through one `initializeDurableObject`
 * and recovers its runtime through a second, both from its constructor; with a
 * flag, the first one's `finally` closed the window while the second was still
 * inside it, and recovery refused itself on a private helper.
 */
export function beginObjectConstruction(host: object): void {
  const target = subject(host);
  CONSTRUCTING.set(target, (CONSTRUCTING.get(target) ?? 0) + 1);
}

export function endObjectConstruction(host: object): void {
  const target = subject(host);
  const depth = (CONSTRUCTING.get(target) ?? 0) - 1;
  if (depth > 0) CONSTRUCTING.set(target, depth);
  else CONSTRUCTING.delete(target);
}

/**
 * The constructor's own opening, which no `finally` of its own can match.
 *
 * A constructor body reaches methods directly, before and around whatever it
 * runs under `blockConcurrencyWhile` — the deleted `WorkstreamDO` woke its
 * main substream that way. There is no hook for "the constructor finished", so the opening is
 * released by the first `initializeDurableObject` to settle, which is the last
 * moment the synchronous body can still be running. Idempotent in both
 * directions so a class with several of those releases it exactly once.
 */
const CONSTRUCTOR_WINDOW = new WeakSet<object>();

export function beginConstructorWindow(host: object): void {
  const target = subject(host);
  if (CONSTRUCTOR_WINDOW.has(target)) return;
  CONSTRUCTOR_WINDOW.add(target);
  beginObjectConstruction(target);
}

export function endConstructorWindow(host: object): void {
  const target = subject(host);
  if (!CONSTRUCTOR_WINDOW.delete(target)) return;
  endObjectConstruction(target);
}

/**
 * Whether this object is retired, read once and remembered — both answers.
 *
 * The tombstone is permanent, there is one live instance per object, and this
 * instance is its only writer, so neither answer can go stale under us.
 * Caching only the positive one left a `SELECT` — and, on a class with no such
 * table, a thrown and caught SQLite error — in front of every method call of
 * every Durable Object in the fleet, which is the cost the cache exists to
 * avoid.
 */
function isRetired(host: GateHost): boolean {
  if (CONSTRUCTING.has(host)) return false;
  if (RETIRED.has(host)) return true;
  if (NOT_RETIRED.has(host)) return false;
  const tombstone = readObjectRetirement(host.ctx.storage.sql);
  if (!tombstone) {
    NOT_RETIRED.add(host);
    return false;
  }
  RETIRED.add(host);
  return true;
}

/** Record that this instance just retired itself, so the gate closes now. */
export function markInstanceRetired(host: object): void {
  const target = subject(host);
  NOT_RETIRED.delete(target);
  RETIRED.add(target);
}

/**
 * The acknowledgement a dropped batch answers with: every envelope the caller
 * handed over, named back, so the Queue treats the message as done.
 *
 * It reads the request rather than inventing a shape because both effect
 * receivers key their idempotence off exactly these two fields, and a consumer
 * that gets back fewer ids than it sent will send the rest again.
 */
export function droppedEnvelopeReceipts(
  input: unknown,
): { messageId: string; payloadHash: string }[] {
  const envelopes = (input as { envelopes?: unknown } | undefined)?.envelopes;
  if (!Array.isArray(envelopes)) return [];
  return envelopes.flatMap((envelope) => {
    const { messageId, payloadHash } = (envelope ?? {}) as Record<string, unknown>;
    return typeof messageId === "string" && typeof payloadHash === "string"
      ? [{ messageId, payloadHash }]
      : [];
  });
}

/**
 * How an HTTP or socket-upgrade door refuses.
 *
 * 409 rather than 404 or 410: the object is reachable and the request was
 * understood, and it is the state of the workspace that makes it inadmissible.
 * A caller reading this can tell a retired workspace from a routing mistake.
 */
export function retiredObjectResponse(): Response {
  return new Response(JSON.stringify({ error: RETIREMENT_REFUSAL_CODE, message: RETIREMENT_REFUSAL_MESSAGE }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
}
