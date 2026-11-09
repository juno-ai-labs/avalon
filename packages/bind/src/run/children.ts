/**
 * Child runs: lineage, admission, and waiting.
 *
 * A sub-agent is not a special kind of thing — it is **a run that another run
 * asked for**. Everything the harness already gives a run applies to it
 * unchanged: its own deadline, its own heartbeat, its own stats, its own route
 * plan. What is genuinely new is the relationship between runs, and that is
 * what this module owns:
 *
 *  - **Lineage** — where a run sits in the chain that produced it.
 *  - **Admission** — whether the next child may be created at all.
 *  - **Waiting** — how long to sleep before checking on a child again.
 *
 * All three are pure. The queue, the persistence, the counting, and the choice
 * of bounds stay with the host: the harness decides, it does not measure. That
 * split is deliberate — counting runs needs a database, and deciding whether a
 * count is too high does not.
 */

/**
 * A run's position in the chain that spawned it.
 *
 * `rootRunId` and `parentRunId` are `null` at depth 0, where the run *is* the
 * root — a chain's origin has no id to point at until its own row exists, so
 * the convention is "null means me". Read the root of any chain as
 * `chain.rootRunId ?? thisRunId`; {@link descendChain} does exactly that when
 * it hands the id down, so every descendant carries a concrete root.
 */
export interface ChainRef {
  /** 0 for a run nobody spawned; one more than its parent otherwise. */
  readonly depth: number;
  /** The run that started the chain, or `null` when this run is that run. */
  readonly rootRunId: string | null;
  /** The run that spawned this one, or `null` when nothing did. */
  readonly parentRunId: string | null;
}

/** The lineage of a run that nothing spawned — the origin of a new chain. */
export function rootChain(): ChainRef {
  return { depth: 0, rootRunId: null, parentRunId: null };
}

/**
 * The lineage a child of `parentRunId` should carry.
 *
 * The root-id fallback is the part hosts get wrong: a depth-1 child must adopt
 * its parent's *id* as the root (the parent's own `rootRunId` is null), while a
 * depth-2 grandchild must adopt the root the parent already carries. Getting it
 * backwards makes each generation start a fresh chain, which silently defeats
 * every per-chain bound — the counts stay small because they count the wrong
 * set.
 */
export function descendChain(
  parentRunId: string,
  // Only what the arithmetic reads, so a host storing lineage as flat columns
  // can pass the two it has rather than assembling a whole `ChainRef` around a
  // field this never looks at.
  parent: Pick<ChainRef, "depth" | "rootRunId">,
): ChainRef {
  return {
    depth: parent.depth + 1,
    rootRunId: parent.rootRunId ?? parentRunId,
    parentRunId,
  };
}

/**
 * One admission rule, carrying its limit and the measurement it applies to.
 *
 * Limit and fact travel together on purpose. The alternative — a bounds object
 * beside a facts object — lets a host configure a bound whose count was never
 * wired up, and the only symptom is a limit that silently never fires. Here a
 * rule cannot be expressed without the number it judges, so a host pays only
 * for what it actually measures and cannot ask for a bound it does not feed.
 */
export type ChainRule =
  /**
   * How deep the chain may go. `parentDepth` is the spawning run's own depth,
   * so the child would sit at `parentDepth + 1`; the rule rejects once that
   * would reach `maxDepth`. A `maxDepth` of 5 therefore permits depths 0
   * through 4 — five runs deep counting the root.
   */
  | { kind: "depth"; parentDepth: number; maxDepth: number }
  /**
   * Total runs one chain may produce. Caps the spend of a chain that stays
   * shallow but keeps fanning out, which a depth bound alone does not touch.
   */
  | { kind: "chain_budget"; runsInChain: number; maxRuns: number }
  /**
   * Minimum spacing between spawns from the same parent, which is what stops
   * two runs ping-ponging work at each other. `msSinceLastSpawn` is `null` when
   * this parent has not spawned before — always admitted.
   */
  | { kind: "pair_cooldown"; msSinceLastSpawn: number | null; cooldownMs: number }
  /**
   * Whether this parent→child pair has *already* run, at all, within whatever
   * scope the host measured over. The stronger sibling of
   * `pair_cooldown`: a cooldown lets a pair repeat once enough time passes,
   * while this permits the pair exactly once and never again.
   *
   * Reach for it where a repeat is not slow but wrong — two agents that answer
   * each other are a loop whose every hop looks individually reasonable, and a
   * time-based bound only makes such a loop cheaper per hour rather than
   * ending it.
   *
   * The scope is the host's to choose and is deliberately not modelled here:
   * "already paired in this chain" and "already paired in this conversation"
   * are the same rule over different measurements, and naming either one would
   * put a product's containment vocabulary into the harness.
   */
  | { kind: "pair_seen"; alreadyPaired: boolean }
  /**
   * A ceiling on concurrent runs for the whole tenant. Worth having alongside
   * the chain rules: depth and chain budgets constrain one lineage, and neither
   * stops someone starting a thousand independent ones.
   */
  | { kind: "tenant_ceiling"; activeRuns: number; maxActiveRuns: number }
  /**
   * How many runs a tenant may *start* within a rolling window, as opposed to
   * how many may be in flight at once (`tenant_ceiling`).
   *
   * The two bound different abuses and neither implies the other. A ceiling
   * caps concurrency, so a caller that starts and finishes runs quickly slips
   * under it indefinitely — a message flood, or one fan-out across a large
   * group, is exactly that shape. A rate caps total starts, so it bounds spend
   * where the ceiling bounds load.
   *
   * `windowMs` is carried only so the refusal can say how long the wait is;
   * the rule does not roll the window itself. The host measures over whatever
   * window it chose and passes both.
   */
  | {
      kind: "tenant_rate";
      runsInWindow: number;
      maxRuns: number;
      windowMs: number;
    };

export type ChildAdmission =
  | { admitted: true }
  | {
      admitted: false;
      /** Which rule refused, for metrics and for branching. */
      rule: ChainRule["kind"];
      /**
       * Could waiting change this answer?
       *
       * The rules are not all the same kind of refusal, and prose alone does
       * not separate them: a cooldown or a rolling window clears on its own, a
       * spent chain budget or a repeated pair never does. Without this a model reads "refused" and has to guess
       * between waiting and giving up — and guessing wrong either wastes the
       * run on retries into the same wall or abandons work it could have done
       * a moment later.
       */
      retryable: boolean;
      /**
       * Why, in prose, for the model to read as a tool error. Names the limit,
       * the measurement, and what to do instead — a refusal that reports only
       * the failure invites a retry into the identical wall.
       */
      reason: string;
    };

/**
 * Decide whether one more child run may be created.
 *
 * Evaluated in the order given, first refusal wins, so a host controls which
 * reason the model sees when several apply. An empty rule list admits — this
 * function bounds what it is given and claims nothing about what it is not.
 *
 * **When a measurement fails, omit the rule — do not pass a sentinel.** The
 * two failure postures here answer different questions and are easy to
 * conflate. A rule whose number arrived broken (`NaN`, negative) refuses,
 * because a nonsense count is not evidence of safety. A rule you could not
 * measure at all — the count query threw, the store was unreachable — is
 * absent, and absence admits. That is a deliberate seam, not an oversight:
 * whether a transient infrastructure failure should stop all work or let it
 * through is an availability judgement about a specific product, and this
 * function has no standing to make it. Decide it at the call site, in a
 * `catch`, by choosing whether to append the rule. Passing `NaN` or `-1` to
 * mean "unknown" inverts the answer you almost certainly want.
 *
 * **Call before enqueuing, never after.** A chain that is bounded only once its
 * runs are already queued is not bounded; it is billed.
 *
 * **This is the decision, not the claim.** A counted rule (`chain_budget`,
 * `tenant_ceiling`) bounds only as tightly as the host's count is atomic with
 * the create. Two spawners that read the same count both admit — two replicas,
 * or two spawn calls in one assistant batch, which the tool loop fans out
 * concurrently. If you need the bound to hold under concurrency, take a lock or
 * use a conditional insert around count-then-create; this function cannot see
 * the race and will not tell you about it.
 *
 * A non-finite number anywhere in a rule — the measurement or the limit —
 * refuses rather than admits. Comparisons against `NaN` are always false, so
 * the natural reading of every rule below would silently admit, turning a
 * broken count or a misread config into an unbounded chain. That is the one
 * failure this function exists to prevent, so it fails toward refusing.
 */
export function admitChildRun(rules: readonly ChainRule[]): ChildAdmission {
  for (const rule of rules) {
    const refusal = evaluateRule(rule);
    if (refusal !== null) return refusal;
  }
  return { admitted: true };
}

function evaluateRule(rule: ChainRule): ChildAdmission | null {
  switch (rule.kind) {
    case "depth": {
      const broken =
        unmeasurable(rule, rule.parentDepth, "parentDepth") ??
        unmeasurable(rule, rule.maxDepth, "maxDepth");
      if (broken) return broken;
      const childDepth = rule.parentDepth + 1;
      return childDepth >= rule.maxDepth
        ? refuse(
            rule,
            false,
            `chain depth limit reached (${childDepth}/${rule.maxDepth}) — ` +
              `as far as work may be handed on, and waiting will not change ` +
              `that; do this work here rather than delegating again`,
          )
        : null;
    }
    case "chain_budget": {
      const broken =
        unmeasurable(rule, rule.runsInChain, "runsInChain") ??
        unmeasurable(rule, rule.maxRuns, "maxRuns");
      if (broken) return broken;
      return rule.runsInChain >= rule.maxRuns
        ? refuse(
            rule,
            false,
            `chain run budget exhausted (${rule.runsInChain}/${rule.maxRuns}) — ` +
              `spent for this whole chain and it does not refill, so do this ` +
              `work here rather than delegating again`,
          )
        : null;
    }
    case "pair_cooldown": {
      if (rule.msSinceLastSpawn === null) return null;
      const broken =
        unmeasurable(rule, rule.msSinceLastSpawn, "msSinceLastSpawn") ??
        unmeasurable(rule, rule.cooldownMs, "cooldownMs");
      if (broken) return broken;
      return rule.msSinceLastSpawn < rule.cooldownMs
        ? refuse(
            rule,
            true,
            `handoff cooldown active — retry in ` +
              `${rule.cooldownMs - rule.msSinceLastSpawn}ms, or do this work ` +
              `here (${rule.msSinceLastSpawn}ms since the last handoff, ` +
              `${rule.cooldownMs}ms required)`,
          )
        : null;
    }
    case "pair_seen": {
      // A boolean carries no measurement to validate — the host either
      // observed the prior pairing or it did not.
      return rule.alreadyPaired
        ? refuse(
            rule,
            false,
            `repeat handoff refused — these two have already worked together ` +
              `here and are allowed to only once, so waiting will not change ` +
              `that; do this work here instead`,
          )
        : null;
    }
    case "tenant_ceiling": {
      const broken =
        unmeasurable(rule, rule.activeRuns, "activeRuns") ??
        unmeasurable(rule, rule.maxActiveRuns, "maxActiveRuns");
      if (broken) return broken;
      return rule.activeRuns >= rule.maxActiveRuns
        ? refuse(
            rule,
            true,
            `concurrent run ceiling reached (${rule.activeRuns}/` +
              `${rule.maxActiveRuns}) — clears as other runs finish, so retry ` +
              `shortly or do this work here`,
          )
        : null;
    }
    case "tenant_rate": {
      const broken =
        unmeasurable(rule, rule.runsInWindow, "runsInWindow") ??
        unmeasurable(rule, rule.maxRuns, "maxRuns") ??
        unmeasurable(rule, rule.windowMs, "windowMs");
      if (broken) return broken;
      return rule.runsInWindow >= rule.maxRuns
        ? refuse(
            rule,
            true,
            `start-rate limit reached (${rule.runsInWindow}/${rule.maxRuns} ` +
              `runs in the last ${rule.windowMs}ms) — the window rolls, so ` +
              `wait up to ${rule.windowMs}ms and retry, or do this work here`,
          )
        : null;
    }
    default: {
      const _exhaustive: never = rule;
      throw new Error(`Unhandled chain rule: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

const refuse = (
  rule: ChainRule,
  retryable: boolean,
  reason: string,
): ChildAdmission => ({
  admitted: false,
  rule: rule.kind,
  retryable,
  reason,
});

/**
 * Every number a rule carries must be a finite, non-negative count — the
 * measurement AND the limit.
 *
 * The limit matters as much as the count and for the same reason: every
 * comparison below is `<` or `>=`, both false against `NaN`, so a `maxDepth`
 * that arrived as `NaN` (a bad config read, an `undefined` coerced by
 * arithmetic) leaves the chain unbounded with nothing to show for it.
 *
 * Negatives are rejected on the same grounds rather than as a style rule. No
 * depth, count, or elapsed span can legitimately be below zero, so a negative
 * means the host's bookkeeping is wrong — and the result is not a *stricter*
 * bound but no bound at all: `runsInChain: -1` against `maxRuns: 10` admits,
 * and keeps admitting. To express "no cooldown", omit the rule rather than
 * passing a negative one.
 *
 * A rule that cannot be evaluated refuses, because "we could not check" and
 * "it is fine" are not the same answer.
 */
const unmeasurable = (
  rule: ChainRule,
  value: number,
  field: string,
): ChildAdmission | null =>
  Number.isFinite(value) && value >= 0
    ? null
    : // A noun phrase, like every other reason, so it still reads correctly
      // when a host prefixes it ("Sub-agent chain bound unreadable…"). A verb
      // phrase here would invert the actor and read as though the child were
      // the one refusing.
      refuse(
        rule,
        false,
        `chain bound unreadable (${field} is ${value}) — a misconfiguration, ` +
          `not a limit that clears, so do the work in this run rather than ` +
          `retrying`,
      );

/**
 * What a poller should do next while waiting on a child run.
 *
 * `wait` is already clamped to whatever budget remains, so sleeping for it can
 * never overshoot the deadline — the next call returns `expired` instead.
 */
export type PollStep =
  | { kind: "wait"; delayMs: number }
  | { kind: "expired"; waitedMs: number };

export interface PollScheduleOptions {
  /** First delay. Clamped to at least `minDelayMs` and at most `maxDelayMs`. */
  readonly initialDelayMs: number;
  /** Ceiling the doubling backoff climbs to. */
  readonly maxDelayMs: number;
  /** Total wall-clock the poll may consume before giving up. */
  readonly budgetMs: number;
  /**
   * Floor on any single delay, defaulting to 50ms — which is the real guard
   * against an `initialDelayMs` of 0 turning the poll into a busy loop.
   *
   * Setting it explicitly *lowers* that guard: the hard floor is 1ms, so
   * `minDelayMs: 0` yields 1ms rather than the default. That is deliberate — a
   * host asking for a sub-50ms poll gets one — but it means passing 0 to mean
   * "no floor" gives you the tightest loop this module allows, not the safest.
   *
   * If this exceeds `maxDelayMs`, the floor wins and the ceiling is raised to
   * match: a delay below the floor would defeat the busy-loop guard, while one
   * above the ceiling only polls less often.
   */
  readonly minDelayMs?: number;
  // Every option above must be finite; `createPollSchedule` throws otherwise.
  // A negative `budgetMs` is legal and means "no time left" — the first step
  // expires.
}

export interface PollSchedule {
  /**
   * The next step, given how long the poll has been running. Elapsed time is an
   * argument rather than something read from a clock, which keeps this pure and
   * lets a test drive the whole backoff without waiting for any of it.
   *
   * A schedule carries the backoff state for **one** wait and advances on every
   * call, so it is not shareable between concurrent waiters — build one per
   * wait, which is cheap. Two schedules from identical options are fully
   * independent.
   */
  next(elapsedMs: number): PollStep;
}

function requireFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `createPollSchedule: ${field} must be a finite number, got ${value}.`,
    );
  }
}

/**
 * A doubling backoff bounded by a total budget.
 *
 * Polling a child run is the alternative to suspending the parent and letting
 * completion wake it. It keeps the parent's transcript intact but holds its
 * worker slot for the duration — so the budget belongs well under the parent's
 * own deadline, or the parent dies waiting instead of reporting what it learned.
 */
export function createPollSchedule(options: PollScheduleOptions): PollSchedule {
  // Rejected at construction, not clamped. `Math.min`/`Math.max` propagate
  // `NaN`, so one non-finite option reaches the caller as `sleep(NaN)` — which
  // fires immediately and turns the poll into a busy loop. A non-finite
  // `budgetMs` is worse still: `NaN <= 0` is false, so it also never expires.
  //
  // Unlike a bad measurement in `admitChildRun`, which has a safe answer
  // (refuse), a bad *option* here has none — there is no way to guess the
  // budget that was meant. Substituting a default would hide the caller's bug
  // behind a poll nobody configured, so this throws at the call that made the
  // mistake rather than inside the loop that inherits it.
  requireFinite(options.initialDelayMs, "initialDelayMs");
  requireFinite(options.maxDelayMs, "maxDelayMs");
  requireFinite(options.budgetMs, "budgetMs");
  if (options.minDelayMs !== undefined) {
    requireFinite(options.minDelayMs, "minDelayMs");
  }

  const minDelayMs = Math.max(1, options.minDelayMs ?? 50);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs);
  // Snapshot, not read live: the guards above run once, so a host that mutates
  // its options object afterwards would otherwise walk a `NaN` budget straight
  // past them on the next call.
  const budgetMs = options.budgetMs;
  let delayMs = Math.min(Math.max(options.initialDelayMs, minDelayMs), maxDelayMs);

  return {
    next(elapsedMs) {
      // The options are validated at construction; this is the one number that
      // arrives per call, and it fails the same way — `NaN <= 0` is false, so a
      // bad elapsed never expires, and it poisons the delay into `sleep(NaN)`.
      // A host computing `Date.now() - new Date(row.started_at).getTime()`
      // against an unparsed timestamp string produces exactly that.
      //
      // Expires rather than throws: unlike a bad option there IS a safe reading
      // here — we cannot tell how long this has been running, so stop waiting.
      if (!Number.isFinite(elapsedMs)) {
        return { kind: "expired", waitedMs: budgetMs };
      }
      const remainingMs = budgetMs - elapsedMs;
      if (remainingMs <= 0) return { kind: "expired", waitedMs: elapsedMs };
      // Clamped to what is left, so the caller cannot sleep past its own
      // budget and report a timeout later than the one it promised.
      const step = Math.min(delayMs, remainingMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      return { kind: "wait", delayMs: step };
    },
  };
}
