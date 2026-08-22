# Adding security and defensive limits

Use this checklist whenever you add a bound whose job is to stop something: a
maximum payload size, an item or depth cap, a retry ceiling, a concurrency cap, a
timeout, a cooldown, a quarantine window. **You define the limit. You do not pick
its number.** Read this before writing a constant that exists to contain abuse,
runaway cost, or blast radius.

The number is not an implementation detail. It decides which abuse we accept,
which cost we agree to pay, and which real user gets cut off on a bad day — and
Avalon has no load history, no metrics stack, and no capacity model to appeal to
([`AGENTS.md`](../AGENTS.md#where-we-are),
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#deciding-without-measurement)).
A defensive number invented by whoever happened to be writing the guard is a
guess that outlives its author, hardens into an invariant, and is then defended
by people who cannot date it. So the guess is not made here. What this change
owes is the *mechanism*: named, wired, enforced, tested, and one edit away from
being real.

## The rule

1. **Define the limit fully** — its name, its single definition site, where it is
   enforced, and what a caller sees when it trips.
2. **Set it to the open value** — the value at which the guard changes nothing —
   and leave it there for the whole change.
3. **Hand every limit you opened back to the team** in the report at the end of
   the change, with the arithmetic they need to choose a number.

A real number reaches the branch in exactly three ways, and no others:

- the person asking for the work named it;
- you asked for it and were answered — see
  [When to ask before you finish](#when-to-ask-before-you-finish);
- it is transcribed from a published platform or protocol limit, with the source
  and the date in a comment beside it. That is not your choice, so it is not a
  guess.

## What this covers

| Kind of number | Example | Who picks it |
| --- | --- | --- |
| **Defensive or security limit** — exists to contain what a caller, a provider, or a runaway loop could otherwise do | bytes of one tool result held in memory, retries before a run gives up, sockets a room will hold | Nobody yet. Open placeholder, this document. |
| **Product limit** — part of what the product *means*, visible in the interface or a PRD | the four suggestions on the home screen, the 80%-of-window compaction trigger | The product contract. Set it, and cite the PRD. |
| **Platform or protocol limit** — published by Cloudflare, a provider, or a spec | a Durable Object value size, a provider's page size, a queue's batch ceiling | The platform. Transcribe it with a citation. |
| **Not a quantity at all** — an authorization check, a scope, a CSP directive, an allowlist entry | who may call a route, which origin is admitted | Nobody, ever, provisionally. See below. |

**A security control that is not a number is never placeholdered.** Do not write
a disabled check, an empty allowlist that means "allow", a permissive default, or
a `TODO` where a permission belongs, and call any of it a placeholder. The open
value in this document is inert *because it restores the behavior that already
ships*; a disabled check is a hole that did not exist before. If you cannot
decide one of those, ask before writing the code.

When a number both shapes the product and defends it, it is a product limit: the
PRD wins, you set it, and the comment says the bound is doing double duty.

## The open value

The open value is **the value at which the code behaves exactly as if the guard
were not there**. Derive it by asking that question at the enforcement site, not
by reading the constant's name.

| Shape of the limit | Open value |
| --- | --- |
| Upper bound — max bytes, items, depth, retries, concurrency, connections | `Number.POSITIVE_INFINITY` |
| Lower bound — a floor a value must stay above | `Number.NEGATIVE_INFINITY` |
| A required minimum — minimum length, minimum count before an action is allowed | `0` |
| A wait — cooldown, debounce, backoff floor, quarantine, minimum interval | `0` |
| A timeout or deadline | `Number.POSITIVE_INFINITY`, enforced through a finiteness guard — see [Make the open value inert](#make-the-open-value-inert) |

Note what the table does *not* say: an open retry cap is `+Infinity`, never `0`.
Zero retries is a strict limit wearing an innocent value, and it would ship as a
behavior change nobody approved. Test every choice against the definition above
rather than pattern-matching on "small number, therefore safe".

If no value of the constant makes the guard inert — a bucket count, a shard
count, a fan-out width, anything where every value is a real decision — then it
is not a limit in this sense and there is nothing to open. Ask for it before you
write the code.

## Make the open value inert

`Number.POSITIVE_INFINITY` is only harmless where it is compared. These sites are
verified inert: `>` and `<` comparisons, `Math.min`, `Array.prototype.slice`, and
Zod's `.max()` on a string or an array.

These are not, and each one is a way to ship a limit that is *tighter* than no
limit at all:

- **Timers.** `setTimeout(fn, Number.POSITIVE_INFINITY)` does not wait forever.
  Node clamps an out-of-range delay to `1`, warns `TimeoutOverflowWarning`, and
  fires almost immediately. The same applies to anything built on a delay,
  including `AbortSignal.timeout`.
- **SQL.** A non-finite value bound into `LIMIT ?` is not a query without a
  limit; it is a query that fails or coerces.
- **Anything serialized.** `JSON.stringify({ a: Infinity })` is `{"a":null}`. An
  open limit must never reach a D1 row, a queue message, a contract payload, a
  Wrangler variable, or a client. **Placeholders live in TypeScript source
  only**; a limit that has to cross the wire is one you must have a value for
  before you write it.

For any site that is not inert under `Infinity`, do not enforce the limit at all
while it is open:

```ts
if (Number.isFinite(MAX_RUN_WALL_CLOCK_MS)) {
  signal = AbortSignal.timeout(MAX_RUN_WALL_CLOCK_MS);
}
```

No timer is created, which is what "no limit" means. Never substitute a large
finite stand-in — `2 ** 31 - 1`, `86_400_000`, "a day is basically forever" — to
dodge the guard. A large finite number is still a number you picked, and it will
be found later as though somebody decided it.

## Writing the placeholder

One exported constant, one definition site, and enforcement that takes the limit
as an argument. That last part is not ceremony: it is what lets a test prove the
trip while the constant is open, and the shape already in the tree —
`readResponseBytes(response, maxBytes)` in
`packages/connectors/src/provider-utils.ts` — is the one to copy.

```ts
/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-and-defensive-limits.md.
 *
 * Bounds: bytes of one hosted-MCP tool result held in memory before it is
 *   returned to the model.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: the call fails with `result_too_large`, the run continues, and the
 *   model is told the result was too large to return.
 * Derive from: the model's context window against the largest result a real
 *   server returns — arithmetic against published numbers, not a benchmark
 *   nobody here can run.
 */
export const MAX_HOSTED_MCP_RESULT_BYTES = Number.POSITIVE_INFINITY;
```

- **`LIMIT UNSET` is a literal marker**, spelled exactly that way. `rg "LIMIT
  UNSET"` is how the report at the end of the change is generated and how anyone
  audits what is still open; a paraphrase is invisible to both.
- **Write `Number.POSITIVE_INFINITY`, not `Infinity`.** It greps, it reads as
  deliberate rather than accidental, and it is symmetric with the negative form.
- **One definition site.** No second copy inline, no `?? 64 * 1024` default at a
  call site, no per-caller override that quietly reintroduces a number. The
  constant is the single edit point, which is the whole reason this works.
- **Export it**, so the open-value test can read it without importing a private.
- The four fields are the handover. `Trips:` in particular is the part a reader
  cannot recover from the code once the value is real.

## Keeping it open

- **Do not set it later in the same change** once the mechanism is working. The
  value looks obvious at exactly the moment you have the least evidence for it.
- **Do not smuggle it in sideways** — a call-site default, a config file, a
  Wrangler variable, a fixture treated as production truth, or a number written
  into a document as though it were decided.
- **Never open a limit that already exists.** This document is about limits that
  do not exist yet. Widening or removing a live bound is a security change in its
  own right: it needs the same approval as setting one, plus a changelog entry in
  the module document that owns it.
- **Check whether a nearby limit already bounds the same resource.** A second
  open constant for something already capped upstream is not caution, it is a
  permanent entry on the report that nobody can act on. Say so instead of adding
  it.

## When to ask before you finish

Shipping open is honest only when the code *without* your guard is what ships
anyway. The test is: **does this change introduce the unbounded path?**

- **No** — the path was already unbounded and you are adding the first guard over
  it. The open placeholder is today's behavior made visible and one edit from
  fixed. Carry it in the report and finish the change.
- **Yes** — a new endpoint, a new fan-out, a new retry loop, a new allocation
  sized by caller input. The open value would be a regression you authored. Stop,
  ask for the number with the arithmetic that frames the choice, and set what you
  are given.

Always ask rather than ship open when the path is reachable without
authentication, allocates memory proportional to untrusted input, or spends money
per iteration. Ask in the way that gets an answer: `AskUserQuestion` mid-session
when someone is there, the pull request description when nobody is.

## The handover report

Every change that opened a limit ends by listing them — in the final message to
whoever asked for the work, and in the pull request's **Security and trust
model** section, with each one also named under **Reviewer notes** as deferred
work ([`pull-requests.md`](pull-requests.md)). Generate the list from the tree, so
nothing is forgotten:

```bash
rg -n "LIMIT UNSET" --glob '!docs/**'
```

| Constant | File | Bounds | Open value | On trip | Derive from | Safe open? |
| --- | --- | --- | --- | --- | --- | --- |
| `MAX_HOSTED_MCP_RESULT_BYTES` | `packages/connectors/src/hosted-mcp.ts` | bytes of one tool result | `+Infinity` | call fails `result_too_large`, run continues | context window ÷ plausible results per run | yes — path was already unbounded |

**Propose a number for each row, and say where it comes from.** A recommendation
is the useful half of the handover; installing it is not yours to do. Frame it as
arithmetic against a published limit the way
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#deciding-without-measurement)
requires — "a 200k-token window at ~4 bytes per token is ~800 KB, so a single
result above ~128 KB cannot be a normal one" — never as a benchmark nobody here
can reproduce. State plainly what stays unprotected until each is set.

## Setting the value once the team answers

1. Replace the value. Delete the `LIMIT UNSET` line. Keep the other fields, and
   replace `Derive from:` with the derivation that was actually used and who
   decided it.
2. Tighten the tests: the enforcement test now runs against the real constant,
   and the open-value test is replaced by one asserting a legitimate payload
   still passes.
3. **Append a changelog entry** to the module document that owns the area — a
   limit change always earns one, "with the number and what it is derived from"
   ([`module-documents.md`](module-documents.md#what-earns-an-entry)). If the
   module has no document, the derivation lives in the constant's comment and the
   pull request description.
4. If the number came from a person rather than an argument, record that: *"set
   by the team; the reasoning is not recorded beyond the value itself"* is a true
   entry, and per
   [`module-documents.md`](module-documents.md#rules) an invented rationale is
   worse than a missing one.

## Verification

Two tests, both required, both held to
[`testing.md`](testing.md)'s prove-it-can-fail rule:

- **The enforcement test** passes a finite limit into the guard directly and
  asserts both the rejection and what the caller sees. This is the test that
  works only because enforcement takes the limit as an argument, and it is the
  reason the placeholder does not mean "untested".
- **The open-value test** asserts that at the constant's current value nothing is
  rejected, delayed, or truncated. It is what catches a placeholder wired into a
  timer, a `LIMIT ?`, or a serialized payload — the failure modes in
  [Make the open value inert](#make-the-open-value-inert).

Never assert on the constant's literal value. A test that pins `+Infinity` fails
the day the team sets the number, which teaches the next person to weaken the
test rather than read it.

Before calling the change done: confirm the `rg "LIMIT UNSET"` count matches the
report exactly, then `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
