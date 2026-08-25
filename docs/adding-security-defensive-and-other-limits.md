# Adding security, defensive, and other limits

Read this before adding any limit to Rally — a maximum payload size, an item or
depth cap, a retry ceiling, a concurrency cap, a timeout, a cooldown, a
quarantine window, a page size, a threshold. [What this
covers](#what-this-covers) sorts them into four kinds and says who picks each
one's number; most of the document is about the kind nobody has picked yet, the
bound whose job is to stop something.

For that kind the rule is: **you define the limit, and you do not pick its
number.**

The number is not an implementation detail. It decides which abuse we accept,
which cost we agree to pay, and which real user gets cut off on a bad day — and
Rally has no load history, no metrics stack, and no capacity model to appeal to
([`AGENTS.md`](../AGENTS.md#where-we-are),
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#deciding-without-measurement)).
A defensive number invented by whoever happened to be writing the guard is a
guess that outlives its author, hardens into an invariant, and is then defended
by people who cannot date it. So the guess is not made here. What this change
owes is the *mechanism*: named, wired, enforced, tested, and one edit away from
being real.

## The rule

For a security or defensive limit — the first row of the table below:

1. **Justify it, or do not add it** — a limit nobody can say the cost of
   omitting is a limit that should not exist. See
   [Premature limits are not preferred](#premature-limits-are-not-preferred).
2. **Define the limit fully** — its name, its single definition site, where it is
   enforced, and what a caller sees when it trips.
3. **Set it to the open value** — the value at which the guard changes nothing —
   and leave it there for the whole change.
4. **Hand every limit you opened back to the team** in the report at the end of
   the change, with the arithmetic they need to choose a number.

A real number reaches the branch in exactly three ways, and no others:

- the person asking for the work named it;
- you asked for it and were answered — see
  [When to ask before you finish](#when-to-ask-before-you-finish);
- it is transcribed from a published platform or protocol limit, with the source
  and the date in a comment beside it. That is not your choice, so it is not a
  guess.

## What this covers

Sort the number before you write it. Only the first row is this document's
subject; the other three have an owner already, and misfiling one is how a
product decision ends up as an open placeholder or a guess ends up cited as a
platform fact.

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

## Premature limits are not preferred

**The default answer to "should there be a limit here?" is no.** A limit is not
free and it is not neutral. It is a branch to maintain, a rejection to surface, a
test to keep honest, and a number that outlives everyone who understood it — and
its characteristic failure is not letting an attacker through, it is cutting off
a legitimate user on a day nobody was watching, for a threat that never arrived.
Rally builds for the product that exists ([`AGENTS.md`](../AGENTS.md#where-we-are));
that applies to guards as much as to features.

Add one only when you can write down all four of these, in the constant's comment
and in the pull request:

- **What goes wrong without it** — concretely, as cause and effect: a caller
  sends X and the result is Y. A Durable Object out of memory, a run that never
  terminates, a bill that scales with somebody else's input, a provider that
  rate-limits the whole workspace. Not "unbounded input is bad".
- **Who can cause it** — an untrusted caller, a provider response, the model's
  own output, or only our own code. **If only our own code can reach it, a limit
  is usually the wrong tool**: fix the code or write a test, and do not install a
  permanent runtime guard against a bug you could delete.
- **Why nothing already stops it** — name the bound you checked and found
  insufficient: the platform's own request, response, or object limits, the
  provider's page size, a cap already applied upstream in the same path. Most
  candidate limits die here, and that is the section doing its job.
- **What the trip looks like, and why it beats the alternative** — a guard that
  turns a rare slow request into a routine visible error has made the product
  worse, not safer.

If those four do not write themselves, do not add the constant. "Defensive
depth", "just in case", "it looked unbounded", and "a reviewer might ask" are not
justifications; they are how a codebase fills with numbers nobody can change and
nobody dares to raise. **An open placeholder is not a way around this bar** — it
is cheap to add, which is exactly why an unjustified one still costs: it lands on
the handover report, spends somebody's attention, and gets a number attached to
it precisely because it was asked about.

**A worked rejection.** A cap on the bytes of one hosted-MCP tool result looks
like a textbook defensive limit: the caller is a third-party server, the payload
lands in an isolate's memory, and the model is downstream of it. It dies on the
third test. `tools/call` goes through `mcpRequest` to
`readMcpResponse(response, input.maxResponseBytes, …)`; `maxResponseBytes`
resolves to `config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES`; and
`DEFAULT_RESPONSE_BYTES` is `2_000_000` in
`packages/connectors/src/hosted-mcp.ts`. A 40 MB result is already refused with
`payload_too_large`, on both the `content-length` pre-check and the streaming
accumulator in `readResponseBytes`. Adding a second constant there would be a
permanent open row against a resource that is already capped; wiring one into the
existing call site would be [opening a live limit](#keeping-it-open). One grep of
the file the candidate names settles it — which is what that test is for.

Where the bar is already met, do not litigate it — add the guard, open it, and
report it: anything sized by untrusted input and held in memory, any loop with a
model or a provider inside it, anything that spends money per iteration, anything
that fans out per caller.

The two failures are opposite and both real: a guard nobody needed, and an
unbounded path nobody guarded. This section is the bar against the first; the
rest of this document is what happens once a limit clears it.

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
  fires almost immediately; workerd — the runtime these guards actually protect —
  offers no better guarantee, and neither is a contract to lean on. The same
  applies to anything built on a delay, including `AbortSignal.timeout`.
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

One constant holding the number, and enforcement that receives it as an
argument. The second half is not ceremony: it is what lets a test pass a finite
limit and prove the trip while the shipped constant is still open. The shape is
already in the tree — `readResponseBytes(response, maxBytes)` in
`packages/connectors/src/provider-utils.ts`, called with a limit each caller
resolves.

The constant below is **illustrative and is not in the tree**: a guard on a
hypothetical plugin path that reads a body with no size argument of its own. Copy
the shape, not the claim — a `Without it:` line is only true once you have
checked, and the [worked rejection](#premature-limits-are-not-preferred) above is
what that check looks like when it fails.

```ts
/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: bytes of one plugin document held in memory before it is returned to
 *   the model.
 * Without it: a third-party server that returns a 40 MB document fills the
 *   isolate's memory and kills the run for everyone in that work stream. Checked
 *   2026-08-23: this path reads the body with no size argument, and nothing
 *   upstream of it refuses the response first.
 * Direction: upper bound; the open value is +Infinity.
 * Trips: the read fails with `payload_too_large` — the code `readResponseBytes`
 *   already uses — the run continues, and the model is told the document was too
 *   large to return.
 * Derive from: the context window against how many documents one run holds;
 *   arithmetic against published numbers, not a benchmark nobody here can run.
 */
export const MAX_PLUGIN_DOCUMENT_BYTES = Number.POSITIVE_INFINITY;
```

- **`LIMIT UNSET` is a literal marker**, spelled exactly that way. The scoped
  `rg` in [the handover report](#the-handover-report) is how that report is
  generated and how anyone audits what is still open; a paraphrase is invisible
  to both.
- **Write `Number.POSITIVE_INFINITY`, not `Infinity`.** It greps, it reads as
  deliberate rather than accidental, and it is symmetric with the negative form.
- **The number has one definition site.** One constant, and no second literal
  anywhere — no `?? 64 * 1024` at a call site, no copy inline. That constant is
  the single edit point, which is the whole reason this works.
- **Passing the limit through a parameter is not a second site.** The connectors
  idiom — `config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES`, then
  `readResponseBytes(response, maxBytes)` — is one number with a documented
  override, and it is exactly what makes the guard testable while it is open.
  What is forbidden is a *different* number appearing at the call site, not the
  plumbing that carries this one.
- **Export it**, so the open-value test can read it without importing a private.
- The fields are the handover. `Without it:` is the
  [justification](#premature-limits-are-not-preferred) in one place a reviewer
  will actually see, and `Trips:` is the part a reader cannot recover from the
  code once the value is real.

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
| `MAX_PLUGIN_DOCUMENT_BYTES` | `packages/connectors/src/<plugin>.ts` | bytes of one document returned to the model | `+Infinity` | read fails `payload_too_large`, run continues | context window ÷ documents held per run | yes — the path reads the body unbounded today, so the open guard rejects nothing that is not already accepted |

Every row carries its `Without it:` justification into the pull request. A row
that cannot state one does not belong on this table, and the constant behind it
does not belong in the tree — delete it rather than asking somebody to price a
limit nobody needed.

**Propose a number for each row, and say where it comes from.** A recommendation
is the useful half of the handover; installing it is not yours to do. Frame it as
arithmetic against a published limit the way
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#deciding-without-measurement)
requires — never as a benchmark nobody here can reproduce — and **write out every
assumption the sum rests on**, because those, not the total, are what the team is
being asked to confirm:

> The window is 200k tokens at roughly 4 bytes per token, so about 800 KB in
> total. A run holds up to eight of these documents alongside its prompt and its
> output; reserving half the window for those leaves ~400 KB across eight, so
> call it 50 KB each.

A number whose divisor is not shown is the guess this document exists to prevent,
no matter who writes it down: "800 KB of context, therefore 128 KB per result"
skips the two assumptions — how many coexist, how much is reserved — that the
figure entirely depends on. State plainly what stays unprotected until each row
is set.

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

Before calling the change done: confirm that
`rg -n "LIMIT UNSET" --glob '!docs/**'` — the scoped command from
[the handover report](#the-handover-report), counting source markers rather than
this document's own examples — returns exactly the rows you reported, then
`pnpm lint`, `pnpm typecheck`, and `pnpm test`.
