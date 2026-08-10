# Product requirement documents

This document defines **where a product requirement document lives, how its
folder is named, and how its state is recorded**. Read it before writing a PRD,
before advancing one, and before citing one as current guidance.

A PRD here is a *point-in-time* document: it argues for a change, defines its
scope, and records the decisions taken while it was being built. It is not the
durable reference for the subsystem it created — that is the matching document
in [the documentation index](README.md), which is updated alongside the code
long after the PRD is finished.

One PRD is the exception and stays current: [the Avalon implementation
brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md), the standing product
contract for what Avalon *is*. Everything else under `docs/PRDs/` covers one
proposed change and stops being edited once it is complete. The brief predates
this specification and keeps its own shape — it is the contract every later PRD
is written *against*, not an instance of the form below.

## Where a PRD lives

Every PRD is a **folder** under `docs/PRDs/`, named:

```
<yyyy>-<mm>-<dd>_<kebab-case-short-description>
```

For example:

```
docs/PRDs/2026-08-10_workstream-mute-windows/prd.md
```

The date is the date the PRD was **created**, and it never changes — not when
work starts, not when it ships, not when something supersedes it. Nothing else
in the folder name changes either: the path is fixed for the life of the PRD, so
a link to it never rots, and a directory listing sorts into a chronological
record of what the product has proposed.

One folder is one PRD. A change large enough to split into focused parts becomes
several folders that link to each other, not several PRDs in one folder.

## `state.md`

**Where a PRD has got to is recorded in `state.md`, not in the folder name.**
Every PRD folder has one, and it holds exactly this checklist:

```
[ ] planned
[ ] in progress
[ ] completed
```

The boxes are **cumulative** — a PRD that is being built has both `planned` and
`in progress` ticked, because it was planned and it still is. So a PRD under
construction reads:

```
[x] planned
[x] in progress
[ ] completed
```

and a shipped one reads:

```
[x] planned
[x] in progress
[x] completed
```

Advancing a PRD is therefore ticking a box, and nothing else moves. Do it in the
commit that makes it true: `in progress` when the first implementing change
lands, `completed` when the last one does.

`state.md` is the **only** authority on state. Don't restate it in the PRD body,
in the documentation index, or in the folder name — a second copy is a copy that
goes stale.

### Abandoned and superseded PRDs

A PRD replaced by a newer one, or dropped without being built, never reaches
`completed`. Leave its boxes as they stand and add a line beneath the checklist
saying what happened, with a link:

```
[x] planned
[ ] in progress
[ ] completed

Superseded by `../2026-09-02_workstream-notification-rules/`. Design only — no
code shipped. Do not build against this PRD.
```

That line is what stands between a future reader and a design that was
deliberately abandoned, so make it unambiguous. The successor's own PRD should
point back at what it replaced.

## Completed PRDs are frozen

**Once `completed` is ticked, the PRD is not edited again.** It records what was
decided at the time, and its value is that a later reader can trust it to say
what was actually believed and agreed then, rather than a version quietly
reconciled with what shipped afterwards. The same applies to an abandoned PRD
from the moment its `state.md` says so.

If the shipped system drifts from a completed PRD, the drift is recorded in the
subsystem document that owns the area — not by editing the PRD. If the direction
itself changes, write a new PRD.

Two edits are still allowed on a frozen PRD, because they are about *finding* it
rather than about its content: adding or correcting the note in `state.md`
(including links to whatever replaced it), and fixing a link that broke when
another document moved.

[The implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) is
the exception to all of this. Its boxes are ticked because the product it
describes was built, not because the document is finished: it is the standing
contract, and it is edited whenever the contract itself changes.

## Files inside the folder

| File | Purpose |
| --- | --- |
| `prd.md` | **Required.** The PRD itself: the problem, the goals and non-goals, the proposed product behavior, and the decisions. This is the file other documents link to. |
| `state.md` | **Required.** The three-line state checklist above, plus a note if the PRD was superseded or abandoned. Nothing else. |
| `plan.md` | The phased build checklist for the PRD, with an acceptance gate per phase. Add it when the work is large enough that sequencing matters. |
| `design.md` | Architecture and rationale too detailed for the PRD body — schemas, protocols, migration strategy. |
| `research.md` | Prior art, competitor behavior, or investigation that informed the PRD but is not itself a proposal. |
| `README.md` | Only for a folder that has grown into a bundle: a short map saying which file is actionable and which are supporting provenance. |

Anything else follows the same shape — lower-kebab, `.md`, descriptive of its
role. Split a file out when it is long enough that the PRD body suffers for
carrying it; keep everything in `prd.md` otherwise.

## The PRD header

Every `prd.md` opens with an H1 title and then a blockquote, before any other
prose:

```markdown
# Work-stream mute windows

> Created 2026-08-10.
>
> A participant can silence a busy work stream for a fixed period without
> leaving it. Companion plan: [`plan.md`](./plan.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
```

It carries the creation date, a one-line scope, and links to the companion files
and to the documents a reader needs alongside it. Keep it to what orients a
reader who arrived from a search result.

**No state and no owner in the header.** State lives in `state.md` and nowhere
else; an owner line in a document that outlives the assignment is stale the day
someone changes teams, and the commit history says who wrote it.

## The sections of a PRD

A PRD body is Markdown `##` headings in the order below. The first seven are
**required**; the rest are included when they apply and omitted entirely — no
empty headings — when they do not. A required section with genuinely nothing to
say keeps its heading and gets `N/A — <reason>`, because a reader needs to know
the question was asked and answered rather than skipped.

Sections 1–6 are written before the build and describe the change as it was
agreed. Section 7, the **Decision log**, is the one part that grows while the
PRD is `in progress`.

### Required sections

1. **Summary** — One or two paragraphs stating what changes, for whom, and what
   becomes possible that was not before. Written so that someone who reads only
   this section knows whether the rest concerns them. Lead with the outcome a
   user would notice, not with the mechanism.

2. **Motivation** — The case for making this change *now*: the problem someone
   actually hit, how often, and what it costs to leave it alone. Cite the
   evidence — a support thread, a recurring request, an incident, a measurement.
   A reviewer who was not in the room should finish this section agreeing there
   is a problem, before reading a word about the solution. "It would be nice" is
   not motivation; "every participant in a busy automation stream leaves it, and
   leaving loses their place in the transcript" is.

3. **Goals** — What the change must achieve, as a numbered list of outcomes, not
   tasks. Each one should be specific enough that you could later say plainly
   whether it happened. "Participants can silence a work stream for a fixed
   period without leaving it" is a goal; "add a mute table" is a task.

4. **Non-goals** — What this change explicitly does *not* cover, numbered the
   same way, each with the reason it is out of scope and a note on whether it is
   deferred or rejected outright. This is the highest-value section in the
   document: an unstated non-goal is the thing that gets built anyway, and the
   thing a reviewer argues about for a week. Say what is deliberately left for
   later, and say what the product will never do.

5. **Product behavior** — The proposed experience in enough detail to build
   against: what the user does, what the surface shows, and how it behaves in
   each state — empty, loading, populated, error, and offline. Name the real
   surfaces (the sidebar, the transcript, the composer, the contextual right
   rail) and the real vocabulary (work stream, participant, automation,
   subscription, activity, elicitation), so the PRD and the product use the same
   words. Where behavior is conditional, give the condition. Where a mock or a
   screenshot settles it faster than prose, link the image.

6. **Impact on the product contract** — How the change sits against [the Avalon
   implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md).
   Most PRDs write "none — this refines behavior within the existing contract",
   and that one line is the point: it forces the author to check. If the change
   *does* alter the contract — what a work stream is, whether viewing implies
   participation, what the agent is allowed to do, the absence of channels, a
   global inbox, or global search — say exactly which clause moves and why. That
   is a bigger conversation than the feature, and it belongs at the top of it.

7. **Decision log** — What was decided *after* the PRD was agreed, appended as
   the build proceeds. See below; while the PRD is still `planned` the heading
   sits there reading `None yet.`

### The decision log

Implementation always disagrees with the plan somewhere. A goal turns out to
cost ten times what it looked like, a behavior collides with something the PRD's
author did not know about, a reviewer proposes something better. Those decisions
are the ones a future reader most wants and least often finds — the PRD says
what was intended, the diff says what was built, and nothing says *why they
differ*.

The decision log closes that gap. **Update it in the same change that acts on
the decision**, not at the end of the build when the reasoning has evaporated.

Each entry is a `###` heading with the date and a one-line claim, then three
fixed fields:

```markdown
## Decision log

### 2026-08-19 — Mute windows expire lazily, not on a schedule

**Decided:** A mute row whose `muted_until` has passed is ignored at read time.
No scheduled job sweeps expired rows.

**Why:** The sweep was a Workflow and a cron trigger to save a comparison in a
query that already loads the row. Goal 3 (delivery resumes on its own) holds
either way, and the read-time check cannot drift from the data.

**Changes:** Nothing in the agreed scope. Design decision 2 described a sweep;
this supersedes it. Shipped in #412.
```

- **Append only.** Never rewrite or delete an entry, and never quietly edit
  sections 1–6 to match a later decision. Those sections are the proposal as it
  was agreed; the log is the record of everything that moved afterwards, and a
  reader needs both to understand what happened.
- **A reversal is a new entry**, dated the day it was reversed, naming the entry
  it overturns and why the first answer did not survive.
- **Say what it changes** in the PRD's own terms — a goal narrowed, a non-goal
  promoted into scope, a design decision superseded, or nothing at all. Link the
  pull request that carried it.
- **Cutting scope is a decision.** A goal that quietly does not ship is the
  single most common thing this section exists to catch. Record it, with what
  would have to be true to pick it back up.

What belongs elsewhere:

| Decision | Where it goes |
| --- | --- |
| A product or scope consequence — the PRD's goals, behavior, or contract move | The decision log. |
| A low-level ambiguity resolved without changing the product contract | [`ASSUMPTIONS.md`](ASSUMPTIONS.md), which exists for exactly this. |
| How the shipped system now behaves, durably | The subsystem document that owns the area. The log says *why it changed*; that document says *what it is*. |
| A purely internal implementation choice with no product consequence | The pull request description, under **Key design decisions**. |

The log freezes with the rest of the PRD when `completed` is ticked. Before
ticking it, read back through the log and make sure every durable consequence
has landed in the document that owns the area — after the freeze, the log is
provenance rather than guidance.

### Optional sections

- **Key design decisions** — Decisions taken *while writing the PRD* that a
  reader might otherwise second-guess, numbered, each with its rationale *and*
  the alternative that was rejected. Recording the road not taken is what stops
  the same debate reopening in six months. Decisions taken *after* the PRD was
  agreed go in the decision log instead, which is where a superseded entry here
  gets overturned.
- **Data model** — The tables, columns, and relationships the change implies,
  and whether existing rows need backfilling. Sketch level is fine; the
  authoritative record is the migration and [`DATA_MODEL.md`](DATA_MODEL.md).
- **Regional impact** — What differs between Global and the European Union, what
  crosses the boundary, and where the data comes to rest. **Required in spirit**
  for anything touching identity, the Global registry, cross-region bridges,
  provider ingress routing, or data residency; read
  [`REGIONALIZATION.md`](REGIONALIZATION.md) first.
- **Security and trust model** — The trust surface the change opens or closes:
  renderer isolation, connector credential scope, session and ticket handling,
  webhook signature verification, untrusted model or provider payloads, secrets
  placement. **Required in spirit** whenever the change touches any of those;
  [`SECURITY.md`](SECURITY.md) defines the boundaries.
- **Agent behavior** — What the agent may now do, which typed tools it gains,
  what it is still forbidden, and what a user sees while it works. Required
  whenever the change touches the harness or adds a tool; see
  [`AGENT_HARNESS.md`](AGENT_HARNESS.md).
- **Provider configuration** — Any Slack, GitHub, Linear, Notion, Google,
  Resend, or Cloudflare setting that must change outside the repository, in
  which region, and what breaks if it is not applied before the change ships.
- **Rollout** — Flags, phases, migration or backfill order, and how the change
  is turned off if it goes wrong. Name the flag, per
  [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md).
- **Acceptance** — How anyone can tell the PRD is done: the flows to walk and
  what each must show. Where these become durable checks, they land in
  [`E2E.md`](E2E.md).
- **Open questions** — What is genuinely undecided, and what each answer would
  change. An open question that blocks the build says so. Delete each one as it
  is resolved — resolved questions belong in **Key design decisions**.

### Conventions

- Markdown `##` per section; `###` beneath only when a section genuinely has
  parts. Numbered lists for goals, non-goals, and decisions, so a reviewer can
  cite "non-goal 3" and be understood.
- Present tense for proposed behavior ("a participant mutes a work stream…"),
  not future or conditional. A PRD describes the product it is asking for as
  though it exists.
- Refer to surfaces, tables, tools, and flags by their real names so a reader
  can go find them.
- Length follows the change. A one-surface refinement is a page; a subsystem is
  not. Move anything longer than the argument it supports into `design.md`.

### Skeleton

```markdown
# <Title>

> Created <yyyy-mm-dd>.
>
> <one-line scope, companion links>

## Summary
## Motivation
## Goals
## Non-goals
## Product behavior
## Impact on the product contract
## Decision log              <!-- `None yet.` until the build starts -->

## Key design decisions      <!-- optional -->
## Data model                <!-- optional -->
## Regional impact           <!-- optional -->
## Security and trust model  <!-- optional -->
## Agent behavior            <!-- optional -->
## Provider configuration    <!-- optional -->
## Rollout                   <!-- optional -->
## Acceptance                <!-- optional -->
## Open questions            <!-- optional -->
```

## Relationship to the rest of `docs/`

- **PRDs are not registered individually in [the documentation
  index](README.md).** That index registers the durable documents that own an
  area, and it would churn beyond usefulness with one row per proposal. This
  document is the `docs/PRDs/` tree's only entry in it, the implementation brief
  included; the folder listing is the tree's own index.
- **A PRD does not replace the subsystem document.** When a PRD ships, the
  behavior it introduced is described in the document that owns the area —
  [`ARCHITECTURE.md`](ARCHITECTURE.md), [`DATA_MODEL.md`](DATA_MODEL.md),
  [`CONNECTORS.md`](CONNECTORS.md), and so on — updated in the same change as
  the code, per [the agent rule sheet](../AGENTS.md). If a PRD introduced a
  subsystem that no existing document covers, add `docs/<NAME>.md` and register
  it in the index.
- **A subsystem document may cite a PRD** for the reasoning behind a decision.
  Link to the folder's `prd.md` by its full path; the path is stable for the life
  of the PRD, so such a link does not need revisiting when the PRD advances.
- **[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)** remains the phased
  checklist for the product build as a whole. A PRD's own `plan.md` covers only
  that PRD.
- **A pull request implementing a PRD** links to it from the **Motivation**
  section of its description, per [`pull-requests.md`](pull-requests.md).

## Creating one

1. Pick today's date and a short kebab-case description. Create
   `docs/PRDs/<yyyy>-<mm>-<dd>_<description>/prd.md`.
2. Add `state.md` next to it with the three-line checklist, `planned` ticked.
3. Write the title, then the header blockquote: creation date, a one-line scope,
   companion links.
4. Write the body against [the sections above](#the-sections-of-a-prd) — the
   seven required ones in order, then whichever optional ones apply. Start with
   **Non-goals** if the scope is contested; the rest gets easier once the edges
   are fixed. **Decision log** starts as `None yet.`
5. Split out `plan.md`, `design.md`, or `research.md` if the body is carrying
   material that belongs in one of them.
6. Tick `in progress` in the commit where implementation starts. From here the
   **Decision log** is the live part of the document: append an entry in the same
   change as each decision that moves the scope, the behavior, or the contract.
7. When it ships, tick `completed`, read back through the decision log and make
   sure the subsystem documents describe the shipped behavior, and stop editing
   the PRD.
