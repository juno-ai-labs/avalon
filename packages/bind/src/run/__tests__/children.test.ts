/**
 * Unit tests for child-run lineage, admission, and poll scheduling.
 *
 * All three are pure, so these tests are the specification: no queue, no clock,
 * no database. The cases that matter are the ones whose failure is silent —
 * a chain that never counts as one chain, a bound that admits because its
 * measurement was broken, a poll that sleeps past the deadline it promised.
 */
import { describe, expect, test } from "vitest";
import {
  admitChildRun,
  createPollSchedule,
  descendChain,
  rootChain,
  type ChainRule,
} from "../children";

describe("chain lineage", () => {
  test("a run nothing spawned is its own root", () => {
    expect(rootChain()).toEqual({ depth: 0, rootRunId: null, parentRunId: null });
  });

  test("a first-generation child adopts its parent's id as the root", () => {
    // The parent's own `rootRunId` is null — it IS the root — so the child has
    // to take the id instead.
    expect(descendChain("run-a", rootChain())).toEqual({
      depth: 1,
      rootRunId: "run-a",
      parentRunId: "run-a",
    });
  });

  test("later generations keep the original root, not their parent's id", () => {
    // The failure this guards: adopting the parent's id at every level makes
    // each generation its own chain, so every per-chain bound counts the wrong
    // set and never fires.
    const child = descendChain("run-a", rootChain());
    const grandchild = descendChain("run-b", child);
    const greatGrandchild = descendChain("run-c", grandchild);

    expect(grandchild).toEqual({
      depth: 2,
      rootRunId: "run-a",
      parentRunId: "run-b",
    });
    expect(greatGrandchild).toEqual({
      depth: 3,
      rootRunId: "run-a",
      parentRunId: "run-c",
    });
  });

  test("depth counts generations from the root", () => {
    let chain = rootChain();
    for (let i = 0; i < 10; i++) chain = descendChain(`run-${i}`, chain);
    expect(chain.depth).toBe(10);
    expect(chain.rootRunId).toBe("run-0");
  });
});

describe("admitChildRun", () => {
  test("no rules admits — it bounds what it is given, nothing more", () => {
    expect(admitChildRun([])).toEqual({ admitted: true });
  });

  describe("depth", () => {
    const depth = (parentDepth: number): ChainRule => ({
      kind: "depth",
      parentDepth,
      maxDepth: 5,
    });

    test("admits while the child would stay under the limit", () => {
      expect(admitChildRun([depth(0)])).toEqual({ admitted: true });
      expect(admitChildRun([depth(3)])).toEqual({ admitted: true });
    });

    test("refuses at the boundary — maxDepth 5 permits depths 0 through 4", () => {
      const result = admitChildRun([depth(4)]);
      expect(result.admitted).toBe(false);
      expect(result).toMatchObject({ rule: "depth" });
      if (!result.admitted) expect(result.reason).toContain("(5/5)");
    });

    test("refuses beyond the boundary", () => {
      expect(admitChildRun([depth(9)]).admitted).toBe(false);
    });
  });

  describe("chain_budget", () => {
    test("caps a chain that stays shallow but keeps fanning out", () => {
      // Depth alone never sees this: fifty siblings all sit at depth 1.
      const rule = (runsInChain: number): ChainRule => ({
        kind: "chain_budget",
        runsInChain,
        maxRuns: 50,
      });
      expect(admitChildRun([rule(49)]).admitted).toBe(true);
      const result = admitChildRun([rule(50)]);
      expect(result).toMatchObject({ admitted: false, rule: "chain_budget" });
      if (!result.admitted) expect(result.reason).toContain("(50/50)");
    });
  });

  describe("pair_cooldown", () => {
    const rule = (msSinceLastSpawn: number | null): ChainRule => ({
      kind: "pair_cooldown",
      msSinceLastSpawn,
      cooldownMs: 1000,
    });

    test("admits a parent that has never spawned", () => {
      expect(admitChildRun([rule(null)])).toEqual({ admitted: true });
    });

    test("refuses inside the window and admits once it has elapsed", () => {
      expect(admitChildRun([rule(999)])).toMatchObject({
        admitted: false,
        rule: "pair_cooldown",
      });
      expect(admitChildRun([rule(1000)])).toEqual({ admitted: true });
      expect(admitChildRun([rule(5000)])).toEqual({ admitted: true });
    });
  });

  describe("pair_seen", () => {
    const rule = (alreadyPaired: boolean): ChainRule => ({
      kind: "pair_seen",
      alreadyPaired,
    });

    test("admits a pair that has not run in the measured scope", () => {
      expect(admitChildRun([rule(false)])).toEqual({ admitted: true });
    });

    test("refuses a repeat, and says waiting will not help", () => {
      const admission = admitChildRun([rule(true)]);
      expect(admission).toMatchObject({ admitted: false, rule: "pair_seen" });
      // The distinction from `pair_cooldown`: a cooldown clears on its own, a
      // seen-pair never does. A model that reads "refused" and retries into
      // the identical wall has wasted the run.
      if (admission.admitted) throw new Error("expected a refusal");
      expect(admission.retryable).toBe(false);
    });

    test("is stricter than pair_cooldown for the same pair", () => {
      // A pair well past its cooldown is admitted by one rule and refused by
      // the other — which is the whole reason both exist.
      const pastCooldown: ChainRule = {
        kind: "pair_cooldown",
        msSinceLastSpawn: 60_000,
        cooldownMs: 1_000,
      };
      expect(admitChildRun([pastCooldown])).toEqual({ admitted: true });
      expect(admitChildRun([pastCooldown, rule(true)]).admitted).toBe(false);
    });

  });

  describe("no refusal carries an identifier", () => {
    // Reasons reach member-visible surfaces on some hosts, so no rule may
    // interpolate anything id-shaped. Covering EVERY kind here is free (these
    // are pure) and is the only place all six are checked at once.
    const refusing: ChainRule[] = [
      { kind: "depth", parentDepth: 9, maxDepth: 5 },
      { kind: "chain_budget", runsInChain: 500, maxRuns: 500 },
      { kind: "pair_cooldown", msSinceLastSpawn: 10, cooldownMs: 5_000 },
      { kind: "pair_seen", alreadyPaired: true },
      { kind: "tenant_ceiling", activeRuns: 100, maxActiveRuns: 100 },
      { kind: "tenant_rate", runsInWindow: 100, maxRuns: 100, windowMs: 30_000 },
      // The unmeasurable path words its own refusal too.
      { kind: "depth", parentDepth: Number.NaN, maxDepth: 5 },
    ];

    for (const rule of refusing) {
      test(`${rule.kind} reason is identifier-free and non-empty`, () => {
        const admission = admitChildRun([rule]);
        if (admission.admitted) throw new Error("expected a refusal");
        expect(admission.reason.length).toBeGreaterThan(0);
        // A prefixed-id shape (`usr_…`, `agrun_…`, `thr_…`). Deliberately not a
        // `\b`-anchored alternation: `\brun_` cannot match inside `agrun_`.
        expect(admission.reason).not.toMatch(
          /(?<![A-Za-z0-9])[a-z]{2,6}_[A-Za-z0-9]{4,}/,
        );
      });
    }

    test("every refusal leads with a noun phrase, so a host may prefix it", () => {
      // Hosts render these as e.g. `Sub-agent ${reason}`. A reason opening with
      // a demonstrative ("this pair has already…") reads as broken English once
      // prefixed, which is how it reaches a member.
      for (const rule of refusing) {
        const admission = admitChildRun([rule]);
        if (admission.admitted) throw new Error("expected a refusal");
        expect(admission.reason).not.toMatch(/^(this|these|the|it|they)\b/i);
      }
    });
  });

  describe("tenant_rate", () => {
    const rule = (runsInWindow: number): ChainRule => ({
      kind: "tenant_rate",
      runsInWindow,
      maxRuns: 100,
      windowMs: 30_000,
    });

    test("bounds starts where tenant_ceiling bounds concurrency", () => {
      expect(admitChildRun([rule(99)])).toEqual({ admitted: true });
      expect(admitChildRun([rule(100)])).toMatchObject({
        admitted: false,
        rule: "tenant_rate",
      });
    });

    test("a burst that finishes fast slips a ceiling but not a rate", () => {
      // The shape this rule exists for: a message flood or a large group
      // fan-out starts many runs that each end quickly, so concurrency stays
      // low the whole time and a ceiling never fires.
      const ceiling: ChainRule = {
        kind: "tenant_ceiling",
        activeRuns: 2,
        maxActiveRuns: 100,
      };
      expect(admitChildRun([ceiling])).toEqual({ admitted: true });
      expect(admitChildRun([ceiling, rule(100)]).admitted).toBe(false);
    });

    test("says how long the wait is, and that it is a wait", () => {
      const admission = admitChildRun([rule(100)]);
      if (admission.admitted) throw new Error("expected a refusal");
      expect(admission.retryable).toBe(true);
      expect(admission.reason).toContain("30000ms");
    });
  });

  describe("tenant_ceiling", () => {
    test("bounds what the chain rules cannot — many independent chains", () => {
      const rule = (activeRuns: number): ChainRule => ({
        kind: "tenant_ceiling",
        activeRuns,
        maxActiveRuns: 100,
      });
      expect(admitChildRun([rule(99)]).admitted).toBe(true);
      expect(admitChildRun([rule(100)])).toMatchObject({
        admitted: false,
        rule: "tenant_ceiling",
      });
    });
  });

  describe("a broken measurement refuses rather than admits", () => {
    // Every rule compares with `<` or `>=`, and both are false against NaN —
    // so the natural reading would silently admit and leave the chain
    // unbounded, which is the one outcome this function exists to prevent.
    const broken: ChainRule[] = [
      { kind: "depth", parentDepth: Number.NaN, maxDepth: 5 },
      { kind: "chain_budget", runsInChain: Number.NaN, maxRuns: 50 },
      { kind: "pair_cooldown", msSinceLastSpawn: Number.NaN, cooldownMs: 1000 },
      { kind: "tenant_ceiling", activeRuns: Number.NaN, maxActiveRuns: 100 },
      {
        kind: "tenant_rate",
        runsInWindow: Number.NaN,
        maxRuns: 100,
        windowMs: 30_000,
      },
    ];

    for (const rule of broken) {
      test(`${rule.kind} refuses on NaN`, () => {
        const result = admitChildRun([rule]);
        expect(result).toMatchObject({ admitted: false, rule: rule.kind });
        if (!result.admitted) expect(result.reason).toContain("NaN");
      });
    }

    test("Infinity refuses too", () => {
      expect(
        admitChildRun([
          { kind: "chain_budget", runsInChain: Number.POSITIVE_INFINITY, maxRuns: 50 },
        ]).admitted,
      ).toBe(false);
    });

    // A broken LIMIT is as dangerous as a broken count and fails the same way:
    // `>=` and `<` are both false against NaN, so a misread config would leave
    // the chain unbounded with nothing to show for it.
    const brokenLimits: ChainRule[] = [
      { kind: "depth", parentDepth: 3, maxDepth: Number.NaN },
      { kind: "chain_budget", runsInChain: 10, maxRuns: Number.NaN },
      { kind: "pair_cooldown", msSinceLastSpawn: 10, cooldownMs: Number.NaN },
      { kind: "tenant_ceiling", activeRuns: 10, maxActiveRuns: Number.NaN },
      { kind: "tenant_rate", runsInWindow: 10, maxRuns: Number.NaN, windowMs: 30_000 },
      // The window is a limit too — a NaN window would print as the wait a
      // caller is told to observe.
      { kind: "tenant_rate", runsInWindow: 10, maxRuns: 100, windowMs: Number.NaN },
    ];

    for (const rule of brokenLimits) {
      test(`${rule.kind} refuses on a non-finite LIMIT, not just a bad count`, () => {
        const result = admitChildRun([rule]);
        expect(result).toMatchObject({ admitted: false, rule: rule.kind });
      });
    }

    test("a broken cooldown limit still admits a parent that never spawned", () => {
      // `msSinceLastSpawn: null` short-circuits before any comparison, so there
      // is nothing to get wrong — and nothing to refuse.
      expect(
        admitChildRun([
          { kind: "pair_cooldown", msSinceLastSpawn: null, cooldownMs: Number.NaN },
        ]),
      ).toEqual({ admitted: true });
    });
  });

  describe("evaluation order", () => {
    const overBudget: ChainRule = {
      kind: "chain_budget",
      runsInChain: 99,
      maxRuns: 50,
    };
    const tooDeep: ChainRule = { kind: "depth", parentDepth: 9, maxDepth: 5 };

    test("the first refusal wins, so the host picks the reason the model sees", () => {
      expect(admitChildRun([tooDeep, overBudget])).toMatchObject({ rule: "depth" });
      expect(admitChildRun([overBudget, tooDeep])).toMatchObject({
        rule: "chain_budget",
      });
    });

    test("every rule must pass, not just one", () => {
      expect(
        admitChildRun([
          { kind: "depth", parentDepth: 0, maxDepth: 5 },
          { kind: "pair_cooldown", msSinceLastSpawn: null, cooldownMs: 1000 },
          overBudget,
        ]).admitted,
      ).toBe(false);
    });
  });
});

describe("createPollSchedule", () => {
  test("doubles the delay up to the ceiling", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 100,
      maxDelayMs: 800,
      budgetMs: 60_000,
    });
    const delays = [0, 100, 300, 700, 1500, 3100].map((elapsed) => {
      const step = schedule.next(elapsed);
      return step.kind === "wait" ? step.delayMs : step.kind;
    });
    expect(delays).toEqual([100, 200, 400, 800, 800, 800]);
  });

  test("clamps the last delay so a sleep cannot overshoot the budget", () => {
    // The bug this prevents: sleeping the full backoff with 50ms left reports a
    // timeout hundreds of ms after the deadline the caller promised.
    const schedule = createPollSchedule({
      initialDelayMs: 1000,
      maxDelayMs: 1000,
      budgetMs: 1200,
    });
    expect(schedule.next(0)).toEqual({ kind: "wait", delayMs: 1000 });
    expect(schedule.next(1000)).toEqual({ kind: "wait", delayMs: 200 });
  });

  test("expires once the budget is spent", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 100,
      maxDelayMs: 100,
      budgetMs: 500,
    });
    expect(schedule.next(499).kind).toBe("wait");
    expect(schedule.next(500)).toEqual({ kind: "expired", waitedMs: 500 });
    expect(schedule.next(900)).toEqual({ kind: "expired", waitedMs: 900 });
  });

  test("a zero budget expires immediately rather than polling once", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 100,
      maxDelayMs: 100,
      budgetMs: 0,
    });
    expect(schedule.next(0)).toEqual({ kind: "expired", waitedMs: 0 });
  });

  test("floors the delay so a zero interval is not a busy loop", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 0,
      maxDelayMs: 0,
      budgetMs: 10_000,
    });
    const step = schedule.next(0);
    expect(step).toEqual({ kind: "wait", delayMs: 50 });
  });

  test("respects a caller-supplied floor", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 1,
      maxDelayMs: 5_000,
      budgetMs: 60_000,
      minDelayMs: 250,
    });
    expect(schedule.next(0)).toEqual({ kind: "wait", delayMs: 250 });
  });

  test("an initial delay above the ceiling is clamped down to it", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 10_000,
      maxDelayMs: 1_000,
      budgetMs: 60_000,
    });
    expect(schedule.next(0)).toEqual({ kind: "wait", delayMs: 1_000 });
  });

  describe("rejects a non-finite option at construction", () => {
    // Math.min/max propagate NaN, so one bad option reaches the caller as
    // `sleep(NaN)` — which fires immediately and turns the poll into a busy
    // loop. A NaN budget is worse: `NaN <= 0` is false, so it never expires
    // either. Unlike a bad measurement in `admitChildRun` there is no safe
    // answer to substitute — no way to guess the budget that was meant — so
    // this throws at the caller that made the mistake.
    const base = { initialDelayMs: 100, maxDelayMs: 1_000, budgetMs: 60_000 };

    test("initialDelayMs", () => {
      expect(() => createPollSchedule({ ...base, initialDelayMs: Number.NaN })).toThrow(
        /initialDelayMs must be a finite number/,
      );
    });

    test("maxDelayMs", () => {
      expect(() => createPollSchedule({ ...base, maxDelayMs: Number.NaN })).toThrow(
        /maxDelayMs must be a finite number/,
      );
    });

    test("budgetMs — the one that would never expire", () => {
      expect(() => createPollSchedule({ ...base, budgetMs: Number.NaN })).toThrow(
        /budgetMs must be a finite number/,
      );
      expect(() =>
        createPollSchedule({ ...base, budgetMs: Number.POSITIVE_INFINITY }),
      ).toThrow(/budgetMs must be a finite number/);
    });

    test("minDelayMs, when supplied", () => {
      expect(() =>
        createPollSchedule({ ...base, minDelayMs: Number.NaN }),
      ).toThrow(/minDelayMs must be a finite number/);
      // Omitted is fine — it defaults.
      expect(() => createPollSchedule(base)).not.toThrow();
    });
  });

  test("a negative budget expires rather than throwing — no time left is a state, not a bug", () => {
    const schedule = createPollSchedule({
      initialDelayMs: 100,
      maxDelayMs: 100,
      budgetMs: -5,
    });
    expect(schedule.next(0)).toEqual({ kind: "expired", waitedMs: 0 });
  });

  test("two schedules from one factory call do not share backoff state", () => {
    const options = { initialDelayMs: 100, maxDelayMs: 800, budgetMs: 60_000 };
    const a = createPollSchedule(options);
    const b = createPollSchedule(options);
    a.next(0);
    a.next(0);
    expect(b.next(0)).toEqual({ kind: "wait", delayMs: 100 });
  });
});
