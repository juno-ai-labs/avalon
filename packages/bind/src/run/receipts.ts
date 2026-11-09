/**
 * Deciding whether a tool call has already happened, so a retry does not repeat
 * its side effect.
 *
 * A durable runtime retries. A queue redelivers, a workflow step re-runs, a
 * crashed worker's claim is reclaimed — and the agent loop starts the turn
 * again. If the turn asked a tool to send an email, the retry sends a second
 * one. A *receipt* is the row that lets the second attempt find out.
 *
 * Two things in that are the same for every host and belong here: **what
 * identifies a call**, and **what to do about a receipt you found**. Everything
 * else — the table, the clock, the transaction — is the host's, and this module
 * deliberately owns none of it.
 *
 * ## Identity is content, not position
 *
 * A call is identified by `(tenant, run, tool, arguments)`. The tempting
 * alternative is position — run + turn index + index within the batch — and it
 * is wrong: **a retried turn is a fresh completion.** At any temperature above
 * zero the model may reorder the batch, drop a call, or ask for a different
 * tool at the same index. Position-keyed receipts then match calls that are not
 * the same call, and the failure is the one this module exists to prevent: the
 * first tool's recorded result is replayed as the second tool's, and the tool
 * actually requested never runs.
 *
 * Content keying has the opposite failure mode, which is the safe one. A
 * genuinely new call finds no receipt and executes; a repeated one finds its
 * own. Nondeterminism costs an extra execution of something that was never run
 * before, rather than a skipped execution of something that was.
 *
 * **The tenant is part of the key, not context.** A key without it cannot be
 * partitioned or relocated by tenant, and two tenants' runs are not guaranteed
 * to live in the same database.
 *
 * ## The decision needs a lease, not just a status
 *
 * "Recorded but not completed" does **not** mean "this may have reached the
 * provider." On an at-least-once substrate it is also the ordinary state while
 * another worker is *still running the call* — a queue that reclaims a wedged
 * handler's claim can have two workers on one job by design. Treating that as
 * ambiguous-and-never-repeat blocks the call permanently and needs a human.
 *
 * So the host records a **lease** and an **attempt counter**, and
 * {@link decideToolCallReceipt} distinguishes the three cases a bare status
 * cannot: someone else holds it and is alive (wait), someone else held it and
 * died (reclaim, if the effect can resume), or it finished (replay).
 *
 * Two host obligations this module cannot enforce and a correct implementation
 * needs:
 *
 *  - **Lease times come from the store's clock, not the process's.** Application
 *    clocks drift enough to steal a live lease.
 *  - **Every write gates on the attempt fence** (`status = 'running' AND
 *    attempts = <mine>`), inside the same transaction as the side effect where
 *    the store allows it. Fencing only the completion write leaves the window
 *    where two attempts both believe they own the call.
 *
 * Monad's `agent_side_effect_receipts` is the worked example of all of the
 * above; this module is the part of it that is not Postgres.
 */

/**
 * What identifies a tool call across retries.
 *
 * All four parts are required. Dropping `tenantId` makes the key unpartitionable
 * and, in a multi-database deployment, ambiguous; dropping `toolName` makes any
 * two zero-argument calls in a run identical, and `{}` is the commonest
 * argument bag there is.
 */
export interface ToolCallReceiptKey {
  readonly tenantId: string;
  readonly runId: string;
  readonly toolName: string;
  /** From {@link toolCallArgsHash}. */
  readonly argsHash: string;
}

/**
 * The key as one opaque string, for a store without composite keys (KV, a
 * document id). A host with a composite primary key should use the parts
 * directly and ignore this.
 *
 * Each part is length-prefixed, so no value can impersonate a boundary however
 * many delimiters it contains.
 */
export function toolCallReceiptKeyString(key: ToolCallReceiptKey): string {
  return [key.tenantId, key.runId, key.toolName, key.argsHash]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

/**
 * Serialize a value so that two structurally equal values produce byte-equal
 * strings.
 *
 * `JSON.stringify` does not: it emits object keys in insertion order, so
 * `{a:1,b:2}` and `{b:2,a:1}` — the same arguments, assembled by two code paths
 * or streamed in a different chunk order — serialize differently. A retry then
 * reads "different arguments" and executes a call it should have replayed.
 *
 * Keys are sorted; arrays keep their order, because in an argument bag order is
 * meaning. `undefined` becomes `null` rather than vanishing, so a key whose
 * value is absent cannot be confused with a key that is not there.
 *
 * **A value this cannot represent faithfully throws rather than serializing to
 * something wrong.** `toJSON` is honored exactly as `JSON.stringify` honors it,
 * so a `Date` canonicalizes to its ISO string; but a `Map`, a `Set`, or a class
 * instance keeping its state off the enumerable own keys has no such escape and
 * would otherwise come out as `{}` — colliding with an *empty argument bag* and
 * with every other such value. In a hash that decides whether a write already
 * happened, a silent collision is the one failure worth crashing over. Cycles
 * and excessive depth throw for the same reason, rather than overflowing the
 * stack: a model can author deeply nested arguments, and `JSON.parse` accepts
 * far deeper input than a recursive walk survives.
 *
 * Hash the raw parsed arguments, not the output of a schema parse that coerced
 * types — that is how a `Date` gets in.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>(), 0);
}

/** Depth at which input is refused. Comfortably past any real argument bag, and
 *  far below where a recursive walk overflows. */
const MAX_DEPTH = 200;

function canonicalize(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new TypeError(
      `canonicalJson: value nested deeper than ${MAX_DEPTH} levels. Tool ` +
        `arguments are model-authored, so this is refused rather than walked.`,
    );
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      throw new TypeError("canonicalJson: value contains a cycle.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        // A plain `.map` preserves holes and `join` renders them empty, which
        // emits `[,1]` — not valid JSON. Index explicitly so a hole becomes the
        // `null` that `JSON.stringify` would have produced.
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          items.push(canonicalize(value[i], seen, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        return canonicalize((toJSON as () => unknown).call(value), seen, depth + 1);
      }
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `canonicalJson cannot faithfully serialize ${constructorNameOf(value)}: ` +
            `it is not a plain object and has no toJSON, so it would collapse to ` +
            `an empty object and collide with one.`,
        );
      }
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(
          ([key, nested]) =>
            `${JSON.stringify(key)}:${canonicalize(nested, seen, depth + 1)}`,
        )
        .join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }

  // Everything below would otherwise reach `JSON.stringify` and come back as
  // the string "null" — the same bytes as an explicit `null`, and as each
  // other. `{timeout: NaN}` and `{timeout: null}` fingerprinting alike means a
  // replay skips a write that never happened, which is the failure this module
  // exists to prevent. `undefined` is the one deliberate exception: it maps to
  // `null` so a key whose value is absent stays distinguishable from a key that
  // is not there, and that is worth its collision with an explicit `null`.
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new TypeError(
      `canonicalJson cannot faithfully serialize a ${typeof value}: it has no ` +
        `JSON form and would collapse to null, colliding with an explicit null.`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(
      `canonicalJson cannot faithfully serialize ${String(value)}: JSON has no ` +
        `representation for it, so it would collapse to null and collide with ` +
        `an explicit null. A NaN here usually means a schema coerced a bad ` +
        `value — fingerprint the raw parsed arguments instead.`,
    );
  }
  // `JSON.stringify` returns undefined for a bare `undefined`.
  return JSON.stringify(value) ?? "null";
}

function constructorNameOf(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "a non-plain object";
}

/**
 * Hash the canonical form of a call's arguments. Supplied by the host because
 * the package cannot name a digest: it builds with no DOM and no Node types, so
 * neither `crypto.subtle` nor `node:crypto` is in scope — both are one line away
 * in every runtime that would use this.
 *
 * **Use a full-width cryptographic digest.** The value is compared for equality
 * here, but it is also *persisted*, and its input is tool arguments — routinely
 * a recipient address or a document title. Over a low-entropy input domain an
 * equality-comparable hash of user data is a confirmation oracle for anyone who
 * can read the receipt table, so preimage resistance matters even though this
 * code never inverts it. Truncating to save a column re-introduces collisions
 * in exactly the comparison that decides whether a write already happened.
 *
 * It must also be **stable across process restarts and package versions** — a
 * digest that changes orphans every receipt already stored.
 */
export type DigestFn = (canonical: string) => Promise<string>;

/** Hash a call's arguments into the `argsHash` half of a {@link ToolCallReceiptKey}. */
export async function toolCallArgsHash(
  args: unknown,
  digest: DigestFn,
): Promise<string> {
  return digest(canonicalJson(args));
}

/**
 * A receipt as the host found it. `absent` covers both "never recorded" and
 * "recorded under a different key", which are the same thing to the decision.
 *
 * `leaseExpired` must be computed on the **store's** clock.
 */
export type ReceiptState =
  | { readonly kind: "absent" }
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly attempts: number }
  | {
      readonly kind: "running";
      readonly attempts: number;
      readonly leaseExpired: boolean;
    };

/**
 * Whether an interrupted effect can be safely resumed.
 *
 * `resumable` — the host records each sub-operation as it completes, so a
 * reclaimed attempt skips what already happened. Monad's canvas plans work this
 * way.
 *
 * `opaque` — one indivisible side effect with no record of whether it landed.
 * A reclaimed attempt cannot tell "never sent" from "sent, then crashed", and
 * this module refuses to guess.
 */
export type EffectResumability = "resumable" | "opaque";

/** What to do about the receipt that was found. */
export type ReceiptDecision =
  /** Execute, then complete the receipt under this attempt number. */
  | { readonly kind: "execute"; readonly attempt: number }
  /** Do not execute. The recorded result is this call's result. */
  | { readonly kind: "replay" }
  /**
   * Another attempt holds a live lease. Not a failure — come back. The host
   * chooses the delay; a queue redelivery is the natural one.
   */
  | { readonly kind: "wait"; readonly reason: string }
  /**
   * The effect may or may not have reached the outside world, and nothing can
   * tell. Refuse rather than risk repeating it, and surface it — this is the
   * state a human resolves.
   */
  | { readonly kind: "ambiguous"; readonly reason: string };

/**
 * Decide what a found receipt means. Pure; the host does the reading and the
 * writing, and owns the clock that decided `leaseExpired`.
 *
 * The `running`-with-an-expired-lease case is the one worth understanding. It
 * is **not** automatically ambiguous: on an at-least-once substrate a lease
 * expires whenever a worker dies *or merely stalls*, which is common and
 * recoverable. Whether it is safe to reclaim depends on something only the host
 * knows — whether the effect left a trail. Hence {@link EffectResumability}.
 */
export function decideToolCallReceipt(input: {
  readonly state: ReceiptState;
  readonly effect: EffectResumability;
}): ReceiptDecision {
  const { state, effect } = input;
  switch (state.kind) {
    case "absent":
      return { kind: "execute", attempt: 1 };

    case "completed":
      return { kind: "replay" };

    case "failed":
      // A failed attempt is a finished one: it released its lease and recorded
      // that it did not succeed. Retrying is the point of recording the failure.
      return { kind: "execute", attempt: nextAttempt(state.attempts) };

    case "running":
      if (!state.leaseExpired) {
        return {
          kind: "wait",
          reason:
            "another attempt holds a live lease on this call — it is running, " +
            "not stuck; retry once the lease would have expired",
        };
      }
      return effect === "resumable"
        ? { kind: "execute", attempt: nextAttempt(state.attempts) }
        : {
            kind: "ambiguous",
            reason:
              "an attempt claimed this call and its lease expired without " +
              "completing. The effect is not resumable, so whether it reached " +
              "the outside world cannot be determined — repeating it may " +
              "duplicate it",
          };

    default: {
      const _exhaustive: never = state;
      throw new Error(`unknown receipt state: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function nextAttempt(attempts: number): number {
  // A broken counter must not silently reset the fence to 1 and let two
  // attempts believe they own the call.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `receipt attempts must be a positive integer, got ${String(attempts)}`,
    );
  }
  return attempts + 1;
}
