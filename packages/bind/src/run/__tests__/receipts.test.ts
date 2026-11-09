import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  decideToolCallReceipt,
  toolCallArgsHash,
  toolCallReceiptKeyString,
  type DigestFn,
  type ReceiptState,
} from "../receipts";

// The identity, so tests assert on WHAT is hashed rather than on a hash. The
// real digest is the host's (see `DigestFn`).
const identityDigest: DigestFn = async (canonical) => canonical;

describe("toolCallReceiptKeyString", () => {
  const key = {
    tenantId: "ten_a",
    runId: "run_b",
    toolName: "send_email",
    argsHash: "abc",
  };

  test("is stable and distinguishes every part", () => {
    expect(toolCallReceiptKeyString(key)).toBe(toolCallReceiptKeyString(key));
    for (const part of ["tenantId", "runId", "toolName", "argsHash"] as const) {
      expect(toolCallReceiptKeyString({ ...key, [part]: "other" })).not.toBe(
        toolCallReceiptKeyString(key),
      );
    }
  });

  test("a part containing the delimiters cannot impersonate a boundary", () => {
    // Length-prefixing is why. Naive joining would let a crafted tool name or
    // run id collide with a different call's key.
    const forged = toolCallReceiptKeyString({
      tenantId: "ten_a",
      runId: "run_b|10:send_email",
      toolName: "x",
      argsHash: "abc",
    });
    expect(forged).not.toBe(toolCallReceiptKeyString(key));
  });
});

describe("canonicalJson", () => {
  // The whole reason this exists: JSON.stringify emits keys in insertion
  // order, so the same arguments assembled by two code paths hash differently
  // and a retry executes a call it should have replayed.
  test("key order does not change the output", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(JSON.stringify({ a: 1, b: 2 })).not.toBe(JSON.stringify({ b: 2, a: 1 }));
  });

  test("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  test("array order is preserved — in an argument bag, order is meaning", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  // Pinned because a non-JS host reimplementing this must match byte for byte,
  // and UTF-16 code-unit order is NOT code-point order: the emoji (a surrogate
  // pair) sorts before the fullwidth A, and "Z" sorts before "a".
  test("keys sort in UTF-16 code-unit order", () => {
    expect(canonicalJson({ "😀": 1, "Ａ": 2, "é": 3, Z: 4, a: 5 })).toBe(
      '{"Z":4,"a":5,"é":3,"😀":1,"Ａ":2}',
    );
  });

  test("undefined becomes null rather than vanishing", () => {
    // The one deliberate collision: `{a: undefined}` and `{a: null}` match.
    // Worth it so a key whose value is absent stays distinct from a key that is
    // not there, which is the commoner confusion.
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
    expect(canonicalJson({ a: undefined })).not.toBe(canonicalJson({}));
    expect(canonicalJson(undefined)).toBe("null");
  });

  test("scalars and null round-trip", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
  });

  test("distinguishes shapes that stringify similarly", () => {
    expect(canonicalJson({ a: [1] })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([])).not.toBe(canonicalJson({}));
  });

  test("a Date serializes through toJSON, not to an empty object", () => {
    // A Date has no enumerable own keys, so reading it as a plain record gave
    // "{}" — byte-identical to an EMPTY ARGUMENT BAG, and to every other Date.
    const when = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalJson(when)).toBe('"2026-01-01T00:00:00.000Z"');
    expect(canonicalJson(when)).not.toBe(canonicalJson({}));
    expect(canonicalJson(new Date(0))).not.toBe(canonicalJson(new Date(1)));
  });

  // Everything below would collapse to a value it is not, and a collision here
  // reads as "same call" and skips a write that never happened.
  test("a non-plain object throws instead of collapsing to {}", () => {
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(/serialize Map/);
    expect(() => canonicalJson(new Set([1]))).toThrow(/serialize Set/);
    expect(() => canonicalJson({ nested: new Map() })).toThrow(/serialize Map/);
  });

  test("a value with no JSON form throws instead of collapsing to null", () => {
    // `{timeout: NaN}` and `{timeout: null}` hashing alike is the same class of
    // bug as the Date one — and NaN arrives exactly the documented way, from a
    // schema coercing a bad string.
    expect(() => canonicalJson({ t: NaN })).toThrow(/serialize NaN/);
    expect(() => canonicalJson({ t: Infinity })).toThrow(/serialize Infinity/);
    expect(() => canonicalJson({ t: -Infinity })).toThrow(/serialize -Infinity/);
    expect(() => canonicalJson({ cb: () => 1 })).toThrow(/serialize a function/);
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow(/serialize a symbol/);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(/serialize a bigint/);
  });

  test("a cycle throws a named error rather than overflowing the stack", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/contains a cycle/);
  });

  test("a repeated (but acyclic) reference is not mistaken for a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test("excessive depth is refused, not walked", () => {
    // Model-authored arguments: JSON.parse accepts far deeper input than a
    // recursive walk survives, so the walk must refuse before the stack does.
    let deep: unknown = 1;
    for (let i = 0; i < 5_000; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nested deeper than/);
  });

  test("a sparse array serializes its holes as null, not as invalid JSON", () => {
    const sparse = new Array<number>(2);
    sparse[1] = 1;
    expect(canonicalJson(sparse)).toBe("[null,1]");
  });

  test("a null-prototype bag is still a plain bag", () => {
    const bag = Object.assign(Object.create(null) as Record<string, unknown>, {
      b: 2,
      a: 1,
    });
    expect(canonicalJson(bag)).toBe('{"a":1,"b":2}');
  });
});

describe("toolCallArgsHash", () => {
  test("equal arguments hash equally regardless of key order", async () => {
    const left = await toolCallArgsHash({ path: "/a", mode: "r" }, identityDigest);
    const right = await toolCallArgsHash({ mode: "r", path: "/a" }, identityDigest);
    expect(left).toBe(right);
  });

  test("different arguments hash differently", async () => {
    expect(await toolCallArgsHash({ path: "/a" }, identityDigest)).not.toBe(
      await toolCallArgsHash({ path: "/b" }, identityDigest),
    );
  });

  test("the hash IS the digest's return value, not the canonical string", async () => {
    // With an identity digest the two are indistinguishable, so an
    // implementation that dropped the digest and returned the canonical form —
    // storing the raw argument bag in every receipt row — would pass every
    // other test in this file.
    const tagged: DigestFn = async (c) => `H:${c}`;
    expect(await toolCallArgsHash({ a: 1 }, tagged)).toBe('H:{"a":1}');
  });

  test("a rejecting digest propagates rather than being swallowed", async () => {
    const failing: DigestFn = async () => {
      throw new Error("no crypto");
    };
    await expect(toolCallArgsHash({ a: 1 }, failing)).rejects.toThrow("no crypto");
  });
});

describe("decideToolCallReceipt", () => {
  const decide = (state: ReceiptState, effect: "resumable" | "opaque" = "opaque") =>
    decideToolCallReceipt({ state, effect });

  test("no receipt means execute as the first attempt", () => {
    expect(decide({ kind: "absent" })).toEqual({ kind: "execute", attempt: 1 });
  });

  test("a completed receipt replays and never executes", () => {
    expect(decide({ kind: "completed" })).toEqual({ kind: "replay" });
  });

  test("a failed attempt is finished, so the next one executes", () => {
    // It released its lease and recorded that it did not succeed. Retrying is
    // the point of having recorded the failure.
    expect(decide({ kind: "failed", attempts: 2 })).toEqual({
      kind: "execute",
      attempt: 3,
    });
  });

  // The case a bare status cannot distinguish, and the reason the lease exists.
  test("a LIVE lease means wait — another attempt is running, not stuck", () => {
    expect(decide({ kind: "running", attempts: 1, leaseExpired: false }).kind).toBe(
      "wait",
    );
  });

  test("an EXPIRED lease on a resumable effect reclaims and re-executes", () => {
    // On an at-least-once substrate a lease expires whenever a worker dies or
    // merely stalls. Treating that as permanently ambiguous would block the
    // call and need a human.
    expect(
      decideToolCallReceipt({
        state: { kind: "running", attempts: 1, leaseExpired: true },
        effect: "resumable",
      }),
    ).toEqual({ kind: "execute", attempt: 2 });
  });

  test("an EXPIRED lease on an opaque effect is ambiguous, not a silent retry", () => {
    expect(
      decideToolCallReceipt({
        state: { kind: "running", attempts: 1, leaseExpired: true },
        effect: "opaque",
      }).kind,
    ).toBe("ambiguous");
  });

  test("the attempt fence never resets to 1 on a broken counter", () => {
    // Two attempts both believing they own the call is exactly what the fence
    // prevents, so a nonsense count refuses rather than restarting the count.
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => decide({ kind: "failed", attempts })).toThrow(TypeError);
      expect(() =>
        decide({ kind: "running", attempts, leaseExpired: true }, "resumable"),
      ).toThrow(TypeError);
    }
  });

  test("every reason is identifier-free", () => {
    // These strings surface to operators and, on some hosts, to members.
    const reasons = [
      decide({ kind: "running", attempts: 1, leaseExpired: false }),
      decide({ kind: "running", attempts: 1, leaseExpired: true }),
    ].flatMap((d) => ("reason" in d ? [d.reason] : []));
    expect(reasons).toHaveLength(2);
    for (const reason of reasons) {
      expect(reason).not.toMatch(/(?<![A-Za-z0-9])[a-z]{2,6}_[A-Za-z0-9]{4,}/);
    }
  });
});
