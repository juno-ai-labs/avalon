---
slug: internal-changelogs
title: "Internal Changelogs unlock autonomous coding agents."
description: "Internal changelogs give coding agents a long-term memory right next to the code."
author: "Adam Juhasz"
email: "adam@rallywith.ai"
---

The key to enabling a software factory is internal changelogs, which give agents a long-term memory right next to the code. As a primer, LLMs have no "memory" and each turn (let alone coding session) is completely independent. "Memory" is created by passing the entirety of the conversation (the last 24 turns, let's say) or compression/extraction of previous conversations/sessions.

Anthropomorphization of human-like behavior (aka memory) "Don't you see the session last month where we tried that but it failed because of X and Y reasons" doesn't translate to how coding agents behave. This has led to frustrations where autonomous agents have built an already-known bad design or built a feature we removed last month.

The key to coding agent autonomy is having them write an internal changelog [(an example below)](https://github.com/juno-ai-labs/avalon/blob/main/docs/authorization.md#changelog) that documents not only what was changed at a high-level but also why the change was made and any false-starts (this was a great late addition based on some traces we observed). This has cut down on churn between agent sessions and cut down human oversight and monitoring for false starts or incorrect rabbit holes the agent may go down.


```markdown
### 2026-10-21 — Admit attachment and artifact reads once per request

**What changed:** Resource reads reuse HTTP membership evidence, including its
incarnation for migrated grants, and authorize once per read operation...

**Why:** A production image preview spent about one second on its second
authorization RPC after reading R2...

**Considered and rejected:** A cross-request grant cache adds invalidation state
without removing....

**Consequences:** An in-flight read can finish after revocation. Subsequent
requests reauthenticate and observe canonical grant changes...
```

## Difference with skills, code, code comments, and harness memory

Skills (as well as AGENTS.md/CLAUDE.md files) are there to instruct the model on HOW to do something. These are great places to encode code styles, tool usage, environment peculiarities, and other gotchas on how to write code or debug a problem.

Code and code comments describe the WHAT and maybe even the HOW but they don't communicate the WHY. Code history can be used to see changes and progression but (a) it still misses reasoning and context and (b) many models don't naturally look at the git history.

Many platforms are introducing harness level memory but we've found these to be closer to auto-skills than long term product memory.

## Pattern matching with human-native development

How do we pattern match with what we've been doing in (modern) software development for the last 20 years? We've always had tribal knowledge ("Oh talk to Susan about that because I know we did some prototypes around that last year and learnings could be useful") that is never captured in the code or documentation.

## Implementing it yourself

[Our agent instructions are below:](https://github.com/juno-ai-labs/avalon/blob/main/docs/module-documents.md#the-changelog)

````markdown
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
````
