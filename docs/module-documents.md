# Module documents

This document defines **when an architecture or a large module gets its own file
in `docs/`, what that file must contain, and how its changelog is kept**. Read it
before creating one, and before making a substantial change to a module that
already has one.

A module document is the *durable* reference for one subsystem: what it is, how
it works, and what must stay true about it. It is the opposite of a
[PRD](prds.md), which argues for a change at a point in time and freezes when
that change ships. A PRD says what we decided to build; a module document says
what exists, and it is edited for as long as the module does.

Its last section — [the changelog](#the-changelog) — is the part that matters
most and the part most often skipped. The code says what the module does and the
diff says what changed; **nothing but the changelog says why**. Every rule below
about it exists because that reasoning is the first thing lost and the most
expensive thing to reconstruct.

## When a module document is required

**Create or update a module document in the same change that creates or
substantially edits an architecture, engine, or large module.** Not afterwards,
not in a follow-up PR — the reasoning is perishable, and a documentation debt is
paid at a worse exchange rate every week it is left.

A thing needs its own document when any of these is true:

- It spans more than one file, package, or deployment surface, so no single file
  read top to bottom explains it.
- It owns state, a lifecycle, a protocol, a schedule, or a cache — anything with
  behavior over time that a reader cannot infer from a signature.
- It has invariants an outsider can break. If someone editing an adjacent module
  can violate a rule without their tests failing, that rule needs somewhere to
  live.
- It required a design discussion to build, or its implementation went somewhere
  a competent engineer would not have guessed first.
- You find yourself writing a long comment block explaining *why* rather than
  *what*. That comment is a document trying to be born; write the document and
  leave the comment a pointer.

Rule of thumb: if explaining the change to a reviewer takes more than a
paragraph of context before the diff makes sense, the context belongs in
`docs/`.

### What does not get one

- **A component, a helper, a bug fix, a rename.** Local code that is understood
  by reading it.
- **Anything an existing document already owns.** One module, one owner: extend
  [`agent-harness.md`](agent-harness.md) rather than adding a second document
  about the harness. Fragmenting an area across two files means neither is
  trusted, and the changelog for that area stops being a single record. Split a
  document only when it has grown a genuinely separate subsystem inside it, and
  say so in both files.
- **A point-in-time proposal.** That is a [PRD](prds.md).
- **A house specification or a process guide.** [`prds.md`](prds.md),
  [`pull-requests.md`](pull-requests.md), [`dev-environment.md`](dev-environment.md),
  [`sandbox.md`](sandbox.md), [`e2e.md`](e2e.md), and this document describe how
  we work rather than a subsystem of the running product. They live in `docs/`
  and are registered like everything else, but they are not module documents and
  carry no changelog.

## Where it lives and what it is called

One module, one file, directly in `docs/`:

```
docs/<lower-kebab-name>.md
```

Named for the subsystem the way the team says it aloud — `composer-drafts.md`,
`agent-memory.md` — so a person searching for it guesses the filename.
Every document in the folder now follows it; the `SCREAMING_SNAKE_CASE` names
that predated the convention were renamed in one pass, with every inbound
reference in `docs/`, the repository root, the workflows, and the source updated
in the same change. `README.md` keeps its conventional name.

Three migration files mention a document in a comment and were deliberately left
naming the old path. The rule being applied is that **a deployed migration file is
not edited at all** — not the narrower invariant in
[`data-model.md`](data-model.md#invariants), which is about schema divergence and
which a comment could not cause. The bright line is worth more than the exception
would save: "no edits" is checkable at a glance, while "no edits that change
behavior" invites a judgement call about what counts, on the one class of file
where being wrong is expensive. A stale comment is the accepted cost.

**Register it in [the documentation index](README.md)** in the same change, in
the table that matches its area, with a scope line saying what to read and update
it for. The index is the one registry that has to stay complete: an unregistered
document is one nobody finds and therefore one nobody updates.

## The sections of a module document

A module document opens with an H1 title and one or two orienting paragraphs
under no heading — what the module is, what promise it makes to the rest of the
system, and what a reader who arrived from a search result needs to know before
the first `##`. No creation date, no owner: dates on a living document mislead,
and an owner line is stale the day someone changes teams. The commit history
knows who wrote it.

Then Markdown `##` headings. Seven are **required**: the six below, in this
order, and the **Changelog**, which always sits last. Optional sections go
between them, in the order given below, and are omitted entirely — no empty
headings — when they do not apply. A required section with genuinely nothing to
say keeps its heading and gets `N/A — <reason>`, so a reader knows the question
was asked rather than skipped.

### Required sections

1. **Where the code lives** — The map from this document to the source: the
   entry points, and the one place each shared decision is made. A small table of
   path → responsibility beats prose. Name the file that is the single source of
   a thing (`lib/draft-keys.ts` builds every cache key) so the next person
   extends it instead of building a second one.

2. **How it works** — The mechanism, in the order a reader needs it rather than
   the order the code is laid out in: what triggers it, what it does, what it
   writes, what happens next. `###` subheadings when it genuinely has parts.
   Present tense, describing the system as it is today.

3. **Invariants** — The rules that must hold, each stated with **the consequence
   of breaking it**. "The draft's text and its attachments share one key, so the
   two halves of a composer can never drift apart" is an invariant; "keys are
   built in `draft-keys.ts`" is trivia. This is the section a future change is
   checked against, so write it for someone who is about to do something you did
   not anticipate. Where an invariant has a guard, name it, and the guard is one
   of: a lint rule, a type, a runnable test that exercises the behavior, or the
   words "verified visually, no automated guard". A test that reads a source
   file, a stylesheet, or a config file off disk and asserts on its text is not
   a guard and must not be cited as one; the rule and the alternatives are in
   [`testing.md`](testing.md#what-to-test-and-what-not-to).

4. **Boundary** — What this module owns, what it exposes to callers, what it
   depends on, and who is allowed to call it. Include what it deliberately does
   **not** do, with a pointer to whichever document owns that instead. Half of
   all subsystem confusion is two modules each assuming the other handles
   something.

5. **Failure modes and limits** — What happens when a dependency is unavailable,
   a quota is exhausted, a payload is malformed, or a race is lost: what the user
   sees, what is retried, what is silently dropped, and what the numeric limits
   are (TTLs, sizes, counts, timeouts). This section answers the question that
   otherwise gets asked as a bug report — *is this behavior deliberate?*

6. **Testing** — Which suites cover the module and how to run them, the fixtures
   or fakes involved, and the traps. If a test of this module needs setup that is
   not obvious — a store cleared in `beforeEach`, a clock stubbed, a global that
   must not be reset — say so here; that is how the next person avoids writing a
   [flaky test](../AGENTS.md#flaky-tests).

7. **Changelog** — Required, and always the last section. See
   [The changelog](#the-changelog).

### Optional sections

Include these when they apply, between **Testing** and **Changelog**:

- **Data model** — The tables and columns the module owns and how rows are
  keyed. The migrations and [`data-model.md`](data-model.md) stay authoritative;
  this is the module's view of them.
- **Regional impact** — What differs between configured deployments, what
  crosses the boundary, and where data comes to rest. **Required in spirit** for
  anything touching identity, the Global registry, cross-region bridges, provider
  ingress routing, or residency; read [`regionalization.md`](regionalization.md)
  first.
- **Security and trust model** — The trust surface the module sits on: what it
  treats as untrusted, which credentials it can reach, what it validates.
  **Required in spirit** whenever the module touches any of the boundaries in
  [`security.md`](security.md).
- **Operations** — What to look at when it misbehaves in production: the logs,
  the queries, the dashboards, the manual recovery. Deep procedures belong in
  [`runbook.md`](runbook.md); link rather than duplicate.
- **Performance and cost** — The budget the design is built to, and the
  measurement behind it, where a later change could quietly blow it.
- **Open questions** — What is genuinely undecided and what each answer would
  change. Delete each one as it is resolved; the resolution becomes a changelog
  entry.

### Conventions

- Present tense, describing the system as it is. A module document is not a
  narrative of how it got here — that is what the changelog is for, and a body
  written as history ("we used to poll, then we…") has stopped being a reference.
- Real names for files, tables, flags, tools, and surfaces, so a reader can go
  find them.
- Explain the reasoning inline where a design looks arbitrary. One clause of
  *why* next to the *what* prevents more damage than a paragraph elsewhere.
- Length follows the module. Anything longer than the thing it explains is a
  sign the material belongs in a PRD's `design.md`.

### Skeleton

```markdown
# <Module>

<one or two paragraphs: what it is, what it promises, who should read on>

## Where the code lives
## How it works
## Invariants
## Boundary
## Failure modes and limits
## Testing

## Data model               <!-- optional -->
## Regional impact          <!-- optional -->
## Security and trust model <!-- optional -->
## Operations               <!-- optional -->
## Performance and cost     <!-- optional -->
## Open questions           <!-- optional -->

## Changelog                <!-- always last -->
```

## The changelog

**Every module document ends with a running changelog that records not only what
changed, but why it changed.** This is the highest-value section in the file, and
the reason this specification exists.

The situation it is built for: someone — a person or a model — is about to change
this module a year from now. They can read the code, so they know what it does.
They can read the diff, so they know what moved. What they cannot recover is the
pressure that produced the design: the failure that made the obvious approach
untenable, the alternative that was tried and abandoned, the constraint that is
invisible from inside this file. Without it they will "clean up" the odd-looking
thing, ship the simplification that was already rejected once, and rediscover the
outage that motivated it. The changelog is how the reasoning survives the people
who held it.

Write every entry for that reader. They do not have the ticket, the pull request,
the thread, or you.

### The shape of an entry

Entries are `###` headings under `## Changelog`, **newest first**, each with a
date and a one-line claim, then these fields:

```markdown
## Changelog

### 2026-08-19 — Drafts expire lazily at read time, not on a schedule

**What changed:** A cached draft whose TTL has passed is ignored when it is read
and deleted by the next composer that mounts. The scheduled sweep is gone.

**Why:** The sweep was a Workflow plus a cron trigger, and it existed to save a
timestamp comparison in a query that already loads the row. It also produced the
only class of bug we saw here in three months: a draft that vanished while its
owner was typing, because the sweep and the debounced save raced. Read-time
expiry cannot drift from the data it is checking.

**Considered and rejected:** Keeping the sweep and taking a lock around the save.
That is a distributed lock for a device-local cache, and it makes every keystroke
path depend on a Workflow being healthy.

**Consequences:** Expired rows now occupy quota until something reads them, which
is bounded by the 12-hour TTL and has never been close to a device limit. Any
future code that reads the store directly must filter on `updatedAt` itself —
`pruneExpiredDrafts` is no longer the only place expiry is enforced.

Shipped in #412. Design: `docs/PRDs/2026-08-10_composer-drafts/prd.md`.
```

- **What changed** — One or two sentences in the module's own vocabulary.
  Behavior, not a file list: filenames get renamed out from under an entry, and a
  reader who wants the diff has the pull request link.
- **Why** — **The required field, and the one to spend your effort on.** State
  the pressure that forced the change: the failure someone hit, how often, what
  it cost, what was measured, what constraint appeared. It must stand on its own
  after the ticket, the thread, and the author are gone. "Refactor", "cleanup",
  "simplification", and "as discussed" are not whys — they are the absence of
  one. If the change was made because the previous design was wrong, say what was
  wrong with it, plainly and without hedging.
- **Considered and rejected** — The road not taken, and why it did not survive.
  Required whenever a real alternative existed, because the rejected option is
  precisely what the next person will propose. Omit it only when there genuinely
  was no fork in the road.
- **Consequences** — What this constrains going forward: what a future change
  must respect, what got worse and was accepted, what to watch. This is what
  turns the entry from history into guidance.

Close with a trailer naming the pull request, and the PRD or issue where one
exists. One line, no heading.

The entry is written and committed before the pull request exists, so its number
is not knowable at the time. Write the four fields on the branch, and land the
link once the pull request is open — by amending before the push or in the next
commit on the same branch. The entry stays open for revision until the pull
request merges (see [Rules](#rules)); after that, **correcting the trailer is the
one edit the frozen entry permits** — it is about finding the change, not about
restating why it was made, which is the same carve-out
[`prds.md`](prds.md#completed-prds-are-frozen) makes for a frozen PRD.

### What earns an entry

Not every commit, and not most of them. The test: **would a competent engineer,
seeing this code fresh, plausibly undo it — and be wrong to?** If yes, write the
entry. If the diff explains itself, do not.

The bar is deliberately high, because this section only works while it is short.
A reader who stops after three entries should have read the three that matter
most, and every entry that records a small thing pushes a large one further down.
When the changelogs were consolidated in September 2026, roughly one entry in ten
recorded a change the diff already explained, and one in ten recorded a commit
that another entry in the same document already covered. The rules below exist
to stop both.

Always worth an entry:

- A design or mechanism replaced, or an approach abandoned after it was tried.
- A new invariant, or an old one removed or relaxed.
- A boundary moving — the module taking on something, or handing something off.
- A limit, TTL, or budget changed, with the number and what it is derived from.
- A deliberate trade-off, especially one that leaves a rough edge in place
  because the alternative was worse.
- Scope cut. Work that was planned and quietly did not happen is the single most
  common thing this section exists to catch. Record what would have to be true to
  pick it back up.
- A fix for a production incident, with what actually broke.

Never worth an entry, however large the diff:

- **A rename**, unless it leaves a compatibility constraint behind — an export
  kept for an old caller, a stored key still read, a Durable Object class that
  cannot be swapped without losing its objects. The entry is then about the
  constraint, not the name.
- **A typo, wording, or formatting change**, or a cosmetic restyle that changes
  no behavior.
- **A dependency bump or tooling change**, unless it narrowed a contract the
  module relies on.
- **A test-only or CI-only change.** What a suite covers is recorded in
  **Testing**; adding one is not a decision about the module.
- **Documentation-only work**: a body catching up with the code, a clarification,
  a correction to an earlier entry's wording. Fix the body; do not log that you
  fixed it.
- **Rebase and merge bookkeeping**: a migration renumbered after a collision, a
  file restored, a heading repaired.
- **A bug fix that changes no invariant** and had no production incident behind
  it. The pull request holds it.
- **A "review fixes" list.** Review changes the entry for the change under
  review; it does not get an entry of its own.

Two tests catch the rest. If **Why** would say nothing that **What changed** did
not already say, there is no entry. If **Consequences** would say that nothing
changes for anyone touching the module next, there is no entry.

### Granularity

- **One entry per pull request per document.** A pull request that makes several
  changes to one module writes one entry with several paragraphs, not several
  entries. The changelog records decisions, and a pull request is the unit a
  decision ships in; commits and review rounds are how it got written, and the
  record does not need to show the seams.
- **A cross-cutting change has one owning document.** The full entry goes in the
  document that owns the mechanism that changed. Every other document the change
  touched updates its body, and gets an entry only if the change moved *that*
  module's boundary or invariants — a short one, pointing at the owner's entry
  for the reasoning. A dozen copies of the same paragraph is not a dozen records.
- **The four fields are required.** An entry that cannot fill them is a pull
  request description, and that is where it belongs.

### Rules

- **Append in the same change that makes it true.** A changelog written at the
  end of the build is a changelog written from memory, and the *why* is the part
  memory loses first.
- **Newest first.** The entries that explain today's code sit at the top, so a
  reader who stops after three has read the three most likely to matter.
- **Open until merge, frozen after.** While the pull request is open, its entry
  is revised freely: a review finding changes the entry for the change it found,
  a later commit on the same branch extends it, and the trailer is filled in when
  the number exists. Once the pull request merges, never rewrite or delete the
  entry, and never edit it to agree with a newer decision. An entry that turned
  out to be wrong is still the true record of what was believed, and knowing that
  a design was tried and failed is worth as much as knowing what replaced it. The
  trailer is the sole exception after merge, and only to fill in a link that
  could not exist yet — see [The shape of an entry](#the-shape-of-an-entry).
- **A reversal is a new entry**, dated the day it was reversed, naming the entry
  it overturns and saying why the first answer did not hold.
- **Never invent a why.** When you change a module whose reasoning you do not
  know, record your own reasoning and say plainly what you inherited: "the
  previous behavior's motivation is not recorded". A guessed rationale is worse
  than a missing one, because the next reader cannot tell it from a real one.
- **Keep the body current in the same change.** The body says what is true now;
  the changelog says why it became true. Neither substitutes for the other — a
  body left stale on the grounds that "the changelog covers it" makes a reader
  reconstruct the present from history.
- **Length follows consequence.** Three lines for a limit change, a dozen for a
  design replaced. If an entry outgrows the section it explains, the argument
  belongs in a PRD and the entry links to it.
- **Consolidation is a deliberate pass, not a habit.** The changelogs were
  consolidated once, in September 2026, to the granularity above: entries one
  commit had split across several headings were merged, and entries that failed
  the test above were dropped. An entry that `git log` shows and the document
  does not went in that pass. Do not repeat it piecemeal; if the rules drift
  again, fix the rules and run one pass.

### Starting one

When you create a module document, the changelog starts with one entry dated that
day, explaining **why the module exists at all** — the problem it was built for
and the shape it was given. That entry is the one every later reader starts from.

When you add a document to a module that already exists, the first entry says so
and starts from the present:

```markdown
## Changelog

### 2026-08-11 — Document created

**What changed:** Nothing in the code. This document describes the module as it
stands today.

**Why:** The module was built across four pull requests with no durable
description, and its expiry behavior had been re-litigated twice from scratch.

**Consequences:** Changes from here carry an entry. The reasoning behind
decisions taken before this date is not recorded and was not reconstructed —
`git log` and the linked PRDs are what exist.
```

A document that predates this rule takes a third path, and it is the one most of
`docs/` will take: the document already exists and is registered, and it grows
its `## Changelog` section on the next substantial change to the module. There,
the first entry **is** that change, written in full, and its **Consequences**
field says that the reasoning behind everything before it is not recorded and was
not reconstructed. Do not open with a `Document created` entry for a document
that was not created that day, and do not mine `git log` for motivations to
back-fill — a reconstructed why is the one thing this section must not contain.
The record starts where the record starts.

### What belongs somewhere else

| The thing you are writing | Where it goes |
| --- | --- |
| Why this module changed, and what that constrains | The module document's changelog. |
| What the module is and how it behaves now | The module document's body. |
| A proposal for a change not yet built | A [PRD](prds.md) under `docs/PRDs/`. |
| A decision that moved a PRD's goals or scope while it was being built | That PRD's [decision log](prds.md#the-decision-log), which freezes when the PRD completes. The module document's changelog carries the durable consequence. |
| A low-level ambiguity resolved without changing the product contract | [`assumptions.md`](assumptions.md). |
| A purely internal choice with no consequence for anyone changing the module | The pull request description. |

## Working with one

**Creating a module:**

1. Create `docs/<lower-kebab-name>.md` with the title, the orienting paragraphs,
   the six required sections, and the `## Changelog` heading beneath them.
2. Register it in [the documentation index](README.md), in the table matching its
   area, with a scope line.
3. Write the first changelog entry: why the module exists, what was rejected on
   the way to this shape.
4. Name the document in the pull request's **Related or new documentation**
   section, per [`pull-requests.md`](pull-requests.md).

**Changing a module that has a document:** update the body so it describes the
new behavior, and append a changelog entry — both in the same change as the code.
A pull request that changes a documented module's behavior and touches neither is
incomplete, and a reviewer should say so.

**Changing a module that has no document:** if the change is substantial by the
threshold above, write the document as part of it. Describe the whole module as
it now stands, not just the part your diff touched — a document that only covers
the most recent change is a changelog with no reference beside it. Do not
reconstruct history you were not there for; start the changelog from the present
as shown above.

## Relationship to the rest of `docs/`

- [`README.md`](README.md) is the registry. Every module document appears there;
  nothing else registers documents, and the root [`README.md`](../README.md)
  deliberately lists none.
- [`prds.md`](prds.md) covers the point-in-time proposals. When a PRD ships, the
  behavior it introduced is described in the module document that owns the area —
  a PRD is never the durable reference, and a module document may cite one for
  the reasoning behind a decision.
- [`pull-requests.md`](pull-requests.md) governs the description that carries the
  change. The PR explains the change to a reviewer today; the module document
  explains the module to a stranger in a year. The overlap is intentional and
  they are written for different readers.
- [`architecture.md`](architecture.md) stays the map of how the surfaces fit
  together. A new module is added to that map and documented in its own file;
  the map does not absorb it.
